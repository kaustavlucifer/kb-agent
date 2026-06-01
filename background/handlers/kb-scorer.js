import { detectSession } from '../../shared/auth.js';
import { sfGet, soqlIdList, mapWithConcurrency, stripHtml, hasCodeBlocks, hasHeaders, hasTables, hasAltText } from '../../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../../shared/gateway.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, BODY_FETCH_BATCH_SIZE, MAX_BODY_CHARS, SCORING_MODEL } from '../../shared/config.js';

const CRITERIA = [
  { id: 'title', label: 'Title Quality', baseMax: 12 },
  { id: 'summary', label: 'Summary Quality', baseMax: 10 },
  { id: 'headers', label: 'Header Structure', baseMax: 10 },
  { id: 'content', label: 'Content Completeness', baseMax: 18 },
  { id: 'scannability', label: 'Scannability & Structure', baseMax: 10 },
  { id: 'media', label: 'Alt Text / Media', baseMax: 8 },
  { id: 'code', label: 'Code Block Quality', baseMax: 8 },
  { id: 'tables', label: 'Table Quality', baseMax: 8 },
  { id: 'links', label: 'Links & URLs', baseMax: 8 },
  { id: 'taxonomy', label: 'Taxonomy & Product Context', baseMax: 8 }
];

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
    await streamClaude({
      system: 'You are an expert technical writer. Rewrite this Salesforce KB article for Agentforce readiness. Output: ## TITLE, ## SUMMARY, ## DESCRIPTION, ## RESOLUTION.',
      messages: [{ role: 'user', content: `Title: ${article.title}\nSummary: ${article.summary || ''}\nDescription: ${desc}\nResolution: ${res}` }],
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

function computeDynamicMaxes(flags) {
  const naSet = new Set();
  if (!flags.includes('HAS_IMAGES') && !flags.includes('HAS_VIDEO')) naSet.add('media');
  if (!flags.includes('HAS_CODE_BLOCKS')) naSet.add('code');
  if (!flags.includes('HAS_TABLES')) naSet.add('tables');

  const freedPoints = CRITERIA.filter(c => naSet.has(c.id)).reduce((sum, c) => sum + c.baseMax, 0);
  if (freedPoints === 0) return { maxes: Object.fromEntries(CRITERIA.map(c => [c.id, c.baseMax])), naSet };

  const activeIds = CRITERIA.filter(c => !naSet.has(c.id)).map(c => c.id);
  const redistribution = {};
  const contentBonus = Math.round(freedPoints * 0.45);
  redistribution['content'] = contentBonus;
  let distributed = contentBonus;

  const secondaryIds = activeIds.filter(id => id !== 'content' && id !== 'title' && id !== 'summary');
  const secondaryBase = secondaryIds.reduce((s, id) => s + CRITERIA.find(c => c.id === id).baseMax, 0);
  const remaining = freedPoints - distributed;
  for (const id of secondaryIds) {
    const base = CRITERIA.find(c => c.id === id).baseMax;
    redistribution[id] = Math.round(remaining * (base / secondaryBase));
  }

  const diff = freedPoints - Object.values(redistribution).reduce((a, b) => a + b, 0);
  if (diff !== 0 && redistribution['headers'] != null) redistribution['headers'] += diff;

  const maxes = {};
  for (const c of CRITERIA) {
    if (naSet.has(c.id)) maxes[c.id] = 0;
    else maxes[c.id] = c.baseMax + (redistribution[c.id] || 0);
  }
  const total = Object.values(maxes).reduce((a, b) => a + b, 0);
  if (total !== 100) maxes['content'] += (100 - total);

  return { maxes, naSet };
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

  const system = `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce readiness.
Score this article. Dynamic max points per criterion are provided. TOTAL MUST EQUAL 100.
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : ''}

SCORING: Be STRICT. Most articles score 55-75. Score 90+ should be genuinely rare.
Every criterion MUST include "passed" (what you verified passes) and "issues" (specific problems).

CRITERIA: title(max ${m.title}), summary(max ${m.summary}), headers(max ${m.headers}), content(max ${m.content}), scannability(max ${m.scannability}), media(max ${m.media}), code(max ${m.code}), tables(max ${m.tables}), links(max ${m.links}), taxonomy(max ${m.taxonomy}).

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
