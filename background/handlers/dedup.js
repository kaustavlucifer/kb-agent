import { streamClaude } from '../../shared/gateway.js';
import { stripHtml } from '../../shared/api.js';
import { MAX_BODY_CHARS } from '../../shared/config.js';
import { runDedupBatch, buildDedupWorkQueue, dedupePairs } from '../../shared/dedup.js';

export async function handleDedup(port, msg) {
  const articles = msg.articles || [];
  if (articles.length < 2) { port.postMessage({ type: 'done', pairs: [] }); return; }

  const workQueue = buildDedupWorkQueue(articles);

  const allPairs = [];
  let done = 0;
  let incompleteBatches = 0;
  for (const item of workQueue) {
    const { pairs, incomplete } = await runDedupBatch(item.batch);
    allPairs.push(...pairs);
    if (incomplete) incompleteBatches++;
    done++;
    port.postMessage({ type: 'progress', done, total: workQueue.length, ptName: item.ptName });
  }

  const finalPairs = dedupePairs(allPairs.filter(p => p.confidence >= 0.85))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 30);
  port.postMessage({ type: 'done', pairs: finalPairs, incompleteBatches });
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

