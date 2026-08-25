import { h, spinner, emptyState, toast, modal, confirmModal, progressBar, multiSelect, stickyScrollLayout, statusPill, uniqueSortedValues, editableRichField, renderMarkdown } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { DEDUP_CONCURRENCY, MAX_BODY_CHARS, STORAGE_KEYS, CLOUDS, getCloudFromPt, articleUrl } from '../shared/config.js';
import { runDedupBatch, buildDedupWorkQueue, dedupePairs } from '../shared/dedup.js';
import { fetchArticleBodies, loadAllArticles } from '../shared/scoring.js';
import { estimateDedup, fmtUsd } from '../shared/cost.js';
import { previewButton, showArticleCompare } from '../shared/article-preview.js';
import { parseRewriteSections, serializeRewriteSections } from '../shared/markdown.js';

let _container = null;
let _unsubs = [];
let _filterCloud = [];
let _filterPt = [];
let _filterValidation = ['Validated External', 'Validated Internal'];
let _filterPublish = ['Online'];
let _articlesLoading = false;
let _mergeTextCache = {};
let _mergeAbort = null;

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
  const viewBtn = id ? previewButton(id, { articleNumber: number, title }) : null;
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
        h('td', null, h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '200px' } }, pair.reason || '')),
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


function mergeKeyFor(pair) {
  return [String(pair.articleA), String(pair.articleB)].sort().join('_');
}

async function loadMergeCache() {
  const data = await localGet([STORAGE_KEYS.MERGE_CACHE]);
  return data[STORAGE_KEYS.MERGE_CACHE] || {};
}

async function saveMergeText(mergeKey, text) {
  const cache = await loadMergeCache();
  cache[mergeKey] = text;
  await localSet({ [STORAGE_KEYS.MERGE_CACHE]: cache });
}

function setMergeStatus(el, message) {
  if (!el) return;
  el.textContent = '';
  el.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' } },
    spinner('sm'),
    h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, message)
  ));
}

function currentMergeSections(mergeKey) {
  return parseRewriteSections(_mergeTextCache[mergeKey] || '');
}

function commitMergeSection(mergeKey, key, value) {
  const sections = currentMergeSections(mergeKey);
  sections[key] = value.trim();
  const text = serializeRewriteSections(sections);
  _mergeTextCache[mergeKey] = text;
  saveMergeText(mergeKey, text);
}

function renderMergeSection(mergeKey, key, label, opts = {}) {
  return editableRichField({
    label,
    getValue: () => currentMergeSections(mergeKey)[key] || '',
    setValue: (v) => commitMergeSection(mergeKey, key, v),
    plain: !!opts.plain,
    singleLine: key === 'title',
    rows: opts.rows || 2
  });
}

function renderEditableMerge(mergeKey) {
  const el = document.getElementById('merge-stream');
  if (!el) return;
  el.textContent = '';
  el.appendChild(renderMergeSection(mergeKey, 'title', 'Title', { plain: true }));
  el.appendChild(renderMergeSection(mergeKey, 'summary', 'Summary', { plain: true, rows: 3 }));
  el.appendChild(renderMergeSection(mergeKey, 'description', 'Description', { rows: 10 }));
  el.appendChild(renderMergeSection(mergeKey, 'resolution', 'Resolution', { rows: 14 }));
}

async function generateMerge(pair, mergeKey) {
  if (_mergeAbort) _mergeAbort.abort();
  const abort = new AbortController();
  _mergeAbort = abort;

  const regenBtn = document.getElementById('merge-regenerate');
  if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = 'Generating…'; }
  const streamEl = document.getElementById('merge-stream');
  setMergeStatus(streamEl, 'Generating merge…');

  const articles = getState('kb.articles') || [];
  const artA = articles.find(a => String(a.articleNumber) === String(pair.articleA));
  const artB = articles.find(a => String(a.articleNumber) === String(pair.articleB));

  const session = await detectSession();
  if (abort.signal.aborted) return;
  if (!session.sid) {
    const el = document.getElementById('merge-stream');
    if (el) { el.textContent = ''; el.appendChild(h('span', { style: { color: 'var(--error)' } }, 'No Salesforce session.')); }
    if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
    return;
  }

  let descA = '', resA = '', descB = '', resB = '';
  if (artA && artB) {
    const bodyMap = await fetchArticleBodies([artA.id, artB.id], session);
    if (abort.signal.aborted) return;
    descA = stripHtml(bodyMap.get(artA.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resA = stripHtml(bodyMap.get(artA.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
    descB = stripHtml(bodyMap.get(artB.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resB = stripHtml(bodyMap.get(artB.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
  }

  const system = `You are an expert Salesforce Knowledge editor. Merge two duplicate articles into one optimal article following the Agentforce Writing Guide. Output EXACTLY these four sections and nothing else:
## TITLE
## SUMMARY
## DESCRIPTION
## RESOLUTION`;

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

  let fullText = '';
  const isStale = () => _mergeAbort !== abort || abort.signal.aborted;
  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      temperature: 0.2,
      signal: abort.signal,
      onDelta: (chunk, full) => {
        fullText = full;
        if (isStale()) return;
        const el = document.getElementById('merge-stream');
        if (el) { el.textContent = ''; el.appendChild(renderMarkdown(full)); }
      }
    });
    if (isStale()) return;
    _mergeTextCache[mergeKey] = fullText;
    await saveMergeText(mergeKey, fullText);
    renderEditableMerge(mergeKey);
  } catch (e) {
    if (isStale() || e.name === 'AbortError') return;
    const el = document.getElementById('merge-stream');
    if (el) { el.textContent = ''; el.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + e.message)); }
  } finally {
    if (_mergeAbort === abort) _mergeAbort = null;
  }
  const regenBtn2 = document.getElementById('merge-regenerate');
  if (regenBtn2) { regenBtn2.disabled = false; regenBtn2.textContent = 'Regenerate'; }
}

function replaceMergePublishButtons(url) {
  const btn = document.getElementById('merge-publish');
  if (btn) {
    const openBtn = h('button', { class: 'btn btn--primary btn--sm', onClick: () => chrome.tabs.create({ url }) }, 'Open in ORGCS ↗');
    btn.replaceWith(openBtn);
  }
  document.getElementById('merge-create-new')?.remove();
}

async function publishMergedUpdate(pair, mergeKey, keepSelect) {
  const text = _mergeTextCache[mergeKey];
  if (!text) { toast('Generate the merge first.', 'error'); return; }
  const parsed = parseRewriteSections(text);
  const articles = getState('kb.articles') || [];
  const target = articles.find(a => String(a.articleNumber) === String(keepSelect.value));
  if (!target) { toast('Could not resolve the article to update.', 'error'); return; }

  const draftCheck = await chrome.runtime.sendMessage({ action: 'CHECK_DRAFT_EXISTS', payload: { existingArticleId: target.id } });
  if (draftCheck?.hasDraft) {
    const proceed = await confirmModal(
      'Existing Draft Found',
      'A draft version of this article already exists. Replace its content with this merge, or leave the existing draft as is?',
      { confirmLabel: 'Replace Draft Content', cancelLabel: 'Leave As Is' }
    );
    if (!proceed) { toast('Publish cancelled — existing draft left unchanged.', 'info'); return; }
  }

  const sections = [];
  if (parsed.description) sections.push({ heading: 'Description', body: parsed.description });
  if (parsed.resolution) sections.push({ heading: 'Resolution', body: parsed.resolution });

  toast('Creating new draft version in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_UPDATE_DRAFT',
      payload: {
        existingArticleId: target.id,
        title: parsed.title,
        summary: parsed.summary,
        sections,
        taxonomyName: pair.ptName || target.topicName || null
      }
    });
    if (resp?.success) {
      const actionLabel = (resp.action === 'patched-draft' || resp.action === 'updated-existing-draft') ? 'Existing draft updated!' : 'New draft version created!';
      toast(actionLabel, 'success');
      if (resp.warning) toast(resp.warning, 'warning');
      if (resp.url) replaceMergePublishButtons(resp.url);
    } else {
      toast(resp?.error || 'Failed to create draft version.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function publishMergedNew(pair, mergeKey) {
  const text = _mergeTextCache[mergeKey];
  if (!text) { toast('Generate the merge first.', 'error'); return; }
  const parsed = parseRewriteSections(text);
  const sections = [];
  if (parsed.description) sections.push({ heading: 'Description', body: parsed.description });
  if (parsed.resolution) sections.push({ heading: 'Resolution', body: parsed.resolution });

  toast('Creating article in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_NEW_ARTICLE',
      payload: { title: parsed.title, summary: parsed.summary, sections, taxonomyName: pair.ptName || null }
    });
    if (resp?.success) {
      toast('Article created!', 'success');
      if (resp.url) replaceMergePublishButtons(resp.url);
    } else {
      toast(resp?.error || 'Failed to create article.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function showMerge(pair) {
  const mergeKey = mergeKeyFor(pair);
  if (_mergeTextCache[mergeKey] == null) {
    const cache = await loadMergeCache();
    _mergeTextCache[mergeKey] = cache[mergeKey] || '';
  }

  const streamEl = h('div', { id: 'merge-stream', style: { fontSize: '13px', lineHeight: '1.6', maxHeight: '460px', overflowY: 'auto' } });

  const keepSelect = h('select', { id: 'merge-keep-select', class: 'input', style: { fontSize: '11px', padding: '3px 6px', width: 'auto' } },
    h('option', { value: String(pair.articleA) }, `Update #${pair.articleA}`),
    h('option', { value: String(pair.articleB) }, `Update #${pair.articleB}`)
  );
  keepSelect.value = String(pair.keepArticle || pair.articleA);

  const hasCached = !!_mergeTextCache[mergeKey];
  const regenBtn = h('button', { class: 'btn btn--ghost btn--sm', id: 'merge-regenerate', disabled: !hasCached, onClick: () => generateMerge(pair, mergeKey) }, hasCached ? 'Regenerate' : 'Generating…');
  const updateBtn = h('button', { class: 'btn btn--primary btn--sm', id: 'merge-publish', onClick: () => publishMergedUpdate(pair, mergeKey, keepSelect) }, 'Create New Version in ORGCS');
  const createNewBtn = h('button', { class: 'btn btn--ghost btn--sm', id: 'merge-create-new', onClick: () => publishMergedNew(pair, mergeKey) }, 'Create as New Instead');

  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } },
      h('div', null, h('strong', null, 'A: '), `#${pair.articleA} — ${pair.titleA}`),
      h('div', null, h('strong', null, 'B: '), `#${pair.articleB} — ${pair.titleB}`),
      h('div', { style: { marginTop: '4px', fontStyle: 'italic' } }, `AI suggests keeping: #${pair.keepArticle} | ${pair.reason}`)
    ),
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' } },
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, keepSelect, updateBtn, createNewBtn),
      regenBtn
    ),
    streamEl
  );

  modal('Merge Suggestion', content, {
    wide: true,
    onClose: () => { if (_mergeAbort) { _mergeAbort.abort(); _mergeAbort = null; } }
  });

  if (hasCached) {
    renderEditableMerge(mergeKey);
  } else {
    generateMerge(pair, mergeKey);
  }
}

