import { h, spinner, emptyState, toast, modal, progressBar, multiSelect, stickyScrollLayout, statusPill, uniqueSortedValues } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { DEDUP_CONCURRENCY, MAX_BODY_CHARS, STORAGE_KEYS, CLOUDS, getCloudFromPt, articleUrl } from '../shared/config.js';
import { runDedupBatch, buildDedupWorkQueue, dedupePairs } from '../shared/dedup.js';
import { fetchArticleBodies, loadAllArticles } from '../shared/scoring.js';
import { estimateDedup, fmtUsd } from '../shared/cost.js';
import { showArticlePreview, showArticleCompare } from '../shared/article-preview.js';

let _container = null;
let _unsubs = [];
let _filterCloud = [];
let _filterPt = [];
let _filterValidation = ['Validated External', 'Validated Internal'];
let _filterPublish = ['Online'];
let _articlesLoading = false;

export function mount(container) {
  _container = container;
  if (!getState('dedup.pairs')) {
    setState('dedup.pairs', []);
    setState('dedup.running', null);
    loadCachedResults();
  }
  ensureArticlesLoaded();
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

async function ensureArticlesLoaded() {
  if (getState('kb.articles')?.length || _articlesLoading) return;
  _articlesLoading = true;
  render();
  try {
    const { articles, error } = await loadAllArticles();
    if (error) toast(error, 'error');
    else setState('kb.articles', articles);
  } catch (e) {
    toast('Failed to load articles: ' + e.message, 'error');
  } finally {
    _articlesLoading = false;
    if (_container) render();
  }
}

function articleCell(pair, side) {
  const number = pair[`article${side}`];
  const id = pair[`id${side}`];
  const title = pair[`title${side}`];
  const status = pair[`status${side}`];
  const validation = pair[`validation${side}`];
  const createdBy = pair[`createdBy${side}`];
  const modifiedBy = pair[`modifiedBy${side}`];

  const numberEl = id
    ? h('a', { href: articleUrl(id), target: '_blank', rel: 'noopener', style: { fontWeight: '600', color: 'var(--primary)', textDecoration: 'none', fontSize: '12px' } }, `#${number}`)
    : h('span', { style: { fontWeight: '600', fontSize: '12px' } }, `#${number}`);
  const statusEl = statusPill(status, { fontSize: '9px', padding: '1px 5px' });
  const viewBtn = id
    ? h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '11px', padding: '1px 5px' }, title: 'Preview article content locally', onClick: () => showArticlePreview(id, { articleNumber: number, title }) }, '👁')
    : null;
  const authorLine = [createdBy ? `Created: ${createdBy}` : null, modifiedBy ? `Modified: ${modifiedBy}` : null].filter(Boolean).join(' · ');

  return h('td', { style: { verticalAlign: 'top' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, numberEl, statusEl, viewBtn),
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' } }, title || ''),
    validation ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' } }, validation) : null,
    authorLine ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' } }, authorLine) : null
  );
}

function scopeArticles(articles) {
  let scoped = articles;
  if (_filterCloud.length) scoped = scoped.filter(a => _filterCloud.includes(getCloudFromPt(a.topicName)));
  if (_filterPt.length) scoped = scoped.filter(a => _filterPt.includes(a.topicName));
  if (_filterValidation.length) scoped = scoped.filter(a => _filterValidation.includes(a.validationStatus));
  if (_filterPublish.length) scoped = scoped.filter(a => _filterPublish.includes(a.publishStatus));
  return scoped;
}

function render() {
  if (!_container) return;
  _container.textContent = '';
  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  const pairs = getState('dedup.pairs') || [];
  const running = getState('dedup.running');
  const articles = getState('kb.articles') || [];

  const ptOptions = uniqueSortedValues(articles, 'topicName');
  const validationOptions = uniqueSortedValues(articles, 'validationStatus');
  const publishOptions = uniqueSortedValues(articles, 'publishStatus');

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

  const validationMulti = multiSelect('dedup-validation-filter', 'Validation',
    validationOptions.map(v => ({ value: v, label: v })),
    _filterValidation,
    (sel) => { _filterValidation = sel; render(); }
  );

  const publishMulti = multiSelect('dedup-publish-filter', 'Status',
    publishOptions.map(v => ({ value: v, label: v })),
    _filterPublish,
    (sel) => { _filterPublish = sel; render(); }
  );

  const clearBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: !pairs.length || !!running }, 'Clear');
  clearBtn.addEventListener('click', clearResults);
  const detectBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: !!running || !articles.length },
    running ? 'Scanning…' : 'Detect Duplicates'
  );
  detectBtn.addEventListener('click', detectDuplicates);

  const scopedArticles = scopeArticles(articles);
  const workQueue = buildDedupWorkQueue(scopedArticles);
  const batchCount = workQueue.length;
  const est = batchCount && !running ? estimateDedup(workQueue.map(w => w.batch)) : null;
  const scopeInfo = (_filterPt.length || _filterValidation.length || _filterPublish.length)
    ? `Filtered: ${scopedArticles.length} of ${articles.length} articles, ${batchCount} batches`
    : `All articles: ${scopedArticles.length} articles, ${batchCount} batches`;

  const toolbar = h('div', { class: 'tab-toolbar' },
    cloudMulti,
    ptMulti,
    validationMulti,
    publishMulti,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, scopeInfo),
    est ? h('span', {
      style: { fontSize: '11px', color: 'var(--text-muted)', alignSelf: 'center' },
      title: `${est.calls} calls · ~${est.inputTokens.toLocaleString()} in / ~${est.outputTokens.toLocaleString()} out tokens at current scoring model`
    }, `est. ~${fmtUsd(est.costUsd)}`) : null,
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
    if (_articlesLoading) {
      scrollSection.appendChild(h('div', { style: { padding: '48px 24px', textAlign: 'center' } },
        spinner('lg'),
        h('div', { style: { fontSize: '13px', color: 'var(--text-secondary)', marginTop: '12px' } }, 'Loading Knowledge Articles…')
      ));
      return;
    }
    const retryState = emptyState('🔗', 'No articles available. Check your Salesforce connection.');
    retryState.appendChild(h('button', { class: 'btn btn--secondary btn--sm', style: { marginTop: '12px' }, onClick: ensureArticlesLoaded }, 'Retry'));
    scrollSection.appendChild(retryState);
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
        h('th', { style: { width: '140px' } }, 'Actions')
      )),
      h('tbody', null)
    );
    const tbody = table.querySelector('tbody');
    displayPairs.forEach(pair => {
      const confPct = Math.round((pair.confidence || 0) * 100);
      tbody.appendChild(h('tr', null,
        articleCell(pair, 'A'),
        articleCell(pair, 'B'),
        h('td', null, h('span', { class: `pill pill--${pair.relationship === 'DUPLICATE' ? 'error' : 'warning'}` }, pair.relationship || 'DUP')),
        h('td', null, h('span', { class: `pill pill--${confPct >= 95 ? 'error' : 'warning'}` }, `${confPct}%`)),
        h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '200px' } }, pair.reason || ''),
        h('td', null,
          h('div', { style: { display: 'flex', gap: '4px' } },
            h('button', {
              class: 'btn btn--ghost btn--sm',
              disabled: !pair.idA || !pair.idB,
              title: (!pair.idA || !pair.idB) ? 'Re-run Detect Duplicates to enable compare for this pair' : 'Compare both articles side by side',
              onClick: () => showArticleCompare({ id: pair.idA, articleNumber: pair.articleA, title: pair.titleA }, { id: pair.idB, articleNumber: pair.articleB, title: pair.titleB })
            }, 'Compare'),
            h('button', { class: 'btn btn--ghost btn--sm', onClick: () => showMerge(pair) }, 'Merge')
          )
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
    const articles = scopeArticles(getState('kb.articles') || []);
    if (articles.length < 2) { toast('Need at least 2 articles in selected filters.', 'error'); return; }

    const session = await detectSession();
    if (!session.sid) { toast('No SF session.', 'error'); return; }

    const workQueue = buildDedupWorkQueue(articles);
    if (!workQueue.length) { toast('Not enough articles per P&T to compare.', 'info'); return; }

    setState('dedup.running', { done: 0, total: workQueue.length, ptName: '' });

    const bodyIds = articles.map(a => a.id);
    const bodyMap = await fetchArticleBodies(bodyIds, session);
    const bodyFetchFailures = bodyMap.failedIds?.size || 0;

    const allPairs = [];
    let done = 0;
    let incompleteBatches = 0;

    await mapWithConcurrency(workQueue, DEDUP_CONCURRENCY, async (item) => {
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
      const enriched = item.batch.map(a => ({
        ...a,
        description: bodyMap.get(a.id)?.description || '',
        resolution: bodyMap.get(a.id)?.resolution || '',
        steps: bodyMap.get(a.id)?.steps || ''
      }));
      const { pairs, incomplete } = await runDedupBatch(enriched);
      allPairs.push(...pairs);
      if (incomplete) incompleteBatches++;
      done++;
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
    });

    const articleMap = new Map();
    articles.forEach(a => {
      articleMap.set(a.articleNumber, a);
      articleMap.set(String(a.articleNumber), a);
    });

    const enrichedPairs = dedupePairs(allPairs.filter(p => p.confidence >= 0.85))
      .map(p => {
        const artA = articleMap.get(String(p.articleA));
        const artB = articleMap.get(String(p.articleB));
        return {
          ...p,
          ptName: artA?.topicName || '',
          titleA: artA?.title || '',
          titleB: artB?.title || '',
          idA: artA?.id || '',
          idB: artB?.id || '',
          statusA: artA?.publishStatus || '',
          statusB: artB?.publishStatus || '',
          validationA: artA?.validationStatus || '',
          validationB: artB?.validationStatus || '',
          createdByA: artA?.createdByName || '',
          createdByB: artB?.createdByName || '',
          modifiedByA: artA?.lastModifiedByName || '',
          modifiedByB: artB?.lastModifiedByName || ''
        };
      })
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 30);

    setState('dedup.pairs', enrichedPairs);
    setState('dedup.running', null);
    await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: enrichedPairs, [STORAGE_KEYS.DEDUP_AT]: Date.now() });
    if (incompleteBatches || bodyFetchFailures) {
      const reasons = [];
      if (incompleteBatches) reasons.push(`${incompleteBatches} batch(es) truncated`);
      if (bodyFetchFailures) reasons.push(`${bodyFetchFailures} article bodies failed to load`);
      toast(`Found ${enrichedPairs.length} duplicate pairs. ${reasons.join(', ')} — some duplicates may be missing. Re-run to retry.`, 'warning');
    } else {
      toast(`Found ${enrichedPairs.length} duplicate pairs.`, enrichedPairs.length ? 'warning' : 'success');
    }
  } catch (e) {
    toast('Detection failed: ' + e.message, 'error');
    setState('dedup.running', null);
  }
}


async function showMerge(pair) {
  const articles = getState('kb.articles') || [];
  const artA = articles.find(a => String(a.articleNumber) === String(pair.articleA));
  const artB = articles.find(a => String(a.articleNumber) === String(pair.articleB));

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
      temperature: 0.2,
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

