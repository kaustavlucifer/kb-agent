import { stripHtml, hasCodeBlocks, hasHeaders, hasTables, hasAltText, sfGet, soqlIdList } from './api.js';
import { callClaudeFast, extractText, extractJson } from './gateway.js';
import { SF_API_VERSION, MAX_BODY_CHARS, BODY_FETCH_BATCH_SIZE, SCORING_MODEL } from './config.js';
import { SCORING_CRITERIA, computeDynamicMaxes } from '../data/scoring_criteria.js';

export { SCORING_CRITERIA, computeDynamicMaxes };

export function mapArticleRecord(r) {
  return {
    id: r.Id,
    knowledgeArticleId: r.KnowledgeArticleId,
    articleNumber: r.ArticleNumber,
    title: r.Title,
    summary: r.Summary,
    urlName: r.UrlName,
    publishStatus: r.PublishStatus || 'Online',
    validationStatus: r.ValidationStatus,
    topicName: r.Product_And_Topic__r?.Name || '',
    containsImage: !!r.Contains_Image__c,
    containsVideo: !!r.Contains_Video__c,
    articleLength: r.Article_Length__c || 0,
    viewCount: r.ArticleTotalViewCount || 0,
    caseAttachCount: r.ArticleCaseAttachCount || 0,
    lastPublished: r.LastPublishedDate
  };
}

export function buildScoringPrompt(article) {
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

  const linkAnchors = (descRaw + resRaw).match(/<a\s[^>]*href\s*=\s*["'][^"']+["'][^>]*>[^<]+<\/a>/gi) || [];
  const rawUrls = ((descRaw + resRaw).match(/(?<!['"=])https?:\/\/[^\s"'<>]{10,}/gi) || [])
    .filter(u => !(descRaw + resRaw).includes('href="' + u));
  const internalUrls = (descRaw + resRaw).match(/https?:\/\/(orgcs|org62)[^\s"'<>]*/gi) || [];

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

SCORING: Be ACCURATE and evidence-based, not artificially harsh. Score each criterion on its own merits against the sub-rules below — award full points when the sub-rules are genuinely met, and deduct only for concrete, identifiable problems (cite them in "issues"). A well-structured, complete, product-specific article SHOULD score 90+; a typical legacy article with weak headers/title lands in the 60s-70s; only genuinely poor articles score below 55. Do not deflate a strong article toward an "average" just because high scores feel rare.
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
Links: RAW_URLs=${rawUrls.length}, ANCHORED=${linkAnchors.length}, INTERNAL=${internalUrls.length}
Dynamic Maxes: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ')}

SUMMARY (${(article.summary || '').length} chars):
${article.summary || '(empty)'}

DESCRIPTION (${descText.length} chars):
${descText || '(empty)'}

RESOLUTION (${resText.length} chars):
${resText || '(empty)'}
${stepsText ? `\nSTEPS:\n${stepsText}` : ''}

Score now. Return only JSON. overall must equal sum of all scores.`;

  return { system, user, maxes };
}

export function parseScoreResponse(text, dynamicMaxes) {
  const obj = extractJson(text);
  if (!obj) return { overall: null, criteria: [], error: 'No JSON in response' };

  const criteria = SCORING_CRITERIA.map(c => {
    const found = (obj.criteria || []).find(x => x.id === c.id) || {};
    const effectiveMax = dynamicMaxes?.[c.id] ?? c.baseMax;
    const isNa = found.na === true || effectiveMax === 0;
    const score = isNa ? 0 : Math.min(effectiveMax, Math.max(0, Math.round(Number(found.score) || 0)));
    return {
      id: c.id,
      label: c.label,
      score,
      max: effectiveMax,
      na: isNa,
      passed: Array.isArray(found.passed) ? found.passed.filter(Boolean) : [],
      issues: Array.isArray(found.issues) ? found.issues.filter(Boolean) : [],
      suggestions: Array.isArray(found.suggestions) ? found.suggestions.filter(Boolean) : []
    };
  });
  const overall = Math.min(100, criteria.reduce((s, c) => s + c.score, 0));
  return { overall, criteria, error: null };
}

// Convert a generated/rewritten draft (sections-based) into the article shape the
// scorer understands. Section bodies are wrapped in <h2> + <p> so the header,
// scannability, and structure checks see the same HTML the published article will
// have. This routes generated drafts through the SAME dynamic-max scorer used for
// existing articles — so a clean text draft can legitimately redistribute the
// media/code/table points into content and reach 90+.
export function draftToScorable(draft) {
  const sections = draft.sections || [];
  const descSec = sections.find(s => /description/i.test(s.heading)) || sections[0];
  const resSec = sections.find(s => /resolution/i.test(s.heading)) || sections[1];
  const toHtml = (heading, body) => {
    if (!body) return '';
    const paras = String(body).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    return `<h2>${heading}</h2>` + paras.map(p => `<p>${p}</p>`).join('');
  };
  return {
    title: draft.title || draft.articleTitle || '',
    summary: draft.summary || '',
    description: toHtml('Description', descSec?.body || ''),
    resolution: toHtml('Resolution', resSec?.body || ''),
    steps: '',
    topicName: draft.topicName || '',
    containsImage: false,
    containsVideo: false,
    validationStatus: draft.validationStatus || ''
  };
}

export async function scoreArticle(article) {
  const { system, user, maxes } = buildScoringPrompt(article);
  const resp = await callClaudeFast({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2200,
    temperature: 0.1,
    model: SCORING_MODEL
  });
  const text = extractText(resp);
  return parseScoreResponse(text, maxes);
}

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export async function fetchArticleBodies(articleIds, session) {
  const bodyMap = new Map();
  // Filter to valid SF IDs first. soqlIdList -> sanitizeId throws on a single bad ID,
  // and because each query covers a whole batch that would silently drop ~50 articles'
  // bodies (they'd then score as empty). Drop only the offending IDs instead.
  const validIds = articleIds.filter(id => SF_ID_RE.test(id));
  if (validIds.length !== articleIds.length) {
    console.warn(`[KB-Agent] fetchArticleBodies: skipped ${articleIds.length - validIds.length} invalid article ID(s).`);
  }
  const batches = [];
  for (let i = 0; i < validIds.length; i += BODY_FETCH_BATCH_SIZE) batches.push(validIds.slice(i, i + BODY_FETCH_BATCH_SIZE));
  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Description__c, Resolution__c, Steps__c, additional_resources__c FROM Knowledge__kav WHERE PublishStatus IN ('Online','Draft','Archived') AND Id IN (${soqlIdList(batch)})`;
      const url = `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, session.sid);
      for (const r of (result.records || [])) {
        bodyMap.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '', steps: r.Steps__c || '', additionalResources: r.additional_resources__c || '' });
      }
    } catch (e) {
      // Best-effort: a failed batch leaves those articles without bodies (scored as empty).
      // Surface the cause (e.g. session expiry) instead of hiding it.
      console.warn(`[KB-Agent] fetchArticleBodies: batch of ${batch.length} failed: ${e.message}`);
    }
  }
  return bodyMap;
}
