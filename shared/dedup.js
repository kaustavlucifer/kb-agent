import { callClaudeFast, extractText, extractJson } from './gateway.js';
import { stripHtml } from './api.js';
import { SCORING_MODEL, DEDUP_MAX_TOKENS, DEDUP_BODY_CHARS, DEDUP_BATCH_SIZE } from './config.js';

export function buildDedupWorkQueue(articles) {
  const ptGroups = new Map();
  for (const a of articles) {
    const pt = a.topicName || '__other__';
    if (!ptGroups.has(pt)) ptGroups.set(pt, []);
    ptGroups.get(pt).push(a);
  }

  const workQueue = [];
  for (const [ptName, ptArticles] of ptGroups) {
    if (ptArticles.length < 2) continue;
    const slices = [];
    for (let i = 0; i < ptArticles.length; i += DEDUP_BATCH_SIZE) slices.push(ptArticles.slice(i, i + DEDUP_BATCH_SIZE));
    if (slices.length === 1) {
      workQueue.push({ ptName, batch: slices[0] });
    } else {
      for (let i = 0; i < slices.length; i++) {
        for (let j = i + 1; j < slices.length; j++) {
          workQueue.push({ ptName, batch: [...slices[i], ...slices[j]] });
        }
      }
    }
  }
  return workQueue;
}

export function dedupePairs(pairs) {
  const best = new Map();
  for (const p of pairs) {
    const a = String(p.articleA);
    const b = String(p.articleB);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = best.get(key);
    if (!existing || (p.confidence || 0) > (existing.confidence || 0)) best.set(key, p);
  }
  return [...best.values()];
}

export const DEDUP_SYSTEM = `You are a Salesforce Knowledge article deduplication analyst. Find articles that are NEAR-IDENTICAL — not merely related.

STRICT DEFINITIONS:
- DUPLICATE: Description AND Resolution are essentially the same — same root cause, same fix steps.
- SUPERSEDED: One article directly replaces another — same problem, newer article fully covers older.

DO NOT FLAG:
- Same product but different error messages or symptoms
- Different root causes even if both mention performance
- Different audiences or setup scenarios
- Broader vs. more specific articles (these should cross-link, not merge)

Return JSON only:
{"pairs":[{"articleA":"<number>","articleB":"<number>","relationship":"DUPLICATE"|"SUPERSEDED","keepArticle":"<number to keep>","confidence":0.85-1.0,"reason":"<what content is identical>"}]}

Rules:
- Only flag pairs with confidence >= 0.85
- Reason must state specific identical content
- If uncertain, do NOT flag — false negatives acceptable, false positives waste time
- NEVER flag an article as a duplicate of ITSELF. articleA and articleB must be DIFFERENT article numbers.
- If no duplicates: return {"pairs":[]}`;

export async function runDedupBatch(articles) {
  if (articles.length < 2) return { pairs: [], incomplete: false };
  const snippets = articles.map(a => {
    const desc = stripHtml(a.description || '').slice(0, DEDUP_BODY_CHARS);
    const res = stripHtml(a.resolution || '').slice(0, DEDUP_BODY_CHARS);
    const steps = stripHtml(a.steps || '').slice(0, DEDUP_BODY_CHARS);
    return `--- ARTICLE ${a.articleNumber} ---\nTitle: ${a.title}\nSummary: ${(a.summary || '').slice(0, 200)}\n${desc ? `Description: ${desc}\n` : ''}${res ? `Resolution: ${res}\n` : ''}${steps ? `Steps: ${steps}` : ''}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: DEDUP_SYSTEM,
      messages: [{ role: 'user', content: `Analyze these ${articles.length} articles for the same Product-Topic. Find near-identical duplicates.\n\n${snippets}` }],
      maxTokens: DEDUP_MAX_TOKENS,
      temperature: 0.1,
      model: SCORING_MODEL
    });
    const parsed = extractJson(extractText(resp));
    if (!parsed || !Array.isArray(parsed.pairs)) return { pairs: [], incomplete: true };
    const pairs = parsed.pairs.filter(p => p.articleA && p.articleB && p.articleA !== p.articleB && p.confidence >= 0.85);
    return { pairs, incomplete: resp.stop_reason === 'max_tokens' };
  } catch {
    return { pairs: [], incomplete: true };
  }
}
