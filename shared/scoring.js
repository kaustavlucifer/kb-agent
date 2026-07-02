import { stripHtml, hasCodeBlocks, hasHeaders, hasTables, hasAltText, sfGet, soqlIdList } from './api.js';
import { callClaudeFast, extractText, extractJson } from './gateway.js';
import { SF_API_VERSION, MAX_BODY_CHARS, BODY_FETCH_BATCH_SIZE, SCORING_MODEL, SCORING_MAX_TOKENS } from './config.js';
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
- Customer input is tokenized by the Planner Service, then Data Cloud finds the closest chunks via hybrid search (1:1 keyword match + vector similarity), producing a confidence score
- Articles are split into chunks (max 512 tokens each) at header boundaries (section-aware chunking) BEFORE vectorization — header tags define the split points and convey topic hierarchy
- Only the TOP 5 chunks from 2M+ content pieces are selected; the article competes against every other content type, so each chunk must be self-contained and keyword-rich
- Videos, screenshots, file attachments are IGNORED — only text and alt-text are indexed
- Code blocks are poorly consumed — text explanations alongside code are essential
- Product & Topic tags are NOT yet used by RAG — the product name must appear in body text, paired with the feature term ("Tableau Prep Flows", not just "Flows")
- Title is prepended to every chunk, so it directly affects all retrieval
- Content is retrieved best when phrased conversationally and in complete sentences that mirror how a customer would ask the question

Dynamic max points per criterion and any N/A criteria are provided in the user message. TOTAL MUST EQUAL 100.

SCORING: Be ACCURATE and evidence-based, not artificially harsh. Score each criterion on its own merits against the sub-rules below — award full points when the sub-rules are genuinely met, and deduct only for concrete, identifiable problems (cite them in "issues"). A well-structured, complete, product-specific article SHOULD score 90+; a typical legacy article with weak headers/title lands in the 60s-70s; only genuinely poor articles score below 55. Do not deflate a strong article toward an "average" just because high scores feel rare.
Every criterion MUST include "passed" (what you verified passes) and "issues" (specific problems found).

STRONG SIGNALS OF A POORLY-PERFORMING ARTICLE (weight these heavily when present):
- Title is generic or names the solution instead of the observed behavior/symptom
- Structure relies on bold sentences instead of real header tags (breaks chunking)
- Screenshot- or graphic-heavy with no text/alt-text describing what to do or enter
- One giant section instead of Description + Resolution split by headers
- Resolution lists steps with no summary paragraph explaining their intent
- Link-heavy or reference-heavy content that offloads the actual answer to other pages
- A single article bundling many unrelated FAQ intents
- Tables that carry meaning only through visual indicators, or pasted from external sources
- Product/feature name absent from the body text (present only in the P&T tag)

CRITERIA AND SUB-RULES (max points per criterion given in the user message):

title: ≤60 chars, keywords front-loaded (searchable feature/task names first), specific product name included, no question format, matches article intent. Describes the ISSUE BEHAVIOR, not the solution. If the article is scoped to a segment/edition/mode, the title says so. GOOD: "Lead History report displays no results", "Create a Case Assignment Rule for Customer Portal", "Salesforce.org Trial Extensions for Nonprofits". BAD: "Enabling Field History Tracking to populate a report" (states the solution), "Troubleshooting Flows" (not product-specific), "How to use Assignment Rules to automatically assign a Case..." (keyword buried, over-length).

summary: ≤170 chars, uses DIFFERENT words than title (distinct, not a restatement), includes synonyms/keywords not in title, specifies audience if applicable, includes exact error text for error articles. GOOD (title "Disable Chatter" → summary "Learn how to turn off Chatter features for your entire Salesforce org."). The summary is shown to customers in help-site search AND used by Agentforce for retrieval, so it must add searchable terms, not echo the title.

headers: Uses proper <h1>-<h6> tags (NOT bold sentences), descriptive of section content, logical hierarchy, sections under each header ≤512 tokens (~2048 chars), intent keywords in each header. Chunking splits ONLY on real header tags — a bolded sentence does not create a chunk boundary, so bold-as-header is a CRITICAL failure. Test: reading the headers alone should reveal what the article covers and how it is organized. Reference/convention headings (e.g. "Signature", "Return Value") may repeat and that is acceptable.

content: Description explains WHAT question is answered and WHY (root-cause context, when/where/how the issue occurs). Resolution opens with a summary paragraph stating what the steps accomplish and the intent behind them — never jump straight into steps assuming the Description is enough. Most important information first (readers scan in an "F" shape and drop off). Real-life Salesforce examples with realistic-format data (not xxxxx placeholders) when the topic is complex or confusing. Uncommon acronyms/abbreviations defined on first use (BDR = Business Development Representative; API needs no definition). Simple present tense. Conversational, complete sentences that echo how a customer phrases the question. Complete problem/environment/cause/resolution. Original content, not copied from external sources. No speculative statements. Each section self-contained (readable in isolation as a chunk).

scannability: Multiple article sections used (Description + Resolution + Steps) rather than one dumped block — Agentforce delivers multi-section content better. Short scannable paragraphs (3-5 sentences). Bulleted/numbered lists for steps. Most important info first. No wall-of-text. FAQ items each carry a descriptive, intent-bearing header (e.g. "How to fix Problem 123 when it shows behavior xyz") — intent in the heading is what Agentforce matches on. Large multi-intent FAQs are consumed poorly; each Q&A should be specific and stand alone. Long articles broken into distinct headed sections.

media: All informative images have descriptive alt text (the image itself is never served to the customer via Agentforce, but its alt text IS chunked and vectorized — so annotate every image). Key info from screenshots ALSO written as text. Steps shown visually ALSO described in text (a screenshot of a field with no text saying what to enter is a failure). No screenshot-only or attachment-only solutions.

code: Agentforce consumes code blocks poorly — raw code alone yields unstructured text, incomplete solutions, or "I can't answer". Every code block needs a succinct plain-text description of what it does, its purpose, inputs, and expected output, so the solution is understandable WITHOUT reading the code. Standalone, runnable samples preferred. Code supplements text, never replaces it.

tables: Text-only content (NO checkmarks ✓, circles ●, icons, emojis as data — a row response needs words, not symbols). Built with the in-article table editor, NOT pasted from Google Sheets or web pages (external paste carries redundant tags that bloat the chunk). Descriptive column headers. Reasonable width (≤5 columns preferred). No images inside tables.

links: Additional Resources section populated with relevant links (this section IS used by Agentforce for citations). Descriptive hyperlink TEXT, never raw exposed URLs ("See 'Postmaster Tools' on Gmail Support" not the bare URL; name the external site). No internal-only URLs (orgcs.lightning.force.com, help URLs behind login). No broken links. Article is self-contained (links supplement, don't replace content).

taxonomy: Product name appears explicitly in body text (not just in P&T tag, which RAG does not yet read). Uses specific product+feature together ("Tableau Prep Flows" not "Flows"; "MuleSoft APIs" not "APIs"). Edition/cloud/mode specified if the article is scoped to one. P&T tag reflects the BEST-FIT product and topic — not over-tagged with every possible association (less is more; over-tagging clutters retrieval). Example of correct restraint: for "Image Attachments not Rendering in Social Customer Service Case Feed", tag Products {Marketing Cloud, Social Studio} + Topics {Customer Service, Customer Engagement, Social Media} — NOT also {Marketing, Digital Marketing, Technology, Development, Apex}, which are loose associations, not the article's essence.

CALIBRATION — apply this judgment:
- A behavior-based, product-specific title that a customer would actually search ("Lead History report displays no results") scores full title points; a solution-named or generic title ("Enabling Field History Tracking...", "Troubleshooting Flows") is docked hard even if the body is good.
- Real header tags with intent keywords that summarize the article when read alone = full headers points; bold sentences doing a header's job = near-zero, because chunking never sees them.
- A Resolution that opens by stating what the steps accomplish and why, then numbers them, beats a bare step list even when the steps are correct — the intent paragraph is what Agentforce matches a question against.
- Undefined uncommon acronyms, xxxxx placeholder data, "contact support" as a step, and internal orgcs URLs are each concrete, citable deductions — never overlook them.

Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"...","score":<n>,"passed":["..."],"issues":["..."],"suggestions":["..."]},...]}`;

  const user = `ARTICLE:
Title: ${article.title}
Article#: ${article.articleNumber}
P&T: ${article.topicName || '(none)'}
Validation: ${article.validationStatus || 'Not Validated'}
Flags: ${flags.join(', ') || 'none'}
Links: RAW_URLs=${rawUrls.length}, ANCHORED=${linkAnchors.length}, INTERNAL=${internalUrls.length}
Dynamic Maxes: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ')}
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : 'N/A CRITERIA: none'}

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

export async function scoreArticle(article, maxTokens = SCORING_MAX_TOKENS) {
  const { system, user, maxes } = buildScoringPrompt(article);
  const resp = await callClaudeFast({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens,
    temperature: 0.1,
    model: SCORING_MODEL,
    cache: true
  });
  const text = extractText(resp);
  return parseScoreResponse(text, maxes);
}

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export async function fetchArticleBodies(articleIds, session) {
  const bodyMap = new Map();
  const failedIds = new Set();
  const validIds = articleIds.filter(id => SF_ID_RE.test(id));
  const batches = [];
  for (let i = 0; i < validIds.length; i += BODY_FETCH_BATCH_SIZE) batches.push(validIds.slice(i, i + BODY_FETCH_BATCH_SIZE));
  const runBatch = async (batch) => {
    const soql = `SELECT Id, Description__c, Resolution__c, Steps__c, additional_resources__c FROM Knowledge__kav WHERE PublishStatus IN ('Online','Draft','Archived') AND Id IN (${soqlIdList(batch)})`;
    const url = `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    const result = await sfGet(url, session.sid);
    for (const r of (result.records || [])) {
      bodyMap.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '', steps: r.Steps__c || '', additionalResources: r.additional_resources__c || '' });
    }
  };
  for (const batch of batches) {
    try {
      await runBatch(batch);
    } catch (e) {
      try {
        await runBatch(batch);
      } catch (e2) {
        batch.forEach(id => failedIds.add(id));
      }
    }
  }
  bodyMap.failedIds = failedIds;
  return bodyMap;
}
