import { callClaudeFast, streamClaude, extractText, extractJson } from '../../shared/gateway.js';
import { stripHtml } from '../../shared/api.js';
import { DEDUP_BATCH_SIZE, MAX_BODY_CHARS, SCORING_MODEL } from '../../shared/config.js';

const DEDUP_SYSTEM = `You are a Salesforce Knowledge article deduplication analyst. Find articles that are NEAR-IDENTICAL — not merely related.

STRICT DEFINITIONS:
- DUPLICATE: Description AND Resolution are essentially the same — same root cause, same fix steps.
- SUPERSEDED: One article directly replaces another — same problem, newer article fully covers older.

DO NOT FLAG:
- Same product but different error messages or symptoms
- Different root causes even if both mention performance
- Different audiences or setup scenarios
- Broader vs. more specific articles

Return JSON only:
{"pairs":[{"articleA":"<number>","articleB":"<number>","relationship":"DUPLICATE"|"SUPERSEDED","keepArticle":"<number to keep>","confidence":0.85-1.0,"reason":"<what content is identical>"}]}

Only flag pairs with confidence >= 0.85. If uncertain, do NOT flag.
- NEVER flag an article as a duplicate of ITSELF. articleA and articleB must be DIFFERENT article numbers.`;

export async function handleDedup(port, msg) {
  const articles = msg.articles || [];
  if (articles.length < 2) { port.postMessage({ type: 'done', pairs: [] }); return; }

  const ptGroups = new Map();
  for (const a of articles) {
    const pt = a.topicName || '__other__';
    if (!ptGroups.has(pt)) ptGroups.set(pt, []);
    ptGroups.get(pt).push(a);
  }

  const workQueue = [];
  for (const [ptName, ptArticles] of ptGroups) {
    if (ptArticles.length < 2) continue;
    for (let i = 0; i < ptArticles.length; i += DEDUP_BATCH_SIZE) {
      workQueue.push({ ptName, batch: ptArticles.slice(i, i + DEDUP_BATCH_SIZE) });
    }
  }

  const allPairs = [];
  let done = 0;
  for (const item of workQueue) {
    const pairs = await runBatch(item.batch);
    allPairs.push(...pairs);
    done++;
    port.postMessage({ type: 'progress', done, total: workQueue.length, ptName: item.ptName });
  }

  port.postMessage({ type: 'done', pairs: allPairs.filter(p => p.confidence >= 0.85).slice(0, 30) });
}

export async function handleMerge(port, msg) {
  const { articleA, articleB } = msg;
  if (!articleA || !articleB) { port.postMessage({ type: 'error', error: 'Missing articles' }); return; }
  const descA = stripHtml(articleA.description || '').slice(0, MAX_BODY_CHARS);
  const resA = stripHtml(articleA.resolution || '').slice(0, MAX_BODY_CHARS);
  const descB = stripHtml(articleB.description || '').slice(0, MAX_BODY_CHARS);
  const resB = stripHtml(articleB.resolution || '').slice(0, MAX_BODY_CHARS);

  try {
    await streamClaude({
      system: 'Merge two duplicate KB articles into one. Output: ## TITLE, ## SUMMARY, ## DESCRIPTION, ## RESOLUTION.',
      messages: [{ role: 'user', content: `A: "${articleA.title}"\nDesc: ${descA}\nRes: ${resA}\n\nB: "${articleB.title}"\nDesc: ${descB}\nRes: ${resB}` }],
      maxTokens: 4000,
      onDelta: (chunk) => port.postMessage({ type: 'delta', chunk }),
      onDone: (full) => port.postMessage({ type: 'done', text: full })
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function runBatch(articles) {
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
