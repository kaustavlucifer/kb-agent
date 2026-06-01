import { h, spinner, emptyState, toast, modal } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { mapWithConcurrency } from '../shared/api.js';
import { DEDUP_BATCH_SIZE, DEDUP_CONCURRENCY, STORAGE_KEYS } from '../shared/config.js';

let _container = null;
let _unsubs = [];

export function mount(container) {
  _container = container;
  if (!getState('dedup.pairs')) {
    setState('dedup.pairs', []);
    setState('dedup.running', false);
  }
  renderDedup();
  _unsubs.push(subscribe('dedup.pairs', renderDedup));
  _unsubs.push(subscribe('dedup.running', renderDedup));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

function renderDedup() {
  if (!_container) return;
  _container.textContent = '';
  const pairs = getState('dedup.pairs') || [];
  const running = getState('dedup.running');
  const articles = getState('kb.articles') || [];

  const toolbar = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } },
      running ? 'Detecting duplicates…' : `${pairs.length} potential duplicates`
    ),
    h('button', { class: 'btn btn--primary btn--sm', onClick: detectDuplicates, disabled: running || !articles.length },
      running ? 'Running…' : 'Detect Duplicates'
    )
  );
  _container.appendChild(toolbar);

  if (running) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('lg')));
    return;
  }

  if (!articles.length) {
    _container.appendChild(emptyState('🔗', 'Load articles in the KB Articles tab first, then detect duplicates.'));
    return;
  }

  if (!pairs.length) {
    _container.appendChild(emptyState('✓', 'No duplicates detected. Click "Detect Duplicates" to scan.'));
    return;
  }

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Article A'),
      h('th', null, 'Article B'),
      h('th', null, 'Similarity'),
      h('th', null, 'Actions')
    )),
    h('tbody', null)
  );
  const tbody = table.querySelector('tbody');
  pairs.forEach(pair => {
    const simPct = Math.round((pair.similarity || 0) * 100);
    tbody.appendChild(h('tr', null,
      h('td', { style: { fontSize: '12px' } }, `#${pair.a.articleNumber || ''} ${pair.a.title || ''}`),
      h('td', { style: { fontSize: '12px' } }, `#${pair.b.articleNumber || ''} ${pair.b.title || ''}`),
      h('td', null, h('span', { class: `pill pill--${simPct >= 80 ? 'error' : simPct >= 60 ? 'warning' : 'info'}` }, `${simPct}%`)),
      h('td', null,
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => showMergeSuggestion(pair) }, 'Merge Suggestion')
      )
    ));
  });
  _container.appendChild(table);
}

async function detectDuplicates() {
  const articles = getState('kb.articles') || [];
  if (articles.length < 2) { toast('Need at least 2 articles.', 'error'); return; }

  setState('dedup.running', true);
  const pairs = [];

  const batches = [];
  for (let i = 0; i < articles.length; i += DEDUP_BATCH_SIZE) {
    batches.push(articles.slice(i, i + DEDUP_BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      const batchPairs = await findDuplicatesInBatch(batch);
      pairs.push(...batchPairs);
    } catch {}
  }

  pairs.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  const topPairs = pairs.slice(0, 20);
  setState('dedup.pairs', topPairs);
  setState('dedup.running', false);
  await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: topPairs, [STORAGE_KEYS.DEDUP_AT]: Date.now() });
  toast(`Found ${topPairs.length} potential duplicates.`, 'info');
}

async function findDuplicatesInBatch(batch) {
  if (batch.length < 2) return [];
  const articleList = batch.map(a => `[${a.articleNumber}] ${a.title}`).join('\n');
  const resp = await callClaudeFast({
    system: 'Identify pairs of articles that are likely duplicates or near-duplicates. Return JSON: {"pairs": [{"a_idx": 0, "b_idx": 1, "similarity": 0.85, "reason": "..."}]}. Only include pairs with similarity >= 0.6.',
    messages: [{ role: 'user', content: `Articles:\n${articleList}` }],
    maxTokens: 1000,
    temperature: 0.1
  });
  const text = extractText(resp);
  const parsed = extractJson(text);
  if (!parsed?.pairs) return [];
  return parsed.pairs
    .filter(p => p.a_idx != null && p.b_idx != null && p.a_idx < batch.length && p.b_idx < batch.length)
    .map(p => ({
      a: batch[p.a_idx],
      b: batch[p.b_idx],
      similarity: p.similarity || 0.6,
      reason: p.reason || ''
    }));
}

async function showMergeSuggestion(pair) {
  const body = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' } },
      h('strong', null, 'A: '), `#${pair.a.articleNumber} ${pair.a.title}`,
      h('br', null),
      h('strong', null, 'B: '), `#${pair.b.articleNumber} ${pair.b.title}`
    ),
    h('div', { id: 'merge-stream', style: { whiteSpace: 'pre-wrap', fontSize: '13px', maxHeight: '400px', overflowY: 'auto' } }, spinner('md'))
  );

  modal('Merge Suggestion', body, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      const text = document.getElementById('merge-stream')?.textContent || '';
      navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'));
    }}
  });

  try {
    await streamClaude({
      system: 'Suggest how to merge these two duplicate KB articles into one. Provide the merged title and structure.',
      messages: [{ role: 'user', content: `Article A: #${pair.a.articleNumber} "${pair.a.title}"\nSummary: ${pair.a.summary || ''}\n\nArticle B: #${pair.b.articleNumber} "${pair.b.title}"\nSummary: ${pair.b.summary || ''}` }],
      maxTokens: 3000,
      onDelta: (chunk, full) => {
        const el = document.getElementById('merge-stream');
        if (el) el.textContent = full;
      }
    });
  } catch (e) {
    const el = document.getElementById('merge-stream');
    if (el) el.textContent = 'Error: ' + e.message;
  }
}

export async function handleDedup(port, msg) {
  const articles = msg.articles || [];
  port.postMessage({ type: 'progress', label: 'Detecting duplicates…' });
  const pairs = [];
  const batches = [];
  for (let i = 0; i < articles.length; i += DEDUP_BATCH_SIZE) {
    batches.push(articles.slice(i, i + DEDUP_BATCH_SIZE));
  }
  for (const batch of batches) {
    try {
      const batchPairs = await findDuplicatesInBatch(batch);
      pairs.push(...batchPairs);
    } catch {}
  }
  port.postMessage({ type: 'done', pairs: pairs.slice(0, 20) });
}

export async function handleMerge(port, msg) {
  const { articleA, articleB } = msg;
  try {
    await streamClaude({
      system: 'Suggest how to merge these two duplicate KB articles into one.',
      messages: [{ role: 'user', content: `Article A: "${articleA.title}"\nSummary: ${articleA.summary || ''}\n\nArticle B: "${articleB.title}"\nSummary: ${articleB.summary || ''}` }],
      maxTokens: 3000,
      onDelta: (chunk) => port.postMessage({ type: 'delta', chunk }),
      onDone: (full) => port.postMessage({ type: 'done', text: full })
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}
