import { callClaudeFast, extractText, extractJson } from './gateway.js';
import { stripHtml } from './api.js';
import { SCORING_MODEL } from './config.js';

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
  if (articles.length < 2) return [];
  const snippets = articles.map(a => {
    const desc = stripHtml(a.description || '').slice(0, 800);
    const res = stripHtml(a.resolution || '').slice(0, 800);
    return `--- ARTICLE ${a.articleNumber} ---\nTitle: ${a.title}\nSummary: ${(a.summary || '').slice(0, 200)}\n${desc ? `Description: ${desc}\n` : ''}${res ? `Resolution: ${res}` : ''}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: DEDUP_SYSTEM,
      messages: [{ role: 'user', content: `Analyze these ${articles.length} articles for the same Product-Topic. Find near-identical duplicates.\n\n${snippets}` }],
      maxTokens: 2000,
      temperature: 0.1,
      model: SCORING_MODEL
    });
    const parsed = extractJson(extractText(resp));
    return (parsed?.pairs || []).filter(p => p.articleA && p.articleB && p.articleA !== p.articleB && p.confidence >= 0.85);
  } catch {
    return [];
  }
}
