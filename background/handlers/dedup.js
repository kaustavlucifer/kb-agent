import { streamClaude } from '../../shared/gateway.js';
import { stripHtml } from '../../shared/api.js';
import { DEDUP_BATCH_SIZE, MAX_BODY_CHARS } from '../../shared/config.js';
import { runDedupBatch } from '../../shared/dedup.js';

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
    const pairs = await runDedupBatch(item.batch);
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

