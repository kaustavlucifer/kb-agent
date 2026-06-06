import { detectSession } from '../../shared/auth.js';
import { sfGet, soqlIdList, mapWithConcurrency, stripHtml, hasCodeBlocks, hasHeaders, hasTables, hasAltText } from '../../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../../shared/gateway.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, BODY_FETCH_BATCH_SIZE, MAX_BODY_CHARS, SCORING_MODEL } from '../../shared/config.js';
import { SCORING_CRITERIA as CRITERIA, computeDynamicMaxes } from '../../data/scoring_criteria.js';

export async function handleScoreBatch(port, msg) {
  const articles = msg.articles || [];
  if (!articles.length) { port.postMessage({ type: 'done', scored: [] }); return; }

  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No SF session' }); return; }

  const bodyMap = await fetchBodies(articles.map(a => a.id), session);
  const results = [];
  let done = 0;

  await mapWithConcurrency(articles, SCORE_CONCURRENCY, async (article) => {
    const body = bodyMap.get(article.id) || {};
    const enriched = { ...article, ...body };
    try {
      const result = await scoreArticle(enriched);
      results.push({ id: article.id, overall: result.overall, criteria: result.criteria });
    } catch (e) {
      results.push({ id: article.id, overall: null, error: e.message });
    }
    done++;
    if (done % 5 === 0) port.postMessage({ type: 'progress', batchResults: results.slice(-5), done, total: articles.length });
  });

  port.postMessage({ type: 'done', scored: results });
}

export async function handleRewrite(port, msg) {
  const article = msg.article;
  if (!article) { port.postMessage({ type: 'error', error: 'No article provided' }); return; }
  try {
    const desc = stripHtml(article.description || article.body || '').slice(0, MAX_BODY_CHARS);
    const res = stripHtml(article.resolution || '').slice(0, MAX_BODY_CHARS);
    const steps = stripHtml(article.steps || '').slice(0, 1500);
    await streamClaude({
      system: `You are an expert technical writer specializing in Salesforce Knowledge Articles optimized for Agentforce (AGF) retrieval.

CONTEXT — HOW AGENTFORCE RETRIEVES CONTENT:
- Articles are split into chunks at header boundaries (section-aware chunking, max 512 tokens per chunk)
- Only TOP 5 chunks from 195k+ pieces are selected via hybrid search (exact match + vector similarity)
- Title is prepended to every chunk — it directly affects ALL retrieval
- Videos, screenshots, file attachments are IGNORED — only text and alt-text are indexed
- Code blocks are poorly consumed — text explanations are essential
- Product & Topic tags are NOT yet used by RAG — product name must appear in body text

REWRITE RULES:
1. TITLE: ≤60 chars, front-load keywords, include specific product name, no question format, symptom-based for troubleshooting
2. SUMMARY: ≤170 chars, use DIFFERENT words/synonyms than title, specify audience, include exact error text if applicable
3. DESCRIPTION: Start with intent paragraph explaining WHAT question this answers and WHY. Explain uncommon acronyms. Use present tense. Include the customer's likely phrasing of the problem. Mention product name explicitly.
4. RESOLUTION: Begin with a brief context paragraph. Use numbered steps. Each step is a complete actionable instruction. Include expected outcomes. Add real-life examples with Salesforce-format data (random UUIDs, realistic field values — never "xxxxx").
5. HEADERS: Use ## for sections (translates to <h2>). Make headers descriptive with intent keywords. Keep content under each header ≤512 tokens (~2048 chars). If longer, split with sub-headers (###).
6. STRUCTURE: Short paragraphs (3-5 sentences). Use bullet lists. Each section self-contained and readable in isolation (it may be retrieved as a standalone chunk).
7. NO: visual indicators in tables, screenshot-only solutions, unexplained code blocks, internal URLs, speculative statements, PII/credentials.

Output format:
## TITLE
## SUMMARY
## DESCRIPTION
## RESOLUTION

Preserve all technical accuracy from the original. Enhance structure, clarity, and retrieval optimization.`,
      messages: [{ role: 'user', content: `Original Article to Rewrite:\n\nTitle: ${article.title}\nProduct & Topic: ${article.topicName || '(none)'}\nValidation: ${article.validationStatus || 'Not Validated'}\n\nSummary: ${article.summary || '(empty)'}\n\nDescription:\n${desc || '(empty)'}\n\nResolution:\n${res || '(empty)'}${steps ? `\n\nSteps:\n${steps}` : ''}` }],
      maxTokens: 4000,
      onDelta: (chunk) => port.postMessage({ type: 'delta', chunk }),
      onDone: (full) => port.postMessage({ type: 'done', text: full })
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function fetchBodies(articleIds, session) {
  const bodyMap = new Map();
  const batches = [];
  for (let i = 0; i < articleIds.length; i += BODY_FETCH_BATCH_SIZE) batches.push(articleIds.slice(i, i + BODY_FETCH_BATCH_SIZE));
  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Description__c, Resolution__c, Steps__c, additional_resources__c FROM Knowledge__kav WHERE PublishStatus IN ('Online','Draft','Archived') AND Id IN (${soqlIdList(batch)})`;
      const url = `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, session.sid);
      for (const r of (result.records || [])) {
        bodyMap.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '', steps: r.Steps__c || '', additionalResources: r.additional_resources__c || '' });
      }
    } catch {}
  }
  return bodyMap;
}

function buildScoringPrompt(article) {
  const descRaw = article.description || '';
  const resRaw = article.resolution || '';
  const descText = stripHtml(descRaw).slice(0, MAX_BODY_CHARS);
  const resText = stripHtml(resRaw).slice(0, MAX_BODY_CHARS);
  const stepsText = stripHtml(article.steps || '').slice(0, 1500);

  const flags = [];
  if (article.containsImage) flags.push('HAS_IMAGES');
  if (article.containsVideo) flags.push('HAS_VIDEO');
  if (hasCodeBlocks(descRaw) || hasCodeBlocks(resRaw)) flags.push('HAS_CODE_BLOCKS');
  if (hasTables(descRaw) || hasTables(resRaw)) flags.push('HAS_TABLES');
  if (!hasHeaders(descRaw) && !hasHeaders(resRaw)) flags.push('NO_HTML_HEADERS');
  if (article.containsImage && !hasAltText(descRaw) && !hasAltText(resRaw)) flags.push('IMAGES_MISSING_ALT');
  if (/orgcs\.lightning\.force\.com|orgcs\.my\.salesforce\.com/i.test(descRaw + resRaw)) flags.push('HAS_INTERNAL_URLS');
  if ((article.additionalResources || '').trim().length > 20) flags.push('HAS_ADDITIONAL_RESOURCES');

  const { maxes, naSet } = computeDynamicMaxes(flags);
  const m = maxes;

  const system = `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce (AGF) readiness.
Score this article for how well it will be RETRIEVED and CONSUMED by Agentforce's RAG pipeline.

CONTEXT — HOW AGENTFORCE WORKS:
- Articles are split into chunks (max 512 tokens each) at header boundaries (section-aware chunking)
- Only the TOP 5 chunks from 195k+ content pieces are selected via hybrid search (exact + vector)
- Videos, screenshots, file attachments are IGNORED — only text and alt-text are indexed
- Code blocks are poorly consumed — text explanations alongside code are essential
- Product & Topic tags are NOT yet used by RAG — product name must appear in body text
- Title is prepended to every chunk, so it directly affects all retrieval

Dynamic max points per criterion are provided. TOTAL MUST EQUAL 100.
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : ''}

SCORING: Be STRICT. Most articles score 55-75. Score 90+ should be genuinely rare.
Every criterion MUST include "passed" (what you verified passes) and "issues" (specific problems found).

CRITERIA AND SUB-RULES:

title(max ${m.title}): ≤60 chars, front-loaded keywords, specific product name included, no question format, matches article intent, symptom-based for troubleshooting articles.

summary(max ${m.summary}): ≤170 chars, uses DIFFERENT words than title, includes synonyms/keywords not in title, specifies audience if applicable, includes exact error text for error articles.

headers(max ${m.headers}): Uses proper <h1>-<h6> tags (NOT bold text), descriptive of section content, logical hierarchy, sections under each header ≤512 tokens (~2048 chars), intent keywords in headers. Bold-as-header is a CRITICAL failure.

content(max ${m.content}): Description explains WHAT question is answered and WHY. Resolution has context paragraph. Real-life examples with Salesforce-format data (not xxxxx placeholders). Uncommon acronyms/abbreviations explained. Present tense. Conversational tone. Complete problem/environment/cause/resolution. No speculative statements. Each section self-contained (readable in isolation as a chunk).

scannability(max ${m.scannability}): Multiple article sections used (Description + Resolution + Steps). Short paragraphs (3-5 sentences). Bulleted/numbered lists for steps. No wall-of-text. FAQs have descriptive headers per item. Long articles broken into distinct sections. No multi-intent FAQ articles.

media(max ${m.media}): All informative images have descriptive alt text. Key info from screenshots ALSO written as text. Steps shown visually ALSO described in text. No screenshot-only solutions.

code(max ${m.code}): Every code block has a text explanation of what it does, its purpose, inputs, and expected output. Solution is understandable WITHOUT reading the code. Code supplements text, not replaces it.

tables(max ${m.tables}): Text-only content (NO checkmarks ✓, circles ●, icons, emojis). Built with in-article table editor (not pasted from external sources). Descriptive column headers. Reasonable width (≤5 columns preferred).

links(max ${m.links}): Additional Resources section populated with relevant links. Smart links for internal articles. Descriptive link text (not "click here"). No internal-only URLs (orgcs.lightning.force.com). No broken links. Article is self-contained (links supplement, don't replace content).

taxonomy(max ${m.taxonomy}): Product name appears explicitly in body text (not just in P&T tag). Uses specific product+feature together ("Tableau Prep Flows" not "Flows"). Edition/cloud specified if applicable. P&T tag aligns with article content.

Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"...","score":<n>,"passed":["..."],"issues":["..."],"suggestions":["..."]},...]}`;

  const user = `ARTICLE:
Title: ${article.title}
Article#: ${article.articleNumber}
P&T: ${article.topicName || '(none)'}
Validation: ${article.validationStatus || 'Not Validated'}
Flags: ${flags.join(', ') || 'none'}
Dynamic Maxes: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ')}

SUMMARY: ${article.summary || '(empty)'}

DESCRIPTION (${descText.length} chars):
${descText || '(empty)'}

RESOLUTION (${resText.length} chars):
${resText || '(empty)'}
${stepsText ? `\nSTEPS:\n${stepsText}` : ''}

Score now. Return only JSON. overall must equal sum of all scores.`;

  return { system, user, maxes };
}

async function scoreArticle(article) {
  const { system, user, maxes } = buildScoringPrompt(article);
  const resp = await callClaudeFast({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2200,
    temperature: 0.1,
    model: SCORING_MODEL
  });
  const text = extractText(resp);
  const obj = extractJson(text);
  if (!obj) return { overall: null, criteria: [], error: 'No JSON in response' };

  const criteria = CRITERIA.map(c => {
    const found = (obj.criteria || []).find(x => x.id === c.id) || {};
    const effectiveMax = maxes?.[c.id] ?? c.baseMax;
    const isNa = found.na === true || effectiveMax === 0;
    const score = isNa ? 0 : Math.min(effectiveMax, Math.max(0, Math.round(Number(found.score) || 0)));
    return { id: c.id, label: c.label, score, max: effectiveMax, na: isNa, passed: Array.isArray(found.passed) ? found.passed.filter(Boolean) : [], issues: Array.isArray(found.issues) ? found.issues.filter(Boolean) : [], suggestions: Array.isArray(found.suggestions) ? found.suggestions.filter(Boolean) : [] };
  });
  const overall = Math.min(100, criteria.reduce((s, c) => s + c.score, 0));
  return { overall, criteria, error: null };
}
