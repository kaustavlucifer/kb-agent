import { h, spinner, emptyState, toast, modal, progressBar, multiSelect, renderMarkdown } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { sfGet, sfQueryAll, mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, SCORING_MODEL, MAX_BODY_CHARS, SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, STORAGE_KEYS, articleUrl } from '../shared/config.js';
import { SCORING_CRITERIA as CRITERIA, scoreArticle, buildScoringPrompt, parseScoreResponse, fetchArticleBodies, mapArticleRecord } from '../shared/scoring.js';

let _container = null;
let _unsubs = [];
let _filterText = '';
let _filterCloud = [];
let _filterPt = [];
let _filterScore = [];
let _filterValidation = ['Validated External'];
let _filterPublish = ['Online'];
let _sortCol = 'articleNumber';
let _sortDir = 'asc';
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
  if (_sortCol === col) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  else { _sortCol = col; _sortDir = 'asc'; }
  render();
}

export function mount(container) {
  _container = container;
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
  _unsubs.push(subscribe('kb.scoring', debouncedRender));
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
function debouncedRender() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    if (getState('kb.scoring') && _container?.querySelector('.data-table') && _sortCol !== 'score') {
      updateScoreCellsInPlace();
    } else {
      render();
    }
  }, 100);
}

function updateScoreCellsInPlace() {
  const scores = getState('kb.scores') || {};
  const scoringIds = getState('kb.scoringIds') || [];
  const scoring = getState('kb.scoring');

  // Update progress bar
  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    const progressLabel = _container.querySelector('.main__sticky .card:last-child span');
    if (progressLabel) progressLabel.textContent = `Scoring: ${scoring.done} / ${scoring.total}`;
    const bar = _container.querySelector('.progress__fill');
    if (bar) bar.style.width = `${pct}%`;
    const barLabel = _container.querySelector('.progress__label');
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
      const pill = h('span', { class: `pill pill--${overall >= SCORE_HIGH_THRESHOLD ? 'success' : overall >= SCORE_MID_THRESHOLD ? 'warning' : 'error'}`, style: { cursor: 'pointer' } }, String(overall));
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

  const stickySection = h('div', { class: 'main__sticky' });
  const scrollSection = h('div', { class: 'main__scroll' });
  _container.appendChild(stickySection);
  _container.appendChild(scrollSection);

  const ptOptions = [...new Set(articles.map(a => a.topicName).filter(Boolean))].sort();
  const scored = articles.filter(a => scores[a.id]?.overall != null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, a) => s + scores[a.id].overall, 0) / scored.length) : null;

  const filteredScored = filtered.filter(a => scores[a.id]?.overall != null);
  const filteredAvg = filteredScored.length ? Math.round(filteredScored.reduce((s, a) => s + scores[a.id].overall, 0) / filteredScored.length) : null;

  const statsBar = h('div', { class: 'card', style: { padding: '12px', marginBottom: '12px' } },
    h('div', { style: { display: 'flex', gap: '24px', fontSize: '12px' } },
      h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700' } }, String(filtered.length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, filtered.length !== articles.length ? `of ${articles.length} Articles` : 'Articles')
      ),
      h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: 'var(--primary)' } }, `${filteredScored.length}/${filtered.length}`),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Scored')
      ),
      filteredAvg != null ? h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: filteredAvg >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : filteredAvg >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)' } }, String(filteredAvg)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Avg Score')
      ) : null,
      filteredScored.length ? h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: 'var(--error)' } }, String(filteredScored.filter(a => scores[a.id].overall < SCORE_MID_THRESHOLD).length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Below 60')
      ) : null
    )
  );
  stickySection.appendChild(statsBar);

  const validationOptions = [...new Set(articles.map(a => a.validationStatus).filter(Boolean))].sort();

  const searchInput = h('input', { type: 'text', class: 'input', style: { flex: '1', minWidth: '160px', maxWidth: '240px' }, placeholder: 'Search title / article #…', id: 'kb-filter', value: _filterText });
  searchInput.addEventListener('input', e => { _filterText = e.target.value; _page = 0; render(); });
  if (_searchFocused) {
    setTimeout(() => { const el = document.getElementById('kb-filter'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, 0);
  }

  const cloudMulti = multiSelect('kb-cloud-filter', 'Cloud',
    [{ value: 'Industry', label: 'Industry' }, { value: 'Revenue', label: 'Revenue' }],
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

  const filtersRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '0', flexWrap: 'wrap' } },
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
    stickySection.appendChild(h('div', { class: 'card', style: { marginTop: '8px', padding: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', null, `Scoring: ${scoring.done} / ${scoring.total}`),
        h('span', null, `${pct}%`)
      ),
      progressBar(pct, 'default', true)
    ));
  }

  if (loading) {
    const progress = typeof loading === 'object' ? loading : null;
    if (progress && progress.total > 0) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      scrollSection.appendChild(h('div', { style: { padding: '48px 24px', textAlign: 'center' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
          h('span', null, `Fetching articles: ${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()}`),
          h('span', null, `${pct}%`)
        ),
        progressBar(pct, 'default', true)
      ));
    } else {
      scrollSection.appendChild(h('div', { style: { textAlign: 'center', padding: '48px' } }, spinner('lg')));
    }
    return;
  }

  if (!articles.length) {
    scrollSection.appendChild(emptyState('📄', 'No articles loaded. Click Refresh to fetch from Salesforce.'));
    return;
  }

  filtered.sort((a, b) => {
    let va, vb;
    if (_sortCol === 'score') {
      va = scores[a.id]?.overall ?? -1;
      vb = scores[b.id]?.overall ?? -1;
    } else if (_sortCol === 'agfHits') {
      va = _agfHits?.[a.articleNumber]?.agfHits ?? 0;
      vb = _agfHits?.[b.articleNumber]?.agfHits ?? 0;
    } else if (_sortCol === 'lastPublished') {
      va = a.lastPublished || '';
      vb = b.lastPublished || '';
    } else {
      va = (a[_sortCol] || '').toLowerCase();
      vb = (b[_sortCol] || '').toLowerCase();
    }
    if (va < vb) return _sortDir === 'asc' ? -1 : 1;
    if (va > vb) return _sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  function kbSortIndicator(col) {
    return _sortCol === col ? (_sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  }

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => { toggleKbSort('articleNumber'); } }, '#' + kbSortIndicator('articleNumber')),
      h('th', { style: { cursor: 'pointer' }, onClick: () => { toggleKbSort('title'); } }, 'Title' + kbSortIndicator('title')),
      h('th', { style: { width: '180px', cursor: 'pointer' }, onClick: () => { toggleKbSort('topicName'); } }, 'Product & Topic' + kbSortIndicator('topicName')),
      h('th', { style: { width: '85px', cursor: 'pointer' }, onClick: () => { toggleKbSort('lastPublished'); } }, 'Published' + kbSortIndicator('lastPublished')),
      h('th', { style: { width: '80px', cursor: 'pointer' }, onClick: () => { toggleKbSort('agfHits'); } }, 'AGF' + kbSortIndicator('agfHits')),
      h('th', { style: { width: '60px', cursor: 'pointer' }, onClick: () => { toggleKbSort('score'); } }, 'Score' + kbSortIndicator('score')),
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
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => rewriteArticle(a) }, 'Rewrite')
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
    if (c.na) return;
    ctbody.appendChild(h('tr', null,
      h('td', { style: { fontWeight: '500', fontSize: '12px' } }, c.label || c.id),
      h('td', null, h('span', { class: `pill pill--${c.score >= c.max * 0.8 ? 'success' : c.score >= c.max * 0.5 ? 'warning' : 'error'}` }, `${c.score}/${c.max}`)),
      h('td', { style: { fontSize: '11px', maxWidth: '200px' } },
        (c.passed || []).length ? h('div', null, ...c.passed.map(p => h('div', { style: { marginBottom: '2px', color: 'var(--success)' } }, '• ' + p))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
      ),
      h('td', { style: { fontSize: '11px', maxWidth: '200px' } },
        (c.issues || []).length ? h('div', null, ...c.issues.map(issue => h('div', { style: { marginBottom: '2px', color: 'var(--error)' } }, '• ' + issue))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
      ),
      h('td', { style: { fontSize: '11px', maxWidth: '200px' } },
        (c.suggestions || []).length ? h('div', null, ...c.suggestions.map(sug => h('div', { style: { marginBottom: '2px', color: 'var(--primary)' } }, '• ' + sug))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
      )
    ));
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


function getCloudFromPt(topicName) {
  if (!topicName) return 'Other';
  if (topicName.toLowerCase().startsWith('industry')) return 'Industry';
  if (topicName.toLowerCase().startsWith('revenue')) return 'Revenue';
  return 'Other';
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
  const toScore = pageArticles.filter(a => !existingScores[a.id]?.overall);
  if (!toScore.length) { toast('All articles on this page already scored.', 'info'); return; }

  setState('kb.scoring', { done: 0, total: toScore.length });
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); setState('kb.scoring', null); return; }

  const bodyMap = await fetchArticleBodies(toScore.map(a => a.id), session);
  const scores = { ...existingScores };
  let done = 0;
  const inFlight = new Set();

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
    done++;
    inFlight.delete(article.id);
    setState('kb.scoringIds', [...inFlight]);
    setState('kb.scores', { ...scores });
    setState('kb.scoring', { done, total: toScore.length });
  });

  // Retry failed articles once
  const failed = toScore.filter(a => scores[a.id]?.overall == null);
  if (failed.length) {
    await new Promise(r => setTimeout(r, 2000));
    setState('kb.scoring', { done, total: toScore.length, retrying: failed.length });
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
    });
  }

  await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
  setState('kb.scoring', null);
  setState('kb.scoringIds', []);
  const successCount = toScore.filter(a => scores[a.id]?.overall != null).length;
  toast(`Scored ${successCount}/${toScore.length} articles.${failed.length ? ` (${failed.length - toScore.filter(a => scores[a.id]?.overall == null).length} recovered on retry)` : ''}`, 'success');
}

function renderCriterionRow(c) {
  if (c.na) return null;
  const scoreColor = c.score >= c.max * 0.8 ? 'var(--success)' : c.score >= c.max * 0.5 ? 'var(--warning)' : 'var(--error)';
  return h('tr', null,
    h('td', { style: { fontWeight: '500', fontSize: '12px' } }, c.label || c.id),
    h('td', null, h('span', { style: { fontWeight: '600', color: scoreColor } }, `${c.score}/${c.max}`)),
    h('td', { style: { fontSize: '11px', maxWidth: '180px' } },
      (c.passed || []).length ? h('div', null, ...c.passed.slice(0, 2).map(p => h('div', { style: { marginBottom: '2px', color: 'var(--success)' } }, '• ' + p))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
    ),
    h('td', { style: { fontSize: '11px', maxWidth: '180px' } },
      (c.issues || []).length ? h('div', null, ...c.issues.slice(0, 2).map(issue => h('div', { style: { marginBottom: '2px', color: 'var(--error)' } }, '• ' + issue))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
    ),
    h('td', { style: { fontSize: '11px', maxWidth: '180px' } },
      (c.suggestions || []).length ? h('div', null, ...c.suggestions.slice(0, 2).map(sug => h('div', { style: { marginBottom: '2px', color: 'var(--primary)' } }, '• ' + sug))) : h('span', { style: { color: 'var(--text-muted)' } }, '—')
    )
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
  }
}

async function rewriteArticle(article) {
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); return; }

  const bodyMap = await fetchArticleBodies([article.id], session);
  const body = bodyMap.get(article.id) || {};
  const desc = stripHtml(body.description || '').slice(0, MAX_BODY_CHARS);
  const res = stripHtml(body.resolution || '').slice(0, MAX_BODY_CHARS);
  const steps = stripHtml(body.steps || '').slice(0, 1500);

  const streamEl = h('div', { id: 'rewrite-stream', style: { fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } }, spinner('md'));
  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } }, `#${article.articleNumber} — ${article.title}`),
    streamEl
  );

  let _rewriteFullText = '';
  modal('Rewrite Article', content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(_rewriteFullText).then(() => toast('Copied.', 'success'));
    }}
  });

  const system = `You are an expert technical writer improving Salesforce Knowledge Articles for Agentforce readiness.
Apply these rules:
- TITLE: Specific to product + exact issue. Include product name, error text, or scenario.
- SUMMARY: 2-4 sentences covering problem context and resolution.
- HEADERS: Use ## headers to break content. Never bold text as substitute.
- DESCRIPTION: State problem, symptoms, context. Explain the "why".
- RESOLUTION: Brief statement of what steps accomplish, then numbered steps. After code blocks, add plain-text explanation.

Output exactly: ## TITLE, ## SUMMARY, ## DESCRIPTION, ## RESOLUTION. No other commentary.`;

  const user = `Rewrite this article:
Title: ${article.title}
P&T: ${article.topicName || ''}

CURRENT SUMMARY: ${article.summary || '(empty)'}
CURRENT DESCRIPTION: ${desc || '(empty)'}
CURRENT RESOLUTION: ${res || '(empty)'}
${steps ? `CURRENT STEPS: ${steps}` : ''}`;

  let _rewriteThrottle = null;
  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      onDelta: (chunk, full) => {
        _rewriteFullText = full;
        if (_rewriteThrottle) return;
        _rewriteThrottle = setTimeout(() => { _rewriteThrottle = null; }, 150);
        const el = document.getElementById('rewrite-stream');
        if (el) { el.textContent = ''; el.appendChild(renderMarkdown(full)); }
      }
    });
    const el = document.getElementById('rewrite-stream');
    if (el) { el.textContent = ''; el.appendChild(renderMarkdown(_rewriteFullText)); }
  } catch (e) {
    const el = document.getElementById('rewrite-stream');
    if (el) { el.textContent = ''; el.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + e.message)); }
  }
}

