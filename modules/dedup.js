import { h, spinner, emptyState, toast, modal, progressBar, multiSelect, stickyScrollLayout } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { DEDUP_BATCH_SIZE, DEDUP_CONCURRENCY, MAX_BODY_CHARS, STORAGE_KEYS, CLOUDS, getCloudFromPt } from '../shared/config.js';
import { runDedupBatch } from '../shared/dedup.js';
import { fetchArticleBodies } from '../shared/scoring.js';

let _container = null;
let _unsubs = [];
let _filterCloud = [];
let _filterPt = [];



export function mount(container) {
  _container = container;
  if (!getState('dedup.pairs')) {
    setState('dedup.pairs', []);
    setState('dedup.running', null);
    loadCachedResults();
  }
  render();
  _unsubs.push(subscribe('dedup.pairs', render));
  _unsubs.push(subscribe('dedup.running', render));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

async function loadCachedResults() {
  const data = await localGet([STORAGE_KEYS.DEDUP_RESULTS, STORAGE_KEYS.DEDUP_AT]);
  if (data[STORAGE_KEYS.DEDUP_RESULTS]?.length) {
    setState('dedup.pairs', data[STORAGE_KEYS.DEDUP_RESULTS]);
  }
}

function render() {
  if (!_container) return;
  _container.textContent = '';
  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  const pairs = getState('dedup.pairs') || [];
  const running = getState('dedup.running');
  const articles = getState('kb.articles') || [];

  const ptOptions = [...new Set(articles.map(a => a.topicName).filter(Boolean))].sort();

  const cloudMulti = multiSelect('dedup-cloud-filter', 'Cloud',
    CLOUDS.map(c => ({ value: c, label: c })),
    _filterCloud,
    (sel) => { _filterCloud = sel; render(); }
  );

  const filteredPtOptions = _filterCloud.length
    ? ptOptions.filter(pt => _filterCloud.includes(getCloudFromPt(pt)))
    : ptOptions;

  const ptMulti = multiSelect('dedup-pt-filter', 'Product & Topic',
    filteredPtOptions.map(pt => ({ value: pt, label: pt })),
    _filterPt,
    (sel) => { _filterPt = sel; render(); }
  );

  const clearBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: !pairs.length || !!running }, 'Clear');
  clearBtn.addEventListener('click', clearResults);
  const detectBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: !!running || !articles.length },
    running ? 'Scanning…' : 'Detect Duplicates'
  );
  detectBtn.addEventListener('click', detectDuplicates);

  let scopedArticles = articles;
  if (_filterCloud.length) scopedArticles = scopedArticles.filter(a => _filterCloud.includes(getCloudFromPt(a.topicName)));
  if (_filterPt.length) scopedArticles = scopedArticles.filter(a => _filterPt.includes(a.topicName));
  const batchCount = Math.ceil(scopedArticles.length / DEDUP_BATCH_SIZE);
  const scopeInfo = _filterPt.length
    ? `Filtered: ${scopedArticles.length} articles in ${_filterPt.length} P&Ts, ${batchCount} batches`
    : `All P&Ts: ${scopedArticles.length} articles, ${batchCount} batches`;

  const toolbar = h('div', { class: 'tab-toolbar' },
    cloudMulti,
    ptMulti,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, scopeInfo),
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginRight: 'auto' } },
      running ? `Scanning… ${running.done}/${running.total} batches` : `${pairs.length} potential duplicate pairs`
    ),
    clearBtn,
    detectBtn
  );
  stickySection.appendChild(toolbar);

  if (running) {
    const pct = running.total > 0 ? Math.round((running.done / running.total) * 100) : 0;
    stickySection.appendChild(h('div', { class: 'card', style: { padding: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', null, running.ptName ? `P&T: ${running.ptName}` : 'Preparing…'),
        h('span', null, `${pct}%`)
      ),
      progressBar(pct, 'default', true)
    ));
  }

  if (!articles.length && !pairs.length) {
    scrollSection.appendChild(emptyState('🔗', 'Load articles in the KB Articles tab first, then detect duplicates.'));
    return;
  }

  if (!pairs.length && !running) {
    scrollSection.appendChild(emptyState('✓', 'No duplicates found. Click "Detect Duplicates" to scan articles grouped by Product & Topic.'));
    return;
  }

  const displayPairs = _filterPt.length ? pairs.filter(p => _filterPt.includes(p.ptName)) : pairs;
  if (displayPairs.length) {
    const table = h('table', { class: 'data-table data-table--animated' },
      h('thead', null, h('tr', null,
        h('th', null, 'Article A'),
        h('th', null, 'Article B'),
        h('th', { style: { width: '80px' } }, 'Type'),
        h('th', { style: { width: '70px' } }, 'Conf.'),
        h('th', null, 'Reason'),
        h('th', { style: { width: '100px' } }, 'Actions')
      )),
      h('tbody', null)
    );
    const tbody = table.querySelector('tbody');
    displayPairs.forEach(pair => {
      const confPct = Math.round((pair.confidence || 0) * 100);
      tbody.appendChild(h('tr', null,
        h('td', { style: { fontSize: '12px' } },
          h('div', { style: { fontWeight: '500' } }, `#${pair.articleA}`),
          h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, pair.titleA || '')
        ),
        h('td', { style: { fontSize: '12px' } },
          h('div', { style: { fontWeight: '500' } }, `#${pair.articleB}`),
          h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, pair.titleB || '')
        ),
        h('td', null, h('span', { class: `pill pill--${pair.relationship === 'DUPLICATE' ? 'error' : 'warning'}` }, pair.relationship || 'DUP')),
        h('td', null, h('span', { class: `pill pill--${confPct >= 95 ? 'error' : 'warning'}` }, `${confPct}%`)),
        h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '200px' } }, pair.reason || ''),
        h('td', null,
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => showMerge(pair) }, 'Merge')
        )
      ));
    });
    scrollSection.appendChild(table);
  }
}

async function clearResults() {
  setState('dedup.pairs', []);
  await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: [], [STORAGE_KEYS.DEDUP_AT]: null });
}

async function detectDuplicates() {
  try {
    let articles = getState('kb.articles') || [];
    if (_filterCloud.length) articles = articles.filter(a => _filterCloud.includes(getCloudFromPt(a.topicName)));
    if (_filterPt.length) articles = articles.filter(a => _filterPt.includes(a.topicName));
    if (articles.length < 2) { toast('Need at least 2 articles in selected filters.', 'error'); return; }

    const session = await detectSession();
    if (!session.sid) { toast('No SF session.', 'error'); return; }

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

    if (!workQueue.length) { toast('Not enough articles per P&T to compare.', 'info'); return; }

    setState('dedup.running', { done: 0, total: workQueue.length, ptName: '' });

    const bodyIds = articles.map(a => a.id);
    const bodyMap = await fetchArticleBodies(bodyIds, session);

    const allPairs = [];
    let done = 0;

    await mapWithConcurrency(workQueue, DEDUP_CONCURRENCY, async (item) => {
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
      const enriched = item.batch.map(a => ({
        ...a,
        description: bodyMap.get(a.id)?.description || '',
        resolution: bodyMap.get(a.id)?.resolution || ''
      }));
      const pairs = await runDedupBatch(enriched);
      allPairs.push(...pairs);
      done++;
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
    });

    console.log('[KB-Agent] Dedup: found', allPairs.length, 'raw pairs from', workQueue.length, 'batches');

    const articleMap = new Map();
    articles.forEach(a => {
      articleMap.set(a.articleNumber, a);
      articleMap.set(String(a.articleNumber), a);
    });

    const enrichedPairs = allPairs
      .filter(p => p.confidence >= 0.85)
      .map(p => ({
        ...p,
        ptName: articleMap.get(String(p.articleA))?.topicName || '',
        titleA: articleMap.get(String(p.articleA))?.title || '',
        titleB: articleMap.get(String(p.articleB))?.title || ''
      }))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 30);

    console.log('[KB-Agent] Dedup: enriched', enrichedPairs.length, 'pairs after filtering');

    setState('dedup.pairs', enrichedPairs);
    setState('dedup.running', null);
    await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: enrichedPairs, [STORAGE_KEYS.DEDUP_AT]: Date.now() });
    toast(`Found ${enrichedPairs.length} duplicate pairs.`, enrichedPairs.length ? 'warning' : 'success');
  } catch (e) {
    console.error('[KB-Agent] Dedup detection failed:', e);
    toast('Detection failed: ' + e.message, 'error');
    setState('dedup.running', null);
  }
}


async function showMerge(pair) {
  const articles = getState('kb.articles') || [];
  const artA = articles.find(a => a.articleNumber === pair.articleA);
  const artB = articles.find(a => a.articleNumber === pair.articleB);

  const streamEl = h('div', { id: 'merge-stream', style: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } }, spinner('md'));
  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } },
      h('div', null, h('strong', null, 'A: '), `#${pair.articleA} — ${pair.titleA}`),
      h('div', null, h('strong', null, 'B: '), `#${pair.articleB} — ${pair.titleB}`),
      h('div', { style: { marginTop: '4px', fontStyle: 'italic' } }, `Keep: #${pair.keepArticle} | ${pair.reason}`)
    ),
    streamEl
  );

  modal('Merge Suggestion', content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(document.getElementById('merge-stream')?.textContent || '').then(() => toast('Copied.', 'success'));
    }}
  });

  const session = await detectSession();
  let descA = '', resA = '', descB = '', resB = '';
  if (session.sid && artA && artB) {
    const bodyMap = await fetchArticleBodies([artA.id, artB.id], session);
    descA = stripHtml(bodyMap.get(artA.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resA = stripHtml(bodyMap.get(artA.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
    descB = stripHtml(bodyMap.get(artB.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resB = stripHtml(bodyMap.get(artB.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
  }

  const system = `You are an expert Salesforce Knowledge editor. Merge two duplicate articles into one optimal article following the Agentforce Writing Guide. Output:
## TITLE
[merged title]
## SUMMARY
[2-4 sentences]
## DESCRIPTION
[merged description]
## RESOLUTION
[merged resolution with numbered steps]`;

  const user = `Merge these duplicates into one article.

ARTICLE A (#${pair.articleA}):
Title: ${pair.titleA || artA?.title || ''}
Summary: ${artA?.summary || ''}
Description: ${descA}
Resolution: ${resA}

ARTICLE B (#${pair.articleB}):
Title: ${pair.titleB || artB?.title || ''}
Summary: ${artB?.summary || ''}
Description: ${descB}
Resolution: ${resB}

Keep best content from both. Prefer most complete and recent steps.`;

  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
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

