import { h, spinner, emptyState, toast, modal, progressBar, multiSelect, renderMarkdown, stickyScrollLayout, createSorter, statusPill, uniqueSortedValues, sectionsEditor, streamingStatus, swapButtonWithLink, markdownStreamThrottle, scoreColor, crossScopeToggle, requestToken, paginationBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { logSignature } from '../shared/signature.js';
import { mapWithConcurrency, stripHtmlKeepLinks, buildPromptContent } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { SCORE_CONCURRENCY, SCORING_MODEL, SCORING_MAX_TOKENS, SCORING_RETRY_MAX_TOKENS, MAX_BODY_CHARS, SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, SCORE_GOOD_ENOUGH_THRESHOLD, STREAM_RENDER_THROTTLE_MS, STORAGE_KEYS, articleUrl, CLOUDS, getCloudFromPt } from '../shared/config.js';
import { SCORING_CRITERIA as CRITERIA, scoreArticle, buildScoringPrompt, parseScoreResponse, normalizeCriterion, enrichArticlesForScoring, draftToScorable, loadAllArticles, searchArticlesUnscoped, SCORING_SYSTEM_CHARS } from '../shared/scoring.js';
import { estimateScoring, fmtUsd } from '../shared/cost.js';
import { previewButton, renderArticleColumn } from '../shared/article-preview.js';
import { parseRewriteSections, markdownToHtml } from '../shared/markdown.js';
import { confirmDraftOverwriteIfExists, publishDraftUpdate, sectionsToPublishArray } from '../shared/draft-publish.js';
import { GUIDE_GENERATION, GUIDE_STYLE } from '../data/writing_guide_prompts.js';

let _container = null;
let _unsubs = [];
let _filterText = '';
let _filterCloud = [];
let _filterPt = [];
let _filterScore = [];
let _filterValidation = ['Validated External'];
let _filterPublish = ['Online'];
const _sorter = createSorter('articleNumber', 'asc');
let _page = 0;
const _pageSize = 50;
let _agfHits = null;
let _searchDebounce = null;
let _crossScope = false;
let _crossResults = [];
let _crossLoading = false;
const _crossSearchToken = requestToken();

function findArticle(id) {
  const articles = getState('kb.articles') || [];
  return articles.find(a => a.id === id) || _crossResults.find(a => a.id === id);
}

function allKnownArticles() {
  return [...(getState('kb.articles') || []), ..._crossResults];
}

const rewriteSectionsEditor = sectionsEditor({
  getCachedText: (article) => _rewriteCache[article.id] || '',
  setCachedText: (article, text) => { _rewriteCache[article.id] = text; },
  fields: [
    { field: 'title', label: 'Title', plain: true },
    { field: 'summary', label: 'Summary', plain: true },
    { field: 'description', label: 'Description', rows: 12 },
    { field: 'resolution', label: 'Resolution', rows: 16 }
  ],
  deriveDefaults: (article, parsed) => ({ ...parsed, title: parsed.title || article.title })
});



function toggleKbSort(col) {
  _sorter.toggle(col);
  render();
}

export function mount(container) {
  _container = container;
  _wasScoring = !!getState('kb.scoring');
  if (!getState('kb.articles')) {
    setState('kb.articles', []);
    setState('kb.scores', {});
    setState('kb.loading', false);
    setState('kb.scoring', null);
    setState('kb.scoringIds', []);
    loadArticles();
  }
  if (!_agfHits) loadAgfHits();
  render();
  _unsubs.push(subscribe('kb.articles', render));
  _unsubs.push(subscribe('kb.scores', debouncedRender));
  _unsubs.push(subscribe('kb.loading', render));
  _unsubs.push(subscribe('kb.scoring', onScoringChange));
  _unsubs.push(subscribe('kb.scoringIds', debouncedRender));
  _unsubs.push(subscribe('kb.focusArticle', (articleId) => {
    if (!articleId) return;
    setState('kb.focusArticle', null);
    handleFocusArticle(articleId);
  }));

  const pendingFocus = getState('kb.focusArticle');
  if (pendingFocus) {
    setState('kb.focusArticle', null);
    setTimeout(() => handleFocusArticle(pendingFocus), 300);
  }
}

async function loadAgfHits() {
  try {
    const url = chrome.runtime.getURL('data/agf_article_hits.json');
    const resp = await fetch(url);
    _agfHits = await resp.json();
    render();
  } catch { _agfHits = {}; }
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
  if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
  if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
  if (_rewriteAbort) { _rewriteAbort.abort(); _rewriteAbort = null; }
}

function handleFocusArticle(articleId) {
  const scores = getState('kb.scores') || {};
  const article = findArticle(articleId);

  if (!article) {
    if (scores[articleId]?.overall != null) {
      const stub = { id: articleId, articleNumber: '?', title: 'Article' };
      showScoreDetail(stub, scores[articleId]);
    }
    return;
  }

  _filterText = '';
  _filterCloud = [];
  _filterPt = [];
  _filterScore = [];
  _filterValidation = [];
  _filterPublish = [];
  _page = 0;
  render();

  if (scores[article.id]?.overall != null) {
    showScoreDetail(article, scores[article.id]);
  } else {
    scoreOne(article);
  }
}

let _searchFocused = false;
let _renderTimer = null;
let _wasScoring = false;
function debouncedRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    if (getState('kb.scoring') && _container?.querySelector('.data-table')) {
      updateScoreCellsInPlace();
    } else {
      render();
    }
  }, 100);
}

function onScoringChange(scoring) {
  const isScoring = !!scoring;
  if (isScoring !== _wasScoring) {
    _wasScoring = isScoring;
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
    render();
    return;
  }
  debouncedRender();
}

function updateScoreCellsInPlace() {
  const scores = getState('kb.scores') || {};
  const scoringIds = getState('kb.scoringIds') || [];
  const scoring = getState('kb.scoring');
  const articleById = new Map(allKnownArticles().map(a => [a.id, a]));

  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    const progressLabel = document.getElementById('kb-scoring-label');
    if (progressLabel) progressLabel.textContent = `Scoring: ${scoring.done} / ${scoring.total}${scoring.retrying ? ` (retrying ${scoring.retrying})` : ''}`;
    const pctLabel = document.getElementById('kb-scoring-pct');
    if (pctLabel) pctLabel.textContent = `${pct}%`;
    const bar = _container.querySelector('#kb-scoring-card .progress__fill');
    if (bar) bar.style.width = `${pct}%`;
    const barLabel = _container.querySelector('#kb-scoring-card .progress__label');
    if (barLabel) barLabel.textContent = `${pct}%`;
    const activeEl = document.getElementById('kb-scoring-active');
    if (activeEl) {
      const activeNumbers = scoringIds
        .map(id => articleById.get(id)?.articleNumber)
        .filter(Boolean);
      activeEl.textContent = '';
      if (activeNumbers.length) {
        activeEl.appendChild(spinner('sm'));
        activeEl.appendChild(h('span', null, `Scoring now: ${activeNumbers.join(', ')}`));
      }
    }
  }

  const rows = _container.querySelectorAll('.data-table tbody tr[data-article-id]');
  rows.forEach(row => {
    const articleId = row.getAttribute('data-article-id');
    if (!articleId) return;
    const scoreData = scores[articleId];
    const overall = scoreData?.overall;
    const isBeingScored = scoringIds.includes(articleId);
    row.style.background = isBeingScored ? 'var(--primary-subtle, rgba(0,112,210,0.08))' : '';

    const scoreTd = row.querySelectorAll('td')[5];
    if (!scoreTd) return;

    scoreTd.textContent = '';
    if (isBeingScored) {
      scoreTd.appendChild(spinner('sm'));
    } else if (overall != null) {
      const article = articleById.get(articleId);
      const pill = h('span', {
        class: `pill pill--${scoreColor(overall)}`,
        style: { cursor: 'pointer' },
        onClick: article ? () => showScoreDetail(article, scoreData) : undefined
      }, String(overall));
      scoreTd.appendChild(pill);
    } else {
      scoreTd.appendChild(h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—'));
    }
  });
}

function render() {
  if (!_container) return;
  _searchFocused = document.activeElement?.id === 'kb-filter';
  _container.textContent = '';
  const loading = getState('kb.loading');
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};
  const scoring = getState('kb.scoring');
  const filtered = getFilteredArticles();
  const crossMode = _crossScope && _filterText.trim().length >= 2;
  const activeList = crossMode ? _crossResults : filtered;

  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  const filterOptions = getFilterOptionLists(articles);
  const ptOptions = filterOptions.topicName;
  const filteredScored = filtered.filter(a => scores[a.id]?.overall != null);
  const filteredAvg = filteredScored.length ? Math.round(filteredScored.reduce((s, a) => s + scores[a.id].overall, 0) / filteredScored.length) : null;

  const validationOptions = filterOptions.validationStatus;

  const searchInput = h('input', { type: 'text', class: 'input', style: { flex: '1', minWidth: '160px', maxWidth: '240px' }, placeholder: 'Search title / article #…', id: 'kb-filter', value: _filterText });
  searchInput.addEventListener('input', e => {
    _filterText = e.target.value;
    _page = 0;
    clearTimeout(_searchDebounce);
    if (_crossScope) _searchDebounce = setTimeout(() => runCrossSearch(_filterText), 300);
    else _searchDebounce = setTimeout(render, 200);
  });
  if (_searchFocused) {
    setTimeout(() => { const el = document.getElementById('kb-filter'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, 0);
  }

  const crossScopeLabel = crossScopeToggle({
    label: 'Search all clouds',
    title: 'Search ALL clouds/products, not just the ones loaded by default — use this to find and score/rewrite an article outside the usual scope.',
    checked: _crossScope,
    onChange: (checked) => {
      _crossScope = checked;
      _page = 0;
      if (_crossScope) {
        if (_filterText.trim().length >= 2) runCrossSearch(_filterText);
        else render();
      } else {
        _crossSearchToken.next();
        _crossResults = [];
        render();
      }
    }
  });

  const cloudMulti = multiSelect('kb-cloud-filter', 'Cloud',
    CLOUDS.map(c => ({ value: c, label: c })),
    _filterCloud,
    (sel) => { _filterCloud = sel; _page = 0; render(); }
  );

  const ptMulti = multiSelect('kb-pt-filter', 'Product & Topic',
    ptOptions.map(pt => ({ value: pt, label: pt })),
    _filterPt,
    (sel) => { _filterPt = sel; _page = 0; render(); }
  );

  const scoreMulti = multiSelect('kb-score-filter', 'Score',
    [
      { value: 'high', label: '≥ 80 (Good)' },
      { value: 'mid', label: '60-79 (OK)' },
      { value: 'low', label: '< 60 (Poor)' },
      { value: 'unscored', label: 'Unscored' }
    ],
    _filterScore,
    (sel) => { _filterScore = sel; _page = 0; render(); }
  );

  const valMulti = multiSelect('kb-val-filter', 'Validation',
    validationOptions.map(v => ({ value: v, label: v })),
    _filterValidation,
    (sel) => { _filterValidation = sel; _page = 0; render(); }
  );

  const publishOptions = filterOptions.publishStatus;
  const publishMulti = multiSelect('kb-publish-filter', 'Status',
    publishOptions.map(v => ({ value: v, label: v })),
    _filterPublish,
    (sel) => { _filterPublish = sel; _page = 0; render(); }
  );

  const refreshBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: loading }, 'Refresh');
  refreshBtn.addEventListener('click', () => loadArticles(true));
  const totalPages = Math.ceil(activeList.length / _pageSize) || 1;
  if (_page >= totalPages) _page = Math.max(0, totalPages - 1);
  const pageStart = _page * _pageSize;
  const pageItemsForCount = activeList.slice(pageStart, pageStart + _pageSize);
  const unscoredPageItems = pageItemsForCount.filter(a => scores[a.id]?.overall == null);
  const unscoredOnPage = unscoredPageItems.length;
  const scoreBtnLabel = scoring ? 'Scoring…' : `Score Page (${unscoredOnPage})`;
  const scoreBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: loading || !unscoredOnPage || !!scoring }, scoreBtnLabel);
  scoreBtn.addEventListener('click', scoreAll);

  const scoreEst = unscoredOnPage && !scoring ? estimateScoring(unscoredPageItems, SCORING_SYSTEM_CHARS) : null;
  const estHint = scoreEst
    ? h('span', {
        style: { fontSize: '11px', color: 'var(--text-muted)', alignSelf: 'center' },
        title: `${scoreEst.calls} calls · ~${scoreEst.inputTokens.toLocaleString()} in / ~${scoreEst.outputTokens.toLocaleString()} out tokens at current scoring model`
      }, `est. ~${fmtUsd(scoreEst.costUsd)}`)
    : null;

  const filtersRow = h('div', { class: 'tab-toolbar' },
    searchInput,
    crossScopeLabel,
    cloudMulti,
    ptMulti,
    scoreMulti,
    valMulti,
    publishMulti,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      estHint,
      refreshBtn,
      scoreBtn
    )
  );
  stickySection.appendChild(filtersRow);

  if (!_crossScope) {
    const avgPart = filteredAvg != null ? ` · Avg Score ${filteredAvg}` : '';
    const belowPart = filteredScored.length ? ` · ${filteredScored.filter(a => scores[a.id].overall < SCORE_MID_THRESHOLD).length} Below 60` : '';
    stickySection.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', margin: '8px 0 0' } },
      `${filtered.length !== articles.length ? `${filtered.length} of ${articles.length}` : `${articles.length}`} Articles · ${filteredScored.length}/${filtered.length} Scored${avgPart}${belowPart}`
    ));
  }

  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    const scoringIds = getState('kb.scoringIds') || [];
    const activeNumbers = scoringIds
      .map(id => findArticle(id)?.articleNumber)
      .filter(Boolean);
    stickySection.appendChild(h('div', { id: 'kb-scoring-card', class: 'card', style: { marginTop: '8px', padding: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', { id: 'kb-scoring-label' }, scoring.phase === 'fetching' ? 'Fetching article bodies…' : `Scoring: ${scoring.done} / ${scoring.total}${scoring.retrying ? ` (retrying ${scoring.retrying})` : ''}`),
        h('span', { id: 'kb-scoring-pct' }, `${pct}%`)
      ),
      progressBar(pct, 'default', true),
      h('div', { id: 'kb-scoring-active', style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', minHeight: '16px' } },
        ...(scoring.phase === 'fetching'
          ? [spinner('sm'), h('span', null, 'Loading content from Salesforce…')]
          : activeNumbers.length
            ? [spinner('sm'), h('span', null, `Scoring now: ${activeNumbers.join(', ')}`)]
            : []))
    ));
  }

  if (crossMode && _crossLoading) {
    scrollSection.appendChild(h('div', { style: { padding: '48px 24px', textAlign: 'center' } }, spinner('lg'),
      h('div', { style: { fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' } }, 'Searching all clouds…')));
    return;
  }

  if (loading) {
    const progress = typeof loading === 'object' ? loading : null;
    scrollSection.appendChild(h('div', { style: { padding: '48px 24px', maxWidth: '400px', margin: '0 auto' } },
      h('div', { style: { textAlign: 'center', marginBottom: '16px' } },
        spinner('lg'),
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginTop: '12px', color: 'var(--text-primary)' } }, 'Loading Knowledge Articles'),
        h('div', { style: { fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' } }, progress ? 'Fetching from Salesforce…' : 'Connecting…')
      ),
      progress && progress.total > 0 ? h('div', null,
        progressBar(Math.round((progress.loaded / progress.total) * 100), 'default', true),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' } },
          h('span', null, `${progress.loaded.toLocaleString()} articles loaded`),
          h('span', null, `${progress.total.toLocaleString()} total`)
        )
      ) : null
    ));
    return;
  }

  if (!articles.length) {
    scrollSection.appendChild(emptyState('📄', 'No articles loaded. Click Refresh to fetch from Salesforce.'));
    return;
  }

  const ind = (col) => _sorter.indicator(col);
  const table = h('table', { class: scoring ? 'data-table' : 'data-table data-table--animated' },
    h('thead', null, h('tr', null,
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => { toggleKbSort('articleNumber'); } }, '#' + ind('articleNumber')),
      h('th', { style: { cursor: 'pointer' }, onClick: () => { toggleKbSort('title'); } }, 'Title' + ind('title')),
      h('th', { style: { width: '180px', cursor: 'pointer' }, onClick: () => { toggleKbSort('topicName'); } }, 'Product & Topic' + ind('topicName')),
      h('th', { style: { width: '85px', cursor: 'pointer' }, onClick: () => { toggleKbSort('lastPublished'); } }, 'Published' + ind('lastPublished')),
      h('th', { style: { width: '80px', cursor: 'pointer' }, onClick: () => { toggleKbSort('agfHits'); } }, 'AGF' + ind('agfHits')),
      h('th', { style: { width: '60px', cursor: 'pointer' }, onClick: () => { toggleKbSort('score'); } }, 'Score' + ind('score')),
      h('th', { style: { width: '170px' } }, 'Actions')
    )),
    h('tbody', null)
  );

  const tbody = table.querySelector('tbody');
  const pageEnd = pageStart + _pageSize;
  const pageItems = activeList.slice(pageStart, pageEnd);
  const scoringIds = getState('kb.scoringIds') || [];
  pageItems.forEach(a => {
    const scoreData = scores[a.id];
    const overall = scoreData?.overall;
    const isBeingScored = scoringIds.includes(a.id);
    const scoreEl = isBeingScored
      ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, spinner('sm'))
      : overall != null
        ? h('span', { class: `pill pill--${scoreColor(overall)}`, style: { cursor: 'pointer' }, onClick: () => showScoreDetail(a, scoreData) }, String(overall))
        : h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—');

    const pubDate = a.lastPublished ? new Date(a.lastPublished).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—';
    const agf = _agfHits?.[a.articleNumber];
    const hasAnyMetric = agf || a.viewCount || a.caseAttachCount;
    const agfEl = hasAnyMetric ? h('div', { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' } },
      agf ? h('span', { class: 'pill pill--neutral', style: { fontSize: '9px', padding: '1px 4px' }, title: 'AGF conversations citing this article' }, `${agf.agfHits} hits`) : null,
      a.viewCount ? h('span', { class: 'pill pill--neutral', style: { fontSize: '9px', padding: '1px 4px' }, title: 'Total article views' }, `${a.viewCount} views`) : null,
      a.caseAttachCount ? h('span', { class: 'pill pill--neutral', style: { fontSize: '9px', padding: '1px 4px' }, title: 'Cases linked to article' }, `${a.caseAttachCount} cases`) : null
    ) : h('span', { style: { color: 'var(--text-muted)', fontSize: '10px' } }, '—');

    const artUrl = articleUrl(a.id);
    tbody.appendChild(h('tr', { 'data-article-id': a.id, style: isBeingScored ? { background: 'var(--primary-subtle, rgba(0,112,210,0.08))' } : {} },
      h('td', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px' } },
        h('a', { href: artUrl, target: '_blank', rel: 'noopener', style: { color: 'var(--primary)', textDecoration: 'none' } }, a.articleNumber || '')
      ),
      h('td', null,
        h('div', { style: { fontSize: '12px', fontWeight: '500' } }, a.title || ''),
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' } },
          statusPill(a.publishStatus, { fontSize: '9px', padding: '1px 5px' }),
          a.validationStatus ? h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, a.validationStatus) : null
        )
      ),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, a.topicName || ''),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, pubDate),
      h('td', null, agfEl),
      h('td', null, scoreEl),
      h('td', null,
        h('div', { style: { display: 'flex', gap: '4px' } },
          previewButton(a.id, { articleNumber: a.articleNumber, title: a.title }),
          scoreData?.overall != null
            ? h('button', { class: 'btn btn--ghost btn--sm', title: 'View score details and rescore', onClick: () => showScoreDetail(a, scoreData) }, 'Score')
            : h('button', { class: 'btn btn--ghost btn--sm', onClick: () => scoreOne(a) }, 'Score'),
          h('button', {
            class: 'btn btn--ghost btn--sm',
            title: (scoreData?.overall != null && scoreData.overall >= SCORE_GOOD_ENOUGH_THRESHOLD)
              ? `Already at AGF quality ${scoreData.overall} (≥${SCORE_GOOD_ENOUGH_THRESHOLD}) — rewrite only if you have a specific reason`
              : 'Rewrite this article to improve AGF quality',
            onClick: () => rewriteArticle(a)
          }, 'Rewrite')
        )
      )
    ));
  });

  const paginationRow = paginationBar({
    page: _page, totalPages, pageStart, pageCount: pageItems.length, total: activeList.length, noun: 'articles',
    prefix: crossMode ? 'Live search across all clouds — ' : '',
    onPage: (p) => { _page = p; render(); }
  });
  scrollSection.appendChild(h('div', { class: 'card', style: { padding: '16px' } }, table, paginationRow));
}

function showScoreDetail(article, scoreData, { fromRewrite = false } = {}) {
  if (!scoreData?.criteria) return;
  let close;

  const body = h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', gap: '12px' } },
      h('div', null,
        h('div', { style: { fontSize: '14px', fontWeight: '600' } }, article.title),
        h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, `#${article.articleNumber}`)
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
        h('div', { style: { fontSize: '24px', fontWeight: '700', color: `var(--${scoreColor(scoreData.overall)})` } }, String(scoreData.overall)),
        fromRewrite ? null : h('button', { class: 'btn btn--secondary btn--sm', onClick: () => { close(); scoreOne(article); } }, 'Rescore')
      )
    )
  );

  const criteriaTable = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Criterion'),
      h('th', { style: { width: '70px' } }, 'Score'),
      h('th', null, 'Passed'),
      h('th', null, 'Issues'),
      h('th', null, 'Suggestions')
    )),
    h('tbody', null)
  );
  const ctbody = criteriaTable.querySelector('tbody');
  scoreData.criteria.forEach(c => {
    const row = renderCriterionRow(c, Infinity);
    if (row) ctbody.appendChild(row);
  });
  body.appendChild(criteriaTable);

  ({ close } = modal(`Score: ${article.articleNumber}`, body, { wide: true, stack: fromRewrite }));
}

async function runCrossSearch(query) {
  if (!query || query.trim().length < 2) { _crossResults = []; render(); return; }
  const token = _crossSearchToken.next();
  _crossLoading = true;
  render();
  try {
    const session = await detectSession();
    if (!session.sid) { if (_crossSearchToken.isCurrent(token)) { toast('No SF session.', 'error'); _crossResults = []; } return; }
    const results = await searchArticlesUnscoped(query.trim(), session);
    if (!_crossSearchToken.isCurrent(token)) return;
    _crossResults = results;
  } catch (e) {
    if (!_crossSearchToken.isCurrent(token)) return;
    toast('Search failed: ' + e.message, 'error');
    _crossResults = [];
  } finally {
    if (_crossSearchToken.isCurrent(token)) {
      _crossLoading = false;
      render();
    }
  }
}

async function loadArticles(forceLive = false) {
  setState('kb.loading', true);
  try {
    const { articles, error, fromCache } = await loadAllArticles({
      forceLive,
      onProgress: (p) => setState('kb.loading', p)
    });
    if (error) { toast(error, 'error'); return; }

    setState('kb.articles', articles);
    const cachedScores = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
    if (cachedScores[STORAGE_KEYS.ARTICLE_SCORES]) {
      setState('kb.scores', cachedScores[STORAGE_KEYS.ARTICLE_SCORES]);
    }
    toast(`Loaded ${articles.length} articles${fromCache ? ' (cached)' : ''}.`, 'success');
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  } finally {
    setState('kb.loading', false);
  }
}


let _filterOptionsMemo = null;

function getFilterOptionLists(articles) {
  if (_filterOptionsMemo && _filterOptionsMemo.articles === articles) {
    return _filterOptionsMemo.result;
  }
  const result = {
    topicName: uniqueSortedValues(articles, 'topicName'),
    validationStatus: uniqueSortedValues(articles, 'validationStatus'),
    publishStatus: uniqueSortedValues(articles, 'publishStatus')
  };
  _filterOptionsMemo = { articles, result };
  return result;
}

let _filteredMemo = null;

function getFilteredArticles() {
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};
  const signature = `${_filterText}|${_filterCloud.join(',')}|${_filterPt.join(',')}|${_filterScore.join(',')}|${_filterValidation.join(',')}|${_filterPublish.join(',')}|${_sorter.col}|${_sorter.dir}|${_agfHits ? 1 : 0}`;
  if (_filteredMemo && _filteredMemo.articles === articles && _filteredMemo.scores === scores && _filteredMemo.signature === signature) {
    return _filteredMemo.result;
  }

  let filtered = [...articles];
  if (_filterCloud.length) filtered = filtered.filter(a => _filterCloud.includes(getCloudFromPt(a.topicName)));
  if (_filterText) {
    const term = _filterText.toLowerCase();
    filtered = filtered.filter(a => `${a.title || ''} ${a.articleNumber || ''} ${a.topicName || ''} ${a.summary || ''} ${a.knowledgeArticleId || ''}`.toLowerCase().includes(term));
  }
  if (_filterPt.length) filtered = filtered.filter(a => _filterPt.includes(a.topicName));
  if (_filterValidation.length) filtered = filtered.filter(a => _filterValidation.includes(a.validationStatus));
  if (_filterPublish.length) filtered = filtered.filter(a => _filterPublish.includes(a.publishStatus));
  if (_filterScore.length) filtered = filtered.filter(a => {
    const s = scores[a.id]?.overall;
    return _filterScore.some(range => {
      if (range === 'high') return (s ?? -1) >= SCORE_HIGH_THRESHOLD;
      if (range === 'mid') return s != null && s >= SCORE_MID_THRESHOLD && s < SCORE_HIGH_THRESHOLD;
      if (range === 'low') return s != null && s < SCORE_MID_THRESHOLD;
      if (range === 'unscored') return s == null;
      return false;
    });
  });
  const sortCol = _sorter.col;
  filtered.sort((a, b) => {
    let va, vb;
    if (sortCol === 'score') {
      va = scores[a.id]?.overall ?? -1;
      vb = scores[b.id]?.overall ?? -1;
    } else if (sortCol === 'agfHits') {
      va = _agfHits?.[a.articleNumber]?.agfHits ?? 0;
      vb = _agfHits?.[b.articleNumber]?.agfHits ?? 0;
    } else if (sortCol === 'lastPublished') {
      va = a.lastPublished || '';
      vb = b.lastPublished || '';
    } else {
      va = (a[sortCol] || '').toLowerCase();
      vb = (b[sortCol] || '').toLowerCase();
    }
    return _sorter.compare(va, vb);
  });
  _filteredMemo = { articles, scores, signature, result: filtered };
  return filtered;
}

const BODY_FETCH_ERROR = 'Could not load the article body from Salesforce. Try again.';
const SCORE_PERSIST_THROTTLE_MS = 2000;

function updateScoringIds(add = [], remove = []) {
  const ids = new Set(getState('kb.scoringIds') || []);
  add.forEach(id => ids.add(id));
  remove.forEach(id => ids.delete(id));
  setState('kb.scoringIds', [...ids]);
}

function persistScores() {
  return localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: getState('kb.scores') || {} });
}

async function scoreAll() {
  const crossMode = _crossScope && _filterText.trim().length >= 2;
  const filtered = crossMode ? _crossResults : getFilteredArticles();
  const pageStart = _page * _pageSize;
  const pageEnd = pageStart + _pageSize;
  const pageArticles = filtered.slice(pageStart, pageEnd);
  const existingScores = getState('kb.scores') || {};
  const toScore = pageArticles.filter(a => existingScores[a.id]?.overall == null);
  if (!toScore.length) { toast('All articles on this page already scored.', 'info'); return; }

  setState('kb.scoring', { done: 0, total: toScore.length, phase: 'fetching' });
  const batchResults = {};
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persistScores().catch(() => {}); }, SCORE_PERSIST_THROTTLE_MS);
  };

  try {
    const session = await detectSession();
    if (!session.sid) { toast('No SF session.', 'error'); return; }

    const { enriched, failedIds } = await enrichArticlesForScoring(toScore, session);
    const settled = () => toScore.filter(a => batchResults[a.id]?.overall != null).length;
    const commit = (id, result) => {
      batchResults[id] = result;
      setState('kb.scores', { ...(getState('kb.scores') || {}), [id]: result });
      if (result.overall != null) {
        logSignature('article-scored', session.apiBase, session.sid, id);
        schedulePersist();
      }
    };
    toScore.filter(a => failedIds.has(a.id)).forEach(a => commit(a.id, { overall: null, criteria: [], error: BODY_FETCH_ERROR }));
    const scorable = toScore.filter(a => enriched.has(a.id));

    setState('kb.scoring', { done: 0, total: toScore.length });
    await mapWithConcurrency(scorable, SCORE_CONCURRENCY, async (article) => {
      updateScoringIds([article.id]);
      let result;
      try {
        result = await scoreArticle(enriched.get(article.id));
      } catch (e) {
        result = { overall: null, criteria: [], error: e.message };
      }
      updateScoringIds([], [article.id]);
      commit(article.id, result);
      setState('kb.scoring', { done: settled(), total: toScore.length });
    });

    const failed = scorable.filter(a => batchResults[a.id]?.overall == null);
    if (failed.length) {
      setState('kb.scoring', { done: settled(), total: toScore.length, retrying: failed.length });
      await new Promise(r => setTimeout(r, 2000));
      await mapWithConcurrency(failed, 2, async (article) => {
        updateScoringIds([article.id]);
        try {
          const result = await scoreArticle(enriched.get(article.id), SCORING_RETRY_MAX_TOKENS);
          commit(article.id, result);
        } catch {}
        updateScoringIds([], [article.id]);
        setState('kb.scoring', { done: settled(), total: toScore.length, retrying: failed.length });
      });
    }

    const successCount = settled();
    const stillFailed = toScore.length - successCount;
    toast(`Scored ${successCount}/${toScore.length} articles.${stillFailed ? ` ${stillFailed} failed.` : ''}`, stillFailed ? 'warning' : 'success');
  } catch (e) {
    toast('Scoring failed: ' + e.message, 'error');
  } finally {
    if (persistTimer) clearTimeout(persistTimer);
    await persistScores().catch(() => {});
    setState('kb.scoring', null);
    updateScoringIds([], toScore.map(a => a.id));
  }
}

function renderCriterionRow(c, limit = 2) {
  if (c.na) return null;
  const colorPill = `pill pill--${c.score >= c.max * 0.8 ? 'success' : c.score >= c.max * 0.5 ? 'warning' : 'error'}`;
  const bulletCell = (items, color) => h('td', { style: { fontSize: '11px', maxWidth: '200px' } },
    (items || []).length
      ? h('div', null, ...items.slice(0, limit).map(t => h('div', { style: { marginBottom: '2px', color } }, '• ' + t)))
      : h('span', { style: { color: 'var(--text-muted)' } }, '—')
  );
  return h('tr', null,
    h('td', { style: { fontWeight: '500', fontSize: '12px' } }, c.label || c.id),
    h('td', null, h('span', { class: colorPill }, `${c.score}/${c.max}`)),
    bulletCell(c.passed, 'var(--success)'),
    bulletCell(c.issues, 'var(--error)'),
    bulletCell(c.suggestions, 'var(--primary)')
  );
}

function criteriaStreamParser() {
  const results = [];
  let pos = -1;
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  return (text) => {
    if (pos < 0) {
      const criteriaMatch = text.match(/"criteria"\s*:\s*\[/);
      if (!criteriaMatch) return results;
      pos = text.indexOf('[', criteriaMatch.index);
    }
    for (; pos < text.length; pos++) {
      const ch = text[pos];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; }
      else if (ch === '{') { if (depth === 1) objStart = pos; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 1 && objStart >= 0) {
          try {
            results.push(JSON.parse(text.slice(objStart, pos + 1)));
          } catch {}
          objStart = -1;
        }
      } else if (ch === '[' && depth === 0) { depth = 1; }
    }
    return results;
  };
}

function criteriaPlaceholderRows() {
  return CRITERIA.map(c => h('tr', { id: `score-row-${c.id}` },
    h('td', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, c.label),
    h('td', null, h('span', { style: { color: 'var(--text-muted)' } }, '…')),
    h('td', null, ''),
    h('td', null, ''),
    h('td', null, '')
  ));
}

async function scoreOne(article) {
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); return; }

  const bodyEl = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } }, `Scoring: #${article.articleNumber} — ${article.title}`),
    h('div', { id: 'score-progress', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' } },
      spinner('sm'),
      h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, 'Evaluating article quality…')
    ),
    h('table', { class: 'data-table', id: 'score-criteria-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Criterion'),
        h('th', { style: { width: '80px' } }, 'Score'),
        h('th', null, 'Passed'),
        h('th', null, 'Issues'),
        h('th', null, 'Suggestions')
      )),
      h('tbody', { id: 'score-criteria-body' }, ...criteriaPlaceholderRows())
    ),
    h('div', { id: 'score-overall', style: { marginTop: '12px', textAlign: 'center', display: 'none' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Overall Score'),
      h('div', { id: 'score-overall-value', style: { fontSize: '28px', fontWeight: '700' } }, '—')
    )
  );

  const abort = new AbortController();
  let closed = false;
  modal(`Score: ${article.articleNumber}`, bodyEl, {
    wide: true,
    onClose: () => { closed = true; abort.abort(); }
  });

  updateScoringIds([article.id]);

  const setProgress = (text, mode) => {
    const progressEl = document.getElementById('score-progress');
    if (!progressEl) return;
    progressEl.textContent = '';
    progressEl.style.display = 'flex';
    if (mode === 'spin') {
      progressEl.appendChild(spinner('sm'));
      progressEl.appendChild(h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, text));
    } else {
      progressEl.appendChild(h('span', { style: { color: mode, fontSize: '12px' } }, text));
    }
  };

  const resetCriteriaRows = () => {
    const ctbody = document.getElementById('score-criteria-body');
    if (!ctbody) return;
    ctbody.textContent = '';
    criteriaPlaceholderRows().forEach(row => ctbody.appendChild(row));
  };

  let system, user, maxes;
  const attempt = async (maxTokens) => {
    let renderedCount = 0;
    const extractCriteria = criteriaStreamParser();
    resetCriteriaRows();
    const fullText = await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      temperature: 0.1,
      model: SCORING_MODEL,
      cache: true,
      signal: abort.signal,
      onDelta: (chunk, full) => {
        if (closed) return;
        const parsed = extractCriteria(full);
        if (parsed.length > renderedCount) {
          for (let i = renderedCount; i < parsed.length; i++) {
            const raw = parsed[i];
            const def = CRITERIA.find(c => c.id === raw.id);
            if (!def) continue;
            const c = normalizeCriterion(raw, def, maxes);
            const row = document.getElementById(`score-row-${c.id}`);
            if (row) {
              const newRow = renderCriterionRow(c);
              if (newRow) {
                newRow.id = `score-row-${c.id}`;
                row.replaceWith(newRow);
              } else {
                row.style.display = 'none';
              }
            }
          }
          renderedCount = parsed.length;
        }
      }
    });
    return parseScoreResponse(fullText, maxes);
  };

  const budgets = [SCORING_MAX_TOKENS, SCORING_RETRY_MAX_TOKENS];

  try {
    const { enriched, failedIds } = await enrichArticlesForScoring([article], session, abort.signal);
    if (closed) return;
    if (failedIds.has(article.id)) { setProgress(BODY_FETCH_ERROR, 'var(--error)'); return; }
    ({ system, user, maxes } = buildScoringPrompt(enriched.get(article.id)));

    let result = null;
    for (let i = 0; i < budgets.length; i++) {
      if (i > 0) setProgress('Response was incomplete — retrying with a larger budget…', 'spin');
      try {
        result = await attempt(budgets[i]);
      } catch (e) {
        if (closed || e.name === 'AbortError') return;
        if (i === budgets.length - 1) throw e;
        result = null;
        continue;
      }
      if (closed) return;
      if (result.overall != null) break;
    }

    if (!result || result.overall == null) {
      setProgress('Scoring could not complete after retry. Try Rescore again.', 'var(--error)');
      return;
    }

    const progressEl = document.getElementById('score-progress');
    if (progressEl) progressEl.style.display = 'none';

    const ctbody = document.getElementById('score-criteria-body');
    if (ctbody) {
      ctbody.textContent = '';
      result.criteria.forEach(c => {
        const row = renderCriterionRow(c);
        if (row) ctbody.appendChild(row);
      });
    }

    const overallEl = document.getElementById('score-overall');
    const overallVal = document.getElementById('score-overall-value');
    if (overallEl && overallVal) {
      overallEl.style.display = 'block';
      overallVal.style.color = `var(--${scoreColor(result.overall)})`;
      overallVal.textContent = String(result.overall);
    }

    const scores = { ...(getState('kb.scores') || {}), [article.id]: result };
    setState('kb.scores', scores);
    await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
    logSignature('article-scored', session.apiBase, session.sid, article.id);
  } catch (e) {
    if (closed || e.name === 'AbortError') return;
    setProgress('Error: ' + e.message, 'var(--error)');
  } finally {
    updateScoringIds([], [article.id]);
  }
}

let _rewriteCache = {};
let _rewriteAbort = null;
let _rewriteRefineApplied = {};
let _rewriteSource = {};

async function loadRewriteSource(article, session, signal) {
  if (_rewriteSource[article.id]) return _rewriteSource[article.id];
  const { enriched, failedIds } = await enrichArticlesForScoring([article], session, signal);
  if (failedIds.has(article.id)) throw new Error(BODY_FETCH_ERROR);
  _rewriteSource[article.id] = enriched.get(article.id);
  return _rewriteSource[article.id];
}

function showRefineInput() {
  const el = document.getElementById('rewrite-refine');
  if (el) el.style.display = '';
}

function renderAppliedRefine(article) {
  const host = document.getElementById('rewrite-applied');
  if (!host) return;
  host.textContent = '';
  const applied = _rewriteRefineApplied[article.id];
  if (!applied) { host.style.display = 'none'; return; }
  host.style.display = '';
  host.appendChild(h('div', {
    style: {
      display: 'flex', gap: '8px', alignItems: 'flex-start',
      padding: '8px 10px', marginBottom: '12px', borderRadius: '6px',
      background: 'var(--primary-soft)', border: '1px solid var(--border)'
    }
  },
    h('div', { style: { flex: '1', minWidth: '0' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.03em' } }, 'Applied as context'),
      h('div', { style: { fontSize: '12px', color: 'var(--text-primary)', lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, applied)
    ),
    h('button', {
      class: 'btn btn--ghost btn--sm',
      title: 'Remove these instructions and stop applying them on regenerate',
      style: { padding: '2px 6px', lineHeight: '1', flexShrink: '0' },
      onClick: () => { delete _rewriteRefineApplied[article.id]; renderAppliedRefine(article); }
    }, '✕')
  ));
}

async function rewriteArticle(article) {
  const cached = _rewriteCache[article.id];

  const streamEl = h('div', { id: 'rewrite-stream', style: { fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } });
  if (cached) streamEl.appendChild(renderMarkdown(cached));
  else streamingStatus(streamEl, 'Preparing rewrite…');

  const regenBtn = h('button', { class: 'btn btn--ghost btn--sm', id: 'rewrite-regenerate', disabled: !cached, onClick: () => generateRewrite(article, _rwSession) }, cached ? 'Regenerate' : 'Generating…');

  let _rwSession = null;

  const refineInput = h('textarea', {
    id: 'rewrite-refine',
    class: 'input',
    rows: '2',
    placeholder: 'Optional: extra instructions for the rewrite (e.g. "keep the SOQL example", "target admins", "shorten the resolution"). Applied when you regenerate.',
    style: { width: '100%', marginBottom: '12px', fontSize: '12px', resize: 'vertical', display: 'none' }
  });

  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      h('span', null, `#${article.articleNumber} — ${article.title}`),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('div', { id: 'rewrite-score', style: { display: 'flex', alignItems: 'center', gap: '6px' } }),
        h('button', { class: 'btn btn--ghost btn--sm', id: 'rewrite-compare', onClick: () => showRewriteComparison(article) }, 'Compare'),
        regenBtn,
        h('button', { class: 'btn btn--primary btn--sm', id: 'rewrite-publish', onClick: () => publishRewriteToOrgcs(article) }, 'Create New Version in ORGCS')
      )
    ),
    h('div', { id: 'rewrite-applied', style: { display: 'none' } }),
    refineInput,
    streamEl
  );

  let closed = false;
  modal('Rewrite Article', content, {
    wide: true,
    onClose: () => { closed = true; if (_rewriteAbort) { _rewriteAbort.abort(); _rewriteAbort = null; } }
  });

  renderAppliedRefine(article);

  if (cached) {
    showRefineInput();
    renderEditableRewrite(article);
    const cachedScore = _rewriteScoreCache[article.id];
    if (cachedScore) renderRewriteScore(article, cachedScore);
    return;
  }

  const session = await detectSession();
  if (closed) return;
  if (!session.sid) {
    streamEl.textContent = '';
    streamEl.appendChild(h('span', { style: { color: 'var(--error)', fontSize: '12px' } }, 'No Salesforce session.'));
    return;
  }
  _rwSession = session;

  const existing = getState('kb.scores')?.[article.id];
  let score = existing?.overall;
  if (score == null) {
    streamingStatus(streamEl, 'Scoring this article before rewrite…');
    try {
      const result = await scoreArticle(await loadRewriteSource(article, session));
      if (closed) return;
      if (result.overall != null) {
        const scores = { ...(getState('kb.scores') || {}), [article.id]: result };
        setState('kb.scores', scores);
        await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
        score = result.overall;
      }
    } catch {}
  }
  if (closed) return;
  if (score != null && score >= SCORE_GOOD_ENOUGH_THRESHOLD) {
    showRefineInput();
    regenBtn.disabled = false;
    regenBtn.textContent = 'Regenerate';
    streamEl.textContent = '';
    streamEl.appendChild(h('div', { style: { padding: '4px 0' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
        h('div', { style: { fontSize: '22px', fontWeight: '700', color: 'var(--success)' } }, String(score)),
        h('div', null,
          h('div', { style: { fontSize: '13px', fontWeight: '600' } }, 'Already high quality'),
          h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' } },
            `This article scores ${score}, at or above the good-enough threshold of ${SCORE_GOOD_ENOUGH_THRESHOLD}. A rewrite may add little value — but you can add instructions above and rewrite anyway.`)
        )
      ),
      h('button', { class: 'btn btn--secondary btn--sm', onClick: () => generateRewrite(article, session) }, 'Rewrite anyway')
    ));
    return;
  }

  if (closed) return;
  generateRewrite(article, session);
}

function renderEditableRewrite(article) {
  const el = document.getElementById('rewrite-stream');
  if (!el) return;
  el.textContent = '';

  el.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '10px' } },
    'Each section renders with full formatting. Click Edit to change a section inline — changes are used when you publish to ORGCS, and are sent as the current article state if you regenerate.'));

  rewriteSectionsEditor.renderInto(el, article);
}

let _rewriteScoreCache = {};

async function scoreRewrite(article, fullText) {
  const scoreEl = document.getElementById('rewrite-score');
  if (scoreEl) {
    scoreEl.textContent = '';
    scoreEl.appendChild(spinner('sm'));
    scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Scoring…'));
  }
  const parsed = parseRewriteSections(fullText);
  const enriched = {
    ...article,
    ...draftToScorable({
      title: parsed.title || article.title,
      summary: parsed.summary,
      description: parsed.description,
      resolution: parsed.resolution,
      topicName: article.topicName,
      validationStatus: article.validationStatus
    })
  };
  try {
    const result = await scoreArticle(enriched);
    if (_rewriteCache[article.id] !== fullText) return;
    result.title = enriched.title;
    _rewriteScoreCache[article.id] = result;
    renderRewriteScore(article, result);
  } catch (e) {
    if (_rewriteCache[article.id] !== fullText) return;
    if (scoreEl) {
      scoreEl.textContent = '';
      scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--error)' } }, 'Score failed'));
    }
  }
}

function renderRewriteScore(article, result) {
  const scoreEl = document.getElementById('rewrite-score');
  if (!scoreEl || result?.overall == null) return;
  scoreEl.textContent = '';
  const overall = result.overall;
  const color = scoreColor(overall);
  scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'New score:'));
  scoreEl.appendChild(h('span', {
    class: `pill pill--${color}`,
    style: { cursor: 'pointer' },
    title: 'View score details',
    onClick: () => showScoreDetail({ ...article, title: result.title || article.title }, result, { fromRewrite: true })
  }, String(overall)));
}

function buildScoreDiagnostics(result) {
  if (!result || !Array.isArray(result.criteria)) return '';
  const weak = result.criteria.filter(c => !c.na && c.score < c.max);
  if (!weak.length) return '';
  const lines = weak
    .sort((a, b) => (a.score / a.max) - (b.score / b.max))
    .map(c => {
      const problems = [...(c.issues || []), ...(c.suggestions || [])].filter(Boolean);
      if (!problems.length) return `- ${c.label} (${c.score}/${c.max}): below max — strengthen this criterion.`;
      return `- ${c.label} (${c.score}/${c.max}): ${problems.join('; ')}`;
    });
  return `THIS ARTICLE SCORED ${result.overall}/100. Fix these specific, already-diagnosed weaknesses (lowest-scoring first) as your top priority — do not regress the criteria that already pass:\n${lines.join('\n')}`;
}

async function generateRewrite(article, session) {
  if (_rewriteAbort) _rewriteAbort.abort();
  const abort = new AbortController();
  _rewriteAbort = abort;

  const regenBtn = document.getElementById('rewrite-regenerate');
  if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = 'Generating…'; }
  const el = document.getElementById('rewrite-stream');
  if (el) { el.textContent = ''; el.appendChild(spinner('md')); }
  delete _rewriteScoreCache[article.id];
  const scoreEl = document.getElementById('rewrite-score');
  if (scoreEl) scoreEl.textContent = '';

  if (!session?.sid) {
    session = await detectSession();
    if (_rewriteAbort !== abort || abort.signal.aborted) return;
    if (!session.sid) {
      if (el) { el.textContent = ''; el.appendChild(h('span', { style: { color: 'var(--error)' } }, 'No Salesforce session.')); }
      if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
      return;
    }
  }

  const priorRewrite = _rewriteCache[article.id] ? parseRewriteSections(_rewriteCache[article.id]) : null;
  const fromEdited = !!(priorRewrite && (priorRewrite.description || priorRewrite.resolution || priorRewrite.summary));

  const isStale = () => _rewriteAbort !== abort || abort.signal.aborted;
  const showError = (message) => {
    const target = document.getElementById('rewrite-stream');
    if (target) { target.textContent = ''; target.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + message)); }
    if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
  };

  let source;
  try {
    source = await loadRewriteSource(article, session, abort.signal);
  } catch (e) {
    if (_rewriteAbort === abort) _rewriteAbort = null;
    if (!isStale() && e.name !== 'AbortError') showError(e.message);
    return;
  }
  if (isStale()) return;
  const chatterNotes = source.chatterNotes || '';

  let currentTitle, currentSummary, desc, res, steps;
  if (fromEdited) {
    currentTitle = priorRewrite.title || article.title;
    currentSummary = priorRewrite.summary || '';
    desc = priorRewrite.description.slice(0, MAX_BODY_CHARS);
    res = priorRewrite.resolution.slice(0, MAX_BODY_CHARS);
    steps = '';
  } else {
    currentTitle = article.title;
    currentSummary = article.summary || '';
    desc = stripHtmlKeepLinks(source.description || '', session.apiBase).slice(0, MAX_BODY_CHARS);
    res = stripHtmlKeepLinks(source.resolution || '', session.apiBase).slice(0, MAX_BODY_CHARS);
    steps = stripHtmlKeepLinks(source.steps || '', session.apiBase).slice(0, 1500);
  }

  const system = `You are an expert technical writer rewriting Salesforce Knowledge Articles to maximize Agentforce (AGF) RAG retrieval and consumption quality.

HOW AGENTFORCE RETRIEVES CONTENT (optimize for this):
- Articles are chunked at header boundaries (≤512 tokens/chunk). Only the top 5 chunks from 195k+ pieces are retrieved via hybrid (exact + vector) search.
- The title is prepended to every chunk — it drives ALL retrieval.
- Product & Topic tags are NOT used by RAG, so the product name MUST appear in the body text.
- Videos, screenshots, and attachments are ignored — only text and alt-text are indexed.
- Code blocks consume poorly — always explain them in plain text.

${GUIDE_GENERATION}

${GUIDE_STYLE}

ADDITIONAL REWRITE-SPECIFIC RULES (not covered above, or overriding above where noted — satisfy ALL):
- TITLE OVERRIDE: ≤60 chars, front-load the searchable keywords, no question format, symptom-based for troubleshooting articles (describe the observed behavior, not the fix).
- SUMMARY OVERRIDE: ≤170 chars, use DIFFERENT words/synonyms than the title (do not restate it), include the exact error text verbatim for error articles.
- HEADERS FORMAT: Use ## for each section (renders as <h2>) — NEVER bold text as a header. Keep each section ≤~2000 chars; split with ### if longer.
- RESOLUTION: Each numbered step must be a complete, actionable instruction that also states its expected outcome.
- SCANNABILITY: Short paragraphs (3-5 sentences), bulleted/numbered lists for steps, no wall-of-text — each section must read as a self-contained chunk.
- LINK HYGIENE OVERRIDE: NEVER add an "Additional Resources", "References", "See Also", or "Related Links" section unless the ORIGINAL article body contains real, valid hyperlinks you can carry over verbatim, and even then stay within the 4-link budget. Do NOT invent links and do NOT emit "search Salesforce Help for X"-style placeholder bullets — a resources section with no genuine hyperlink is noise; omit it entirely.
- IMAGES: The original article's images appear inline as ![alt text](url), and where possible the actual image is attached below the article text so you can see what it shows — use the real visual content, not just the alt text, to judge relevance. If an image is genuinely informative (a screenshot of the exact error/dialog, an annotated diagram) keep it by reproducing its EXACT ![alt](url) markdown at the equivalent point in the rewrite — never alter the URL, never invent a new image, never describe an image in prose instead of keeping the markdown reference. Drop only images that are purely decorative or no longer relevant to the rewritten content.
- NEVER include: internal-only URLs (orgcs.lightning.force.com), screenshot-only solutions, unexplained code, PII, credentials, or speculative statements.

Preserve all technical accuracy from the original. Output EXACTLY these four sections and nothing else:
## TITLE
## SUMMARY
## DESCRIPTION
## RESOLUTION`;

  const diagnostics = buildScoreDiagnostics(getState('kb.scores')?.[article.id]);
  const refineInput = document.getElementById('rewrite-refine');
  const typed = (refineInput?.value || '').trim().slice(0, 1000);
  if (typed) {
    const prior = _rewriteRefineApplied[article.id];
    _rewriteRefineApplied[article.id] = (prior ? `${prior}\n${typed}` : typed).slice(-2000);
    if (refineInput) refineInput.value = '';
    renderAppliedRefine(article);
  }
  const refine = _rewriteRefineApplied[article.id] || '';

  const user = `Rewrite this article:
Title: ${currentTitle}
Product & Topic: ${article.topicName || '(none)'}
Validation: ${article.validationStatus || 'Not Validated'}
${fromEdited ? 'The content below is the CURRENT working version (a prior rewrite with any manual edits applied). Treat it as the article state to improve — preserve the edits unless a rewrite rule or the instructions below require changing them.\n' : ''}${diagnostics ? `\n${diagnostics}\n` : ''}${refine ? `\nADDITIONAL USER INSTRUCTIONS (follow these while still satisfying every rewrite rule above): ${refine}\n` : ''}${chatterNotes ? `\nRELATED CHATTER NOTES (internal context only — factual/technical input from SMEs on this article, if any; use only if genuinely relevant, ignore automated or irrelevant notes):\n${chatterNotes}\n` : ''}
CURRENT SUMMARY: ${currentSummary || '(empty)'}
CURRENT DESCRIPTION: ${desc || '(empty)'}
CURRENT RESOLUTION: ${res || '(empty)'}
${steps ? `CURRENT STEPS: ${steps}` : ''}`;

  let fullText = '';
  const renderThrottled = markdownStreamThrottle('rewrite-stream', STREAM_RENDER_THROTTLE_MS, isStale);
  try {
    const content = await buildPromptContent(user, session, abort.signal);
    if (isStale()) return;
    await streamClaude({
      system,
      messages: [{ role: 'user', content }],
      maxTokens: 4000,
      temperature: 0.2,
      signal: abort.signal,
      onDelta: (chunk, full) => {
        fullText = full;
        renderThrottled(full);
      }
    });
    if (isStale()) return;
    _rewriteCache[article.id] = fullText;
    logSignature('rewrite-generated', session.apiBase, session.sid, article.id);
    renderEditableRewrite(article);
  } catch (e) {
    if (isStale() || e.name === 'AbortError') return;
    showError(e.message);
    return;
  } finally {
    if (_rewriteAbort === abort) _rewriteAbort = null;
  }
  if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
  if (fullText.trim()) { showRefineInput(); scoreRewrite(article, fullText); }
}

async function showRewriteComparison(article) {
  const cached = _rewriteCache[article.id];
  if (!cached) {
    const streaming = document.getElementById('rewrite-regenerate')?.disabled;
    toast(streaming ? 'Wait for the rewrite to finish.' : 'Generate the rewrite first.', 'error');
    return;
  }
  const parsed = parseRewriteSections(cached);

  toast('Loading original article…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'FETCH_ARTICLE_PREVIEW', articleId: article.id });
    if (!resp?.success) { toast(resp?.error || 'Failed to load original.', 'error'); return; }
    const original = resp.article;
    const rewritten = {
      title: parsed.title || article.title,
      summary: parsed.summary || '',
      descriptionHtml: parsed.description ? markdownToHtml(parsed.description) : '',
      resolutionHtml: parsed.resolution ? markdownToHtml(parsed.resolution) : ''
    };

    const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', maxHeight: '70vh', overflow: 'auto' } },
      h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--border)' } }, 'Original'),
        renderArticleColumn(original, { compact: true })
      ),
      h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--primary)' } }, 'Rewritten'),
        renderArticleColumn(rewritten, { compact: true })
      )
    );

    modal(`Compare: #${article.articleNumber || ''} — ${article.title}`, body, { wide: true, stack: true });
  } catch (e) {
    toast('Comparison failed: ' + e.message, 'error');
  }
}

async function publishRewriteToOrgcs(article) {
  const cached = _rewriteCache[article.id];
  if (!cached) { toast('No generated content to publish. Generate first.', 'error'); return; }

  const btn = document.getElementById('rewrite-publish');
  const btnOriginalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }

  const restoreButton = () => { if (btn) { btn.disabled = false; btn.textContent = btnOriginalLabel; } };

  try {
    const parsed = parseRewriteSections(cached);
    const proceed = await confirmDraftOverwriteIfExists(article.id, 'this rewrite');
    if (!proceed) { restoreButton(); return; }

    const resp = await publishDraftUpdate({
      existingArticleId: article.id,
      title: parsed.title || article.title,
      summary: parsed.summary,
      sections: sectionsToPublishArray(parsed),
      taxonomyName: article.topicName || null
    });
    if (resp?.success) {
      swapButtonWithLink('rewrite-publish', { url: resp.url, label: 'Open Draft Version ↗' });
      delete _rewriteCache[article.id];
      delete _rewriteScoreCache[article.id];
      delete _rewriteRefineApplied[article.id];
      delete _rewriteSource[article.id];
      await localSet({ [STORAGE_KEYS.ALL_ARTICLES_AT]: 0 });
      const session = await detectSession();
      if (session.sid) logSignature('rewrite-published', session.apiBase, session.sid, article.id);
    } else {
      restoreButton();
    }
  } catch (e) {
    restoreButton();
    toast('Publish failed: ' + e.message, 'error');
  }
}

