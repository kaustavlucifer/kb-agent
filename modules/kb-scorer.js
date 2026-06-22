import { h, spinner, emptyState, toast, modal, progressBar, multiSelect, renderMarkdown, stickyScrollLayout, createSorter, statsBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { sfGet, sfQueryAll, mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, SCORING_MODEL, MAX_BODY_CHARS, SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, SCORE_GOOD_ENOUGH_THRESHOLD, STORAGE_KEYS, articleUrl, CLOUDS, getCloudFromPt } from '../shared/config.js';
import { SCORING_CRITERIA as CRITERIA, scoreArticle, buildScoringPrompt, parseScoreResponse, fetchArticleBodies, mapArticleRecord } from '../shared/scoring.js';

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

const SCORE_META_FIELDS = [
  'Id', 'KnowledgeArticleId', 'ArticleNumber', 'Title', 'Summary', 'UrlName',
  'PublishStatus', 'ValidationStatus', 'LastPublishedDate', 'LastModifiedDate',
  'Contains_Image__c', 'Contains_Video__c', 'Article_Length__c',
  'ArticleTotalViewCount', 'ArticleCaseAttachCount',
  'Product_And_Topic__r.Name'
].join(', ');





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
}

function handleFocusArticle(articleId) {
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};
  const article = articles.find(a => a.id === articleId);

  if (!article) {
    // Article might not be loaded yet — try from scores alone
    if (scores[articleId]?.overall != null) {
      const stub = { id: articleId, articleNumber: '?', title: 'Article' };
      showScoreDetail(stub, scores[articleId]);
    }
    return;
  }

  // Clear all filters so article is visible in the table
  _filterText = '';
  _filterCloud = [];
  _filterPt = [];
  _filterScore = [];
  _filterValidation = [];
  _filterPublish = [];
  _page = 0;
  render();

  // Show the score detail modal
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
    if (getState('kb.scoring') && _container?.querySelector('.data-table') && _sorter.col !== 'score') {
      updateScoreCellsInPlace();
    } else {
      render();
    }
  }, 100);
}

// kb.scoring transitions (null → active, active → null) must do a FULL render so the
// progress-bar card and disabled "Scoring…" button are drawn/removed. The cheap
// in-place path only handles per-article increments while scoring stays active.
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

  // Update progress bar
  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    const progressLabel = document.getElementById('kb-scoring-label');
    if (progressLabel) progressLabel.textContent = `Scoring: ${scoring.done} / ${scoring.total}`;
    const bar = _container.querySelector('#kb-scoring-card .progress__fill');
    if (bar) bar.style.width = `${pct}%`;
    const barLabel = _container.querySelector('#kb-scoring-card .progress__label');
    if (barLabel) barLabel.textContent = `${pct}%`;
  }

  // Update individual score cells in the table using data-article-id
  const rows = _container.querySelectorAll('.data-table tbody tr[data-article-id]');
  rows.forEach(row => {
    const articleId = row.getAttribute('data-article-id');
    if (!articleId) return;
    const scoreData = scores[articleId];
    const overall = scoreData?.overall;
    const isBeingScored = scoringIds.includes(articleId);

    const scoreTd = row.querySelectorAll('td')[5];
    if (!scoreTd) return;

    scoreTd.textContent = '';
    if (isBeingScored) {
      scoreTd.appendChild(spinner('sm'));
    } else if (overall != null) {
      const article = (getState('kb.articles') || []).find(a => a.id === articleId);
      const pill = h('span', {
        class: `pill pill--${overall >= SCORE_HIGH_THRESHOLD ? 'success' : overall >= SCORE_MID_THRESHOLD ? 'warning' : 'error'}`,
        style: { cursor: 'pointer' },
        onClick: article ? () => showScoreDetail(article, scoreData) : undefined
      }, String(overall));
      scoreTd.appendChild(pill);
    } else {
      scoreTd.appendChild(h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—'));
    }
  });

  // Force full re-render every 10 completions to sync stats bar
  if (scoring && scoring.done % 10 === 0 && scoring.done > 0) {
    setTimeout(render, 50);
  }
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

  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  const ptOptions = [...new Set(articles.map(a => a.topicName).filter(Boolean))].sort();
  const filteredScored = filtered.filter(a => scores[a.id]?.overall != null);
  const filteredAvg = filteredScored.length ? Math.round(filteredScored.reduce((s, a) => s + scores[a.id].overall, 0) / filteredScored.length) : null;

  stickySection.appendChild(statsBar([
    { value: filtered.length, label: filtered.length !== articles.length ? `of ${articles.length} Articles` : 'Articles' },
    { value: `${filteredScored.length}/${filtered.length}`, label: 'Scored', color: 'var(--primary)' },
    filteredAvg != null ? { value: filteredAvg, label: 'Avg Score', color: filteredAvg >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : filteredAvg >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)' } : null,
    filteredScored.length ? { value: filteredScored.filter(a => scores[a.id].overall < SCORE_MID_THRESHOLD).length, label: 'Below 60', color: 'var(--error)' } : null
  ]));

  const validationOptions = [...new Set(articles.map(a => a.validationStatus).filter(Boolean))].sort();

  const searchInput = h('input', { type: 'text', class: 'input', style: { flex: '1', minWidth: '160px', maxWidth: '240px' }, placeholder: 'Search title / article #…', id: 'kb-filter', value: _filterText });
  searchInput.addEventListener('input', e => { _filterText = e.target.value; _page = 0; render(); });
  if (_searchFocused) {
    setTimeout(() => { const el = document.getElementById('kb-filter'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, 0);
  }

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

  const publishOptions = [...new Set(articles.map(a => a.publishStatus).filter(Boolean))].sort();
  const publishMulti = multiSelect('kb-publish-filter', 'Status',
    publishOptions.map(v => ({ value: v, label: v })),
    _filterPublish,
    (sel) => { _filterPublish = sel; _page = 0; render(); }
  );

  const refreshBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: loading }, 'Refresh');
  refreshBtn.addEventListener('click', () => loadArticles(true));
  const totalPages = Math.ceil(filtered.length / _pageSize) || 1;
  if (_page >= totalPages) _page = Math.max(0, totalPages - 1);
  const pageStart = _page * _pageSize;
  const pageArticleCount = Math.min(_pageSize, filtered.length - pageStart);
  const scoreBtnLabel = scoring ? 'Scoring…' : `Score Page (${pageArticleCount})`;
  const scoreBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: loading || !pageArticleCount || !!scoring }, scoreBtnLabel);
  scoreBtn.addEventListener('click', scoreAll);

  const filtersRow = h('div', { class: 'tab-toolbar' },
    searchInput,
    cloudMulti,
    ptMulti,
    scoreMulti,
    valMulti,
    publishMulti,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
      refreshBtn,
      scoreBtn
    )
  );
  stickySection.appendChild(filtersRow);

  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    stickySection.appendChild(h('div', { id: 'kb-scoring-card', class: 'card', style: { marginTop: '8px', padding: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', { id: 'kb-scoring-label' }, `Scoring: ${scoring.done} / ${scoring.total}`),
        h('span', null, `${pct}%`)
      ),
      progressBar(pct, 'default', true)
    ));
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

  const ind = (col) => _sorter.indicator(col);
  // Animate row entrance only when not actively scoring — scoring triggers periodic
  // re-renders, and re-animating rows each time would flicker.
  const table = h('table', { class: scoring ? 'data-table' : 'data-table data-table--animated' },
    h('thead', null, h('tr', null,
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => { toggleKbSort('articleNumber'); } }, '#' + ind('articleNumber')),
      h('th', { style: { cursor: 'pointer' }, onClick: () => { toggleKbSort('title'); } }, 'Title' + ind('title')),
      h('th', { style: { width: '180px', cursor: 'pointer' }, onClick: () => { toggleKbSort('topicName'); } }, 'Product & Topic' + ind('topicName')),
      h('th', { style: { width: '85px', cursor: 'pointer' }, onClick: () => { toggleKbSort('lastPublished'); } }, 'Published' + ind('lastPublished')),
      h('th', { style: { width: '80px', cursor: 'pointer' }, onClick: () => { toggleKbSort('agfHits'); } }, 'AGF' + ind('agfHits')),
      h('th', { style: { width: '60px', cursor: 'pointer' }, onClick: () => { toggleKbSort('score'); } }, 'Score' + ind('score')),
      h('th', { style: { width: '120px' } }, 'Actions')
    )),
    h('tbody', null)
  );

  const tbody = table.querySelector('tbody');
  const pageEnd = pageStart + _pageSize;
  const pageItems = filtered.slice(pageStart, pageEnd);
  const scoringIds = getState('kb.scoringIds') || [];
  pageItems.forEach(a => {
    const scoreData = scores[a.id];
    const overall = scoreData?.overall;
    const isBeingScored = scoringIds.includes(a.id);
    const scoreEl = isBeingScored
      ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, spinner('sm'))
      : overall != null
        ? h('span', { class: `pill pill--${overall >= SCORE_HIGH_THRESHOLD ? 'success' : overall >= SCORE_MID_THRESHOLD ? 'warning' : 'error'}`, style: { cursor: 'pointer' }, onClick: () => showScoreDetail(a, scoreData) }, String(overall))
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
    tbody.appendChild(h('tr', { 'data-article-id': a.id },
      h('td', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px' } },
        h('a', { href: artUrl, target: '_blank', rel: 'noopener', style: { color: 'var(--primary)', textDecoration: 'none' } }, a.articleNumber || '')
      ),
      h('td', null,
        h('div', { style: { fontSize: '12px', fontWeight: '500' } }, a.title || ''),
        a.validationStatus ? h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, a.validationStatus) : null
      ),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, a.topicName || ''),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, pubDate),
      h('td', null, agfEl),
      h('td', null, scoreEl),
      h('td', null,
        h('div', { style: { display: 'flex', gap: '4px' } },
          scoreData?.overall != null
            ? h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '14px', padding: '2px 6px' }, title: 'View score details', onClick: () => showScoreDetail(a, scoreData) }, '👁')
            : null,
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => scoreOne(a) }, scoreData?.overall != null ? 'Rescore' : 'Score'),
          (scoreData?.overall != null && scoreData.overall >= SCORE_GOOD_ENOUGH_THRESHOLD)
            ? h('button', { class: 'btn btn--ghost btn--sm', disabled: true, title: `Already at AGF quality ${scoreData.overall} (≥${SCORE_GOOD_ENOUGH_THRESHOLD}) — no improvement needed` }, 'Rewrite')
            : h('button', { class: 'btn btn--ghost btn--sm', onClick: () => rewriteArticle(a) }, 'Rewrite')
        )
      )
    ));
  });

  scrollSection.appendChild(table);

  const paginationRow = h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '12px' } },
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: _page === 0, onClick: () => { _page--; render(); } }, '← Prev') : null,
    h('span', { style: { color: 'var(--text-secondary)' } },
      totalPages > 1
        ? `Showing ${pageStart + 1}–${pageStart + pageItems.length} of ${filtered.length} articles (Page ${_page + 1}/${totalPages})`
        : `${filtered.length} articles`
    ),
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: _page >= totalPages - 1, onClick: () => { _page++; render(); } }, 'Next →') : null
  );
  scrollSection.appendChild(paginationRow);
}

function showScoreDetail(article, scoreData) {
  if (!scoreData?.criteria) return;
  const body = h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '16px' } },
      h('div', null,
        h('div', { style: { fontSize: '14px', fontWeight: '600' } }, article.title),
        h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, `#${article.articleNumber}`)
      ),
      h('div', { style: { fontSize: '24px', fontWeight: '700', color: scoreData.overall >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : scoreData.overall >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)' } }, String(scoreData.overall))
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

  modal(`Score: ${article.articleNumber}`, body, { wide: true });
}

async function loadArticles(forceLive = false) {
  setState('kb.loading', true);
  try {
    if (!forceLive) {
      const cachedData = await localGet([STORAGE_KEYS.ALL_ARTICLES, STORAGE_KEYS.ALL_ARTICLES_AT]);
      const cachedArticles = cachedData[STORAGE_KEYS.ALL_ARTICLES];
      const cachedAt = cachedData[STORAGE_KEYS.ALL_ARTICLES_AT];
      if (cachedArticles?.length && cachedAt && (Date.now() - cachedAt < 30 * 60 * 1000)) {
        setState('kb.articles', cachedArticles);
        const cachedScores = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
        if (cachedScores[STORAGE_KEYS.ARTICLE_SCORES]) {
          setState('kb.scores', cachedScores[STORAGE_KEYS.ARTICLE_SCORES]);
        }
        toast(`Loaded ${cachedArticles.length} articles (cached).`, 'success');
        setState('kb.loading', false);
        return;
      }
    }

    const session = await detectSession();
    if (!session.sid) { toast('Not connected to Salesforce.', 'error'); setState('kb.loading', false); return; }

    const WHERE = `WHERE PublishStatus IN ('Online','Draft','Archived') AND Language IN ('en_US','en_GB') AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%')`;
    const countResp = await sfGet(
      `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(`SELECT COUNT() FROM Knowledge__kav ${WHERE}`)}`,
      session.sid
    );
    const totalCount = countResp.totalSize || 0;
    setState('kb.loading', { loaded: 0, total: totalCount });

    const records = await sfQueryAll(session.apiBase, session.sid,
      `SELECT ${SCORE_META_FIELDS} FROM Knowledge__kav ${WHERE} ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`,
      (loaded, total) => setState('kb.loading', { loaded, total: total || totalCount })
    );

    const articles = records.map(mapArticleRecord);

    setState('kb.articles', articles);
    await localSet({ [STORAGE_KEYS.ALL_ARTICLES]: articles, [STORAGE_KEYS.ALL_ARTICLES_AT]: Date.now() });

    const cached = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
    if (cached[STORAGE_KEYS.ARTICLE_SCORES]) {
      setState('kb.scores', cached[STORAGE_KEYS.ARTICLE_SCORES]);
    }
    toast(`Loaded ${articles.length} articles.`, 'success');
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  } finally {
    setState('kb.loading', false);
  }
}


function getFilteredArticles() {
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};
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
  return filtered;
}

async function scoreAll() {
  const filtered = getFilteredArticles();
  const pageStart = _page * _pageSize;
  const pageEnd = pageStart + _pageSize;
  const pageArticles = filtered.slice(pageStart, pageEnd);
  const existingScores = getState('kb.scores') || {};
  const toScore = pageArticles.filter(a => existingScores[a.id]?.overall == null);
  if (!toScore.length) { toast('All articles on this page already scored.', 'info'); return; }

  setState('kb.scoring', { done: 0, total: toScore.length });
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); setState('kb.scoring', null); return; }

  const bodyMap = await fetchArticleBodies(toScore.map(a => a.id), session);
  const scores = { ...existingScores };
  const inFlight = new Set();
  // Derive progress from `scores` rather than a counter so retries can't double-count
  // or push `done` past `total` (see scoring retry pass below).
  const countDone = () => toScore.filter(a => scores[a.id]?.overall != null).length;

  await mapWithConcurrency(toScore, SCORE_CONCURRENCY, async (article) => {
    inFlight.add(article.id);
    setState('kb.scoringIds', [...inFlight]);
    const body = bodyMap.get(article.id) || {};
    const enriched = { ...article, ...body };
    try {
      const result = await scoreArticle(enriched);
      scores[article.id] = result;
    } catch (e) {
      scores[article.id] = { overall: null, criteria: [], error: e.message };
    }
    inFlight.delete(article.id);
    setState('kb.scoringIds', [...inFlight]);
    setState('kb.scores', { ...scores });
    setState('kb.scoring', { done: countDone(), total: toScore.length });
  });

  // Retry failed articles once
  const failed = toScore.filter(a => scores[a.id]?.overall == null);
  if (failed.length) {
    await new Promise(r => setTimeout(r, 2000));
    setState('kb.scoring', { done: countDone(), total: toScore.length, retrying: failed.length });
    await mapWithConcurrency(failed, 2, async (article) => {
      inFlight.add(article.id);
      setState('kb.scoringIds', [...inFlight]);
      const body = bodyMap.get(article.id) || {};
      const enriched = { ...article, ...body };
      try {
        const result = await scoreArticle(enriched);
        scores[article.id] = result;
      } catch {}
      inFlight.delete(article.id);
      setState('kb.scoringIds', [...inFlight]);
      setState('kb.scores', { ...scores });
      setState('kb.scoring', { done: countDone(), total: toScore.length, retrying: failed.length });
    });
  }

  await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
  setState('kb.scoring', null);
  setState('kb.scoringIds', []);
  const successCount = toScore.filter(a => scores[a.id]?.overall != null).length;
  const stillFailed = toScore.length - successCount;
  toast(`Scored ${successCount}/${toScore.length} articles.${stillFailed ? ` ${stillFailed} failed.` : ''}`, stillFailed ? 'warning' : 'success');
}

function renderCriterionRow(c, limit = 2) {
  if (c.na) return null;
  // limit caps how many bullet items show per cell (the live-streaming view stays
  // compact with 2; the detail modal passes Infinity to show everything).
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

function tryExtractCriteria(text) {
  const criteriaMatch = text.match(/"criteria"\s*:\s*\[/);
  if (!criteriaMatch) return [];
  const startIdx = text.indexOf('[', criteriaMatch.index);
  const results = [];
  let depth = 0;
  let objStart = -1;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 1) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 1 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.slice(objStart, i + 1));
          results.push(obj);
        } catch {}
        objStart = -1;
      }
    } else if (ch === '[' && depth === 0) { depth = 1; }
  }
  return results;
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
      h('tbody', { id: 'score-criteria-body' },
        ...CRITERIA.map(c => h('tr', { id: `score-row-${c.id}` },
          h('td', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, c.label),
          h('td', null, h('span', { style: { color: 'var(--text-muted)' } }, '…')),
          h('td', null, ''),
          h('td', null, ''),
          h('td', null, '')
        ))
      )
    ),
    h('div', { id: 'score-overall', style: { marginTop: '12px', textAlign: 'center', display: 'none' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Overall Score'),
      h('div', { id: 'score-overall-value', style: { fontSize: '28px', fontWeight: '700' } }, '—')
    )
  );

  modal(`Score: ${article.articleNumber}`, bodyEl, { wide: true });

  // Mark the table row as scoring so it shows a spinner like batch scoring does.
  const markScoring = (on) => {
    const ids = new Set(getState('kb.scoringIds') || []);
    if (on) ids.add(article.id); else ids.delete(article.id);
    setState('kb.scoringIds', [...ids]);
  };
  markScoring(true);

  const bodyMap = await fetchArticleBodies([article.id], session);
  const body = bodyMap.get(article.id) || {};
  const enriched = { ...article, ...body };
  const { system, user, maxes } = buildScoringPrompt(enriched);

  let renderedCount = 0;

  try {
    const fullText = await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 2200,
      temperature: 0.1,
      model: SCORING_MODEL,
      onDelta: (chunk, full) => {
        const parsed = tryExtractCriteria(full);
        if (parsed.length > renderedCount) {
          for (let i = renderedCount; i < parsed.length; i++) {
            const raw = parsed[i];
            const def = CRITERIA.find(c => c.id === raw.id);
            if (!def) continue;
            const effectiveMax = maxes?.[raw.id] ?? def.baseMax;
            const isNa = raw.na === true || effectiveMax === 0;
            const score = isNa ? 0 : Math.min(effectiveMax, Math.max(0, Math.round(Number(raw.score) || 0)));
            const c = {
              id: raw.id, label: def.label, score, max: effectiveMax, na: isNa,
              passed: Array.isArray(raw.passed) ? raw.passed.filter(Boolean) : [],
              issues: Array.isArray(raw.issues) ? raw.issues.filter(Boolean) : [],
              suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.filter(Boolean) : []
            };
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

    const result = parseScoreResponse(fullText, maxes);

    const progressEl = document.getElementById('score-progress');
    if (progressEl) progressEl.style.display = 'none';

    const ctbody = document.getElementById('score-criteria-body');
    if (ctbody && result.criteria) {
      ctbody.textContent = '';
      result.criteria.forEach(c => {
        const row = renderCriterionRow(c);
        if (row) ctbody.appendChild(row);
      });
    }

    const overallEl = document.getElementById('score-overall');
    const overallVal = document.getElementById('score-overall-value');
    if (overallEl && overallVal && result.overall != null) {
      overallEl.style.display = 'block';
      const color = result.overall >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : result.overall >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)';
      overallVal.style.color = color;
      overallVal.textContent = String(result.overall);
    }

    const scores = { ...(getState('kb.scores') || {}), [article.id]: result };
    setState('kb.scores', scores);
    await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
  } catch (e) {
    const progressEl = document.getElementById('score-progress');
    if (progressEl) {
      progressEl.textContent = '';
      progressEl.appendChild(h('span', { style: { color: 'var(--error)', fontSize: '12px' } }, 'Error: ' + e.message));
    }
  } finally {
    markScoring(false);
  }
}

let _rewriteCache = {};

// Fetch the article body and merge it onto the meta record so scoreArticle has the
// full content to score (the table rows only carry metadata).
async function enrichForScore(article, session) {
  const bodyMap = await fetchArticleBodies([article.id], session);
  return { ...article, ...(bodyMap.get(article.id) || {}) };
}

function showNoImprovementNeeded(article, score) {
  let close;
  const body = h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
      h('div', { style: { fontSize: '28px', fontWeight: '700', color: 'var(--success)' } }, String(score)),
      h('div', null,
        h('div', { style: { fontSize: '13px', fontWeight: '600' } }, 'No improvement needed'),
        h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, `#${article.articleNumber} — ${article.title}`)
      )
    ),
    h('p', { style: { fontSize: '12px', lineHeight: '1.5', color: 'var(--text-secondary)', marginBottom: '16px' } },
      `This article already scores ${score}, at or above the good-enough threshold of ${SCORE_GOOD_ENOUGH_THRESHOLD} for Agentforce quality. A rewrite is unlikely to add enough value to justify the effort. You can rewrite anyway if you have a specific reason.`),
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn--secondary btn--sm', onClick: () => { close(); rewriteArticle(article, true); } }, 'Rewrite anyway'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: () => close() }, 'OK')
    )
  );
  ({ close } = modal('Already High Quality', body));
}

async function rewriteArticle(article, forceAfterGate = false) {
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); return; }

  // Score-first gate: if the article hasn't been scored yet, score it before spending a
  // rewrite. If it's already at/above the good-enough threshold, a rewrite is a waste —
  // tell the user and let them override. `forceAfterGate` skips this on explicit override.
  if (!forceAfterGate && !_rewriteCache[article.id]) {
    const existing = getState('kb.scores')?.[article.id];
    let score = existing?.overall;
    if (score == null) {
      toast('Scoring article before rewrite…', 'info');
      try {
        const result = await scoreArticle(await enrichForScore(article, session));
        if (result.overall != null) {
          const scores = { ...(getState('kb.scores') || {}), [article.id]: result };
          setState('kb.scores', scores);
          await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
          score = result.overall;
        }
      } catch { /* fall through to rewrite if scoring fails */ }
    }
    if (score != null && score >= SCORE_GOOD_ENOUGH_THRESHOLD) {
      showNoImprovementNeeded(article, score);
      return;
    }
  }

  const cached = _rewriteCache[article.id];

  const streamEl = h('div', { id: 'rewrite-stream', style: { fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } });
  if (cached) {
    streamEl.appendChild(renderMarkdown(cached));
  } else {
    streamEl.appendChild(spinner('md'));
  }

  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      h('span', null, `#${article.articleNumber} — ${article.title}`),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('div', { id: 'rewrite-score', style: { display: 'flex', alignItems: 'center', gap: '6px' } }),
        h('button', { class: 'btn btn--ghost btn--sm', id: 'rewrite-compare', onClick: () => showRewriteComparison(article) }, 'Compare'),
        h('button', { class: 'btn btn--ghost btn--sm', id: 'rewrite-regenerate', onClick: () => generateRewrite(article, session) }, cached ? 'Regenerate' : 'Generating…'),
        h('button', { class: 'btn btn--primary btn--sm', id: 'rewrite-publish', onClick: () => publishRewriteToOrgcs(article) }, 'Create New Version in ORGCS')
      )
    ),
    streamEl
  );

  modal('Rewrite Article', content, { wide: true });

  if (cached) {
    // Show the cached score if we already scored this rewrite this session.
    const cachedScore = _rewriteScoreCache[article.id];
    if (cachedScore) renderRewriteScore(article, cachedScore);
  } else {
    generateRewrite(article, session);
  }
}

// Parse the streamed "## TITLE/SUMMARY/DESCRIPTION/RESOLUTION" markdown into an
// article-shaped object the scorer understands.
function parseRewriteSections(text) {
  const titleMatch = text.match(/##\s*TITLE\s*\n([^\n]+)/i);
  const summaryMatch = text.match(/##\s*SUMMARY\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  const descMatch = text.match(/##\s*DESCRIPTION\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  const resMatch = text.match(/##\s*RESOLUTION\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  return {
    title: titleMatch?.[1]?.trim() || '',
    summary: summaryMatch?.[1]?.trim() || '',
    description: descMatch?.[1]?.trim() || '',
    resolution: resMatch?.[1]?.trim() || ''
  };
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
  // Markdown ## headers become HTML <h2> in the real article, so the scorer's
  // header/scannability checks see proper structure. We hand it the rewritten body.
  const headerHtml = (label, text) => text ? `<h2>${label}</h2>${text.split('\n').map(l => `<p>${l}</p>`).join('')}` : '';
  const enriched = {
    ...article,
    title: parsed.title || article.title,
    summary: parsed.summary,
    description: headerHtml('Description', parsed.description),
    resolution: headerHtml('Resolution', parsed.resolution),
    steps: ''
  };
  try {
    const result = await scoreArticle(enriched);
    result.title = enriched.title;
    _rewriteScoreCache[article.id] = result;
    renderRewriteScore(article, result);
  } catch (e) {
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
  const color = overall >= SCORE_HIGH_THRESHOLD ? 'success' : overall >= SCORE_MID_THRESHOLD ? 'warning' : 'error';
  scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'New score:'));
  scoreEl.appendChild(h('span', {
    class: `pill pill--${color}`,
    style: { cursor: 'pointer' },
    title: 'View score details',
    onClick: () => showScoreDetail({ ...article, title: result.title || article.title }, result)
  }, String(overall)));
}

async function generateRewrite(article, session) {
  const regenBtn = document.getElementById('rewrite-regenerate');
  if (regenBtn) { regenBtn.disabled = true; regenBtn.textContent = 'Generating…'; }
  const el = document.getElementById('rewrite-stream');
  if (el) { el.textContent = ''; el.appendChild(spinner('md')); }
  // Clear any prior score for this article — it no longer matches the new draft.
  delete _rewriteScoreCache[article.id];
  const scoreEl = document.getElementById('rewrite-score');
  if (scoreEl) scoreEl.textContent = '';

  const bodyMap = await fetchArticleBodies([article.id], session);
  const body = bodyMap.get(article.id) || {};
  const desc = stripHtml(body.description || '').slice(0, MAX_BODY_CHARS);
  const res = stripHtml(body.resolution || '').slice(0, MAX_BODY_CHARS);
  const steps = stripHtml(body.steps || '').slice(0, 1500);

  // This prompt is deliberately aligned with shared/scoring.js criteria so the
  // rewritten article scores well on the same rubric used by the Score action.
  const system = `You are an expert technical writer rewriting Salesforce Knowledge Articles to maximize Agentforce (AGF) RAG retrieval and consumption quality.

HOW AGENTFORCE RETRIEVES CONTENT (optimize for this):
- Articles are chunked at header boundaries (≤512 tokens/chunk). Only the top 5 chunks from 195k+ pieces are retrieved via hybrid (exact + vector) search.
- The title is prepended to every chunk — it drives ALL retrieval.
- Product & Topic tags are NOT used by RAG, so the product name MUST appear in the body text.
- Videos, screenshots, and attachments are ignored — only text and alt-text are indexed.
- Code blocks consume poorly — always explain them in plain text.

REWRITE RULES (each maps to a scored criterion — satisfy ALL):
1. TITLE: ≤60 chars, front-load keywords, include the specific product name, no question format, symptom-based for troubleshooting.
2. SUMMARY: ≤170 chars, use DIFFERENT words/synonyms than the title, specify the audience, include exact error text for error articles.
3. HEADERS: Use ## for each section (renders as <h2>) — NEVER bold text as a header. Make headers descriptive with intent keywords. Keep each section ≤~2000 chars; split with ### if longer.
4. DESCRIPTION: Open with an intent paragraph stating WHAT question this answers and WHY. Explain uncommon acronyms. Present tense. Include the customer's likely phrasing. State the product name explicitly.
5. RESOLUTION: Begin with a brief context paragraph, then numbered steps. Each step is a complete, actionable instruction with its expected outcome. Use realistic Salesforce-format example data (never "xxxxx"). After any code, add a plain-text explanation of what it does.
6. SCANNABILITY: Short paragraphs (3-5 sentences), bulleted/numbered lists, no wall-of-text. Each section must read as a self-contained chunk.
7. NEVER include: internal-only URLs (orgcs.lightning.force.com), screenshot-only solutions, unexplained code, "contact Salesforce support" as a step, PII/credentials, or speculative statements.

Preserve all technical accuracy from the original. Output EXACTLY these four sections and nothing else:
## TITLE
## SUMMARY
## DESCRIPTION
## RESOLUTION`;

  const user = `Rewrite this article:
Title: ${article.title}
Product & Topic: ${article.topicName || '(none)'}
Validation: ${article.validationStatus || 'Not Validated'}

CURRENT SUMMARY: ${article.summary || '(empty)'}
CURRENT DESCRIPTION: ${desc || '(empty)'}
CURRENT RESOLUTION: ${res || '(empty)'}
${steps ? `CURRENT STEPS: ${steps}` : ''}`;

  let fullText = '';
  let throttle = null;
  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      temperature: 0.2,
      onDelta: (chunk, full) => {
        fullText = full;
        if (throttle) return;
        throttle = setTimeout(() => { throttle = null; }, 150);
        const el = document.getElementById('rewrite-stream');
        if (el) { el.textContent = ''; el.appendChild(renderMarkdown(full)); }
      }
    });
    _rewriteCache[article.id] = fullText;
    const el = document.getElementById('rewrite-stream');
    if (el) { el.textContent = ''; el.appendChild(renderMarkdown(fullText)); }
  } catch (e) {
    const el = document.getElementById('rewrite-stream');
    if (el) { el.textContent = ''; el.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + e.message)); }
    if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
    return;
  }
  if (regenBtn) { regenBtn.disabled = false; regenBtn.textContent = 'Regenerate'; }
  // Score the freshly generated article so the user sees its quality immediately.
  if (fullText.trim()) scoreRewrite(article, fullText);
}

async function showRewriteComparison(article) {
  const cached = _rewriteCache[article.id];
  if (!cached) {
    // The regenerate button is disabled for the whole generation lifecycle.
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

    const field = (label, value, opts = {}) => h('div', { style: { marginBottom: '12px' } },
      h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' } }, label),
      opts.markdown
        ? renderMarkdown((value || '(empty)').slice(0, 800))
        : h('div', { style: { fontSize: opts.bold ? '13px' : '12px', fontWeight: opts.bold ? '600' : '400', lineHeight: '1.5', color: opts.color || 'var(--text-primary)', maxHeight: opts.tall ? '200px' : 'none', overflow: opts.tall ? 'auto' : 'visible' } }, (value || '(empty)').slice(0, opts.bold ? 300 : 800))
    );

    const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', maxHeight: '600px', overflow: 'auto' } },
      h('div', null,
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--border)' } }, 'Original'),
        field('Title', original.title, { bold: true }),
        field('Summary', original.summary, { bold: false }),
        field('Description', original.description, { tall: true }),
        field('Resolution', original.resolution, { tall: true })
      ),
      h('div', null,
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--primary)' } }, 'Rewritten'),
        field('Title', parsed.title || article.title, { bold: true, color: 'var(--primary)' }),
        field('Summary', parsed.summary, { bold: false }),
        field('Description', parsed.description, { markdown: true }),
        field('Resolution', parsed.resolution, { markdown: true })
      )
    );

    modal(`Compare: #${article.articleNumber || ''} — ${article.title}`, body, { wide: true });
  } catch (e) {
    toast('Comparison failed: ' + e.message, 'error');
  }
}

async function publishRewriteToOrgcs(article) {
  const cached = _rewriteCache[article.id];
  if (!cached) { toast('No generated content to publish. Generate first.', 'error'); return; }

  const parsed = parseRewriteSections(cached);
  const title = parsed.title || article.title;
  const summary = parsed.summary;
  const sections = [];
  if (parsed.description) sections.push({ heading: 'Description', body: parsed.description });
  if (parsed.resolution) sections.push({ heading: 'Resolution', body: parsed.resolution });

  toast('Creating new draft version in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_UPDATE_DRAFT',
      payload: {
        existingArticleId: article.id,
        title,
        summary,
        sections,
        taxonomyName: article.topicName || null
      }
    });
    if (resp?.success) {
      const actionLabel = resp.action === 'patched-draft' ? 'Existing draft updated!' : 'New draft version created!';
      toast(actionLabel, 'success');
      if (resp.warning) toast(resp.warning, 'warning');
      // Replace the publish button with an explicit "Open" button instead of
      // auto-navigating, so the user stays in context until they choose to leave.
      // Always swap it out on success so the draft can't be created twice.
      const publishBtn = document.getElementById('rewrite-publish');
      if (publishBtn) {
        const openBtn = resp.url
          ? h('button', { class: 'btn btn--primary btn--sm', id: 'rewrite-open', onClick: () => chrome.tabs.create({ url: resp.url }) }, 'Open Draft Version ↗')
          : h('button', { class: 'btn btn--primary btn--sm', id: 'rewrite-open', disabled: true }, 'Draft Created ✓');
        publishBtn.replaceWith(openBtn);
      }
    } else {
      toast(resp?.error || 'Failed to create draft version.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

