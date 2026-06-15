import { h, spinner, toast, stickyScrollLayout, createSorter, statsBar, streamingModal } from '../shared/ui.js';
import { getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { PT_HIGH_VOLUME_CONVS, PT_MID_VOLUME_CONVS, CLUSTER_HIGH_VOLUME_CONVS, CLUSTER_MID_VOLUME_CONVS, CLOUDS } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _data = null;
let _selectedPt = null;
let _cloudFilter = '';
const _sorter = createSorter('totalConvs', 'desc');
let _popstateHandler = null;
let _coverageCache = {};


function pushHistoryState() {
  const state = { selectedPt: _selectedPt, sortCol: _sorter.col, sortDir: _sorter.dir };
  history.pushState(state, '', '');
}

function onPopState(e) {
  if (e.state && ('selectedPt' in e.state)) {
    _selectedPt = e.state.selectedPt;
    _sorter.set(e.state.sortCol || 'totalConvs', e.state.sortDir || 'desc');
    renderView();
    const select = document.getElementById('pt-select');
    if (select) select.value = _selectedPt || '';
  }
}

export function mount(container) {
  _container = container;
  if (!_data) loadData();
  else renderView();
  _unsubs.push(subscribe('kb.articles', renderView));
  _popstateHandler = onPopState;
  window.addEventListener('popstate', _popstateHandler);
  localGet(['coverageCache']).then(d => {
    if (d.coverageCache) {
      let loaded = false;
      for (const [key, val] of Object.entries(d.coverageCache)) {
        if (val.text && val.ts && Date.now() - val.ts < 7 * 24 * 60 * 60 * 1000) {
          _coverageCache[key] = val.text;
          loaded = true;
        }
      }
      if (loaded && _container) renderView();
    }
  });
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
  if (_popstateHandler) {
    window.removeEventListener('popstate', _popstateHandler);
    _popstateHandler = null;
  }
}

async function loadData() {
  try {
    const url = chrome.runtime.getURL('data/pt_clusters.json');
    const resp = await fetch(url);
    const raw = await resp.json();
    _data = raw.pt_clusters || raw;
    renderView();
  } catch (e) {
    toast('Failed to load P&T data: ' + e.message, 'error');
  }
}

function renderView() {
  if (!_container) return;
  _container.textContent = '';
  const articles = getState('kb.articles') || [];

  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  if (!_data) {
    scrollSection.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('md')));
    return;
  }

  let ptNames = Object.keys(_data).sort();
  if (_cloudFilter) {
    ptNames = ptNames.filter(pt => pt.toLowerCase().startsWith(_cloudFilter.toLowerCase()));
  }

  const cloudSelect = h('select', { class: 'input', id: 'cloud-select', style: { maxWidth: '140px' } },
    h('option', { value: '', selected: !_cloudFilter }, 'All Clouds'),
    ...CLOUDS.map(c => h('option', { value: c, selected: _cloudFilter === c }, c))
  );

  const toolbar = h('div', { class: 'tab-toolbar' },
    cloudSelect,
    h('select', { class: 'input', id: 'pt-select', style: { maxWidth: '300px' } },
      h('option', { value: '' }, `All P&Ts (${ptNames.length})`),
      ...ptNames.map(pt => h('option', { value: pt, selected: _selectedPt === pt }, pt))
    ),
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginLeft: 'auto' } },
      articles.length ? `${articles.length} articles loaded` : 'Load articles in KB tab for coverage matching'
    )
  );
  stickySection.appendChild(toolbar);
  document.getElementById('cloud-select')?.addEventListener('change', e => {
    _cloudFilter = e.target.value;
    _selectedPt = null;
    renderView();
  });
  document.getElementById('pt-select')?.addEventListener('change', e => {
    _selectedPt = e.target.value || null;
    pushHistoryState();
    renderView();
  });

  if (_selectedPt) {
    renderPtDetail(_selectedPt, articles, scrollSection);
  } else {
    renderOverview(ptNames, articles, scrollSection);
  }
}

function toggleSort(col) {
  _sorter.toggle(col);
  pushHistoryState();
  renderView();
}

function sortIndicator(col) {
  return _sorter.indicator(col);
}

function renderOverview(ptNames, articles, target) {
  const rows = ptNames.map(pt => {
    const ptData = _data[pt];
    const clusters = ptData.clusters || [];
    const totalConvs = ptData.total_conversations || 0;
    const resPct = ptData.resolution_pct || 0;
    const ptArticles = articles.filter(a => (a.topicName || '').toLowerCase() === pt.toLowerCase());
    const gapCount = clusters.filter(c => {
      const keywords = [c.name, c.label, ...(c.top_utterances || []).slice(0, 2)].map(k => (k || '').toLowerCase());
      const matched = ptArticles.filter(a => keywords.some(kw => kw && `${a.title} ${a.summary}`.toLowerCase().includes(kw)));
      return matched.length < 1;
    }).length;
    const validatedOnlineCount = ptArticles.filter(a => a.validationStatus === 'Validated External' && a.publishStatus === 'Online').length;
    return { pt, totalConvs, resPct, clusterCount: clusters.length, gapCount, articleCount: validatedOnlineCount };
  });

  const sortCol = _sorter.col;
  rows.sort((a, b) => {
    let va, vb;
    if (sortCol === 'pt') { va = a.pt.toLowerCase(); vb = b.pt.toLowerCase(); }
    else { va = a[sortCol] ?? 0; vb = b[sortCol] ?? 0; }
    return _sorter.compare(va, vb);
  });

  target.appendChild(statsBar([
    { value: ptNames.length, label: 'Product & Topics' },
    { value: rows.reduce((s, r) => s + r.clusterCount, 0), label: 'Clusters' },
    { value: rows.reduce((s, r) => s + r.gapCount, 0), label: 'Coverage Gaps', color: 'var(--error)' },
    { value: rows.reduce((s, r) => s + r.totalConvs, 0).toLocaleString(), label: 'Total Conversations', color: 'var(--success)' }
  ]));

  const table = h('table', { class: 'data-table data-table--animated' },
    h('thead', null, h('tr', null,
      h('th', { style: { cursor: 'pointer' }, onClick: () => toggleSort('pt') }, 'Product & Topic' + sortIndicator('pt')),
      h('th', { style: { width: '90px', cursor: 'pointer' }, onClick: () => toggleSort('totalConvs') }, 'Convs' + sortIndicator('totalConvs')),
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => toggleSort('resPct') }, 'Res %' + sortIndicator('resPct')),
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => toggleSort('clusterCount') }, 'Clusters' + sortIndicator('clusterCount')),
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => toggleSort('articleCount') }, 'Articles' + sortIndicator('articleCount')),
      h('th', { style: { width: '70px', cursor: 'pointer' }, onClick: () => toggleSort('gapCount') }, 'Gaps' + sortIndicator('gapCount')),
      h('th', { style: { width: '90px' } }, 'Actions')
    )),
    h('tbody', null)
  );
  const tbody = table.querySelector('tbody');
  rows.forEach(r => {
    const row = h('tr', { style: { cursor: 'pointer' }, onClick: () => { _selectedPt = r.pt; pushHistoryState(); renderView(); document.getElementById('pt-select').value = r.pt; } },
      h('td', { style: { fontSize: '12px', fontWeight: '500' } }, r.pt),
      h('td', null, h('span', { class: `pill pill--${r.totalConvs >= PT_HIGH_VOLUME_CONVS ? 'error' : r.totalConvs >= PT_MID_VOLUME_CONVS ? 'warning' : 'neutral'}` }, r.totalConvs.toLocaleString())),
      h('td', null, h('span', { style: { fontSize: '12px' } }, `${Math.round(r.resPct * 100)}%`)),
      h('td', { style: { fontSize: '12px' } }, String(r.clusterCount)),
      h('td', { style: { fontSize: '12px' } }, String(r.articleCount)),
      h('td', null, r.gapCount > 0
        ? h('span', { class: 'pill pill--error' }, String(r.gapCount))
        : h('span', { class: 'pill pill--success' }, '0')
      ),
      h('td', { style: { whiteSpace: 'nowrap' } },
        h('div', { style: { display: 'flex', gap: '4px' }, onClick: (e) => e.stopPropagation() },
          _coverageCache[r.pt]
            ? h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '14px', padding: '2px 6px' }, title: 'View cached', onClick: () => showCoverageResult(r.pt, _coverageCache[r.pt]) }, '👁')
            : null,
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => handleAiSummary(r.pt, _data[r.pt].clusters || [], articles.filter(a => (a.topicName || '').toLowerCase() === r.pt.toLowerCase()), !!_coverageCache[r.pt]) }, _coverageCache[r.pt] ? 'Redo' : 'Analyze')
        )
      )
    );
    tbody.appendChild(row);
  });
  target.appendChild(table);
}

function renderPtDetail(ptName, articles, target) {
  const ptData = _data[ptName];
  if (!ptData) return;
  const clusters = ptData.clusters || [];
  const ptArticles = articles.filter(a => (a.topicName || '').toLowerCase() === ptName.toLowerCase());

  const headerCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => { _selectedPt = null; pushHistoryState(); renderView(); document.getElementById('pt-select').value = ''; } }, '← Back'),
        h('div', null,
          h('div', { style: { fontSize: '14px', fontWeight: '600' } }, ptName),
          h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' } },
            `${(ptData.total_conversations || 0).toLocaleString()} conversations · ${Math.round((ptData.resolution_pct || 0) * 100)}% resolution · ${ptData.escalations || 0} escalations`
          )
        )
      ),
      h('div', { style: { display: 'flex', gap: '6px' } },
        _coverageCache[ptName]
          ? h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '14px', padding: '2px 8px' }, title: 'View cached analysis', onClick: () => showCoverageResult(ptName, _coverageCache[ptName]) }, '👁')
          : null,
        h('button', {
          class: 'btn btn--primary btn--sm',
          onClick: () => handleAiSummary(ptName, clusters, ptArticles, true)
        }, _coverageCache[ptName] ? 'Reanalyze' : 'Analyze')
      )
    )
  );
  target.appendChild(headerCard);

  const table = h('table', { class: 'data-table data-table--animated' },
    h('thead', null, h('tr', null,
      h('th', null, 'Cluster'),
      h('th', { style: { width: '70px' } }, 'Convs'),
      h('th', { style: { width: '70px' } }, 'Res %'),
      h('th', { style: { width: '70px' } }, 'Escals'),
      h('th', null, 'Cited Articles'),
      h('th', { style: { width: '80px' } }, 'Coverage')
    )),
    h('tbody', null)
  );
  const tbody = table.querySelector('tbody');
  const sortedClusters = [...clusters].sort((a, b) => (b.conversations || 0) - (a.conversations || 0));

  sortedClusters.forEach(c => {
    const keywords = [c.name, c.label, ...(c.top_utterances || []).slice(0, 2)].map(k => (k || '').toLowerCase());
    const matchedArticles = ptArticles.filter(a => keywords.some(kw => kw && `${a.title} ${a.summary}`.toLowerCase().includes(kw)));
    const cited = c.cited_articles || [];
    const coverage = cited.length > 0 && (c.resolution_pct || 0) >= 0.65 ? 'covered'
      : cited.length > 0 || matchedArticles.length > 0 ? 'partial' : 'gap';

    tbody.appendChild(h('tr', null,
      h('td', null,
        h('div', { style: { fontSize: '12px', fontWeight: '500' } }, c.label || c.name),
        (c.top_utterances || []).length ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' } }, (c.top_utterances || []).slice(0, 1).join('; ').slice(0, 80)) : null
      ),
      h('td', null, h('span', { class: `pill pill--${(c.conversations || 0) >= CLUSTER_HIGH_VOLUME_CONVS ? 'error' : (c.conversations || 0) >= CLUSTER_MID_VOLUME_CONVS ? 'warning' : 'neutral'}` }, String(c.conversations || 0))),
      h('td', { style: { fontSize: '12px' } }, `${Math.round((c.resolution_pct || 0) * 100)}%`),
      h('td', { style: { fontSize: '12px' } }, String(c.escalations || 0)),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } },
        cited.length ? cited.slice(0, 2).map(a => a.title).join('; ').slice(0, 80) : (matchedArticles.length ? `${matchedArticles.length} matched` : '—')
      ),
      h('td', null,
        h('span', { class: `pill pill--${coverage === 'covered' ? 'success' : coverage === 'partial' ? 'warning' : 'error'}` }, coverage)
      )
    ));
  });
  target.appendChild(table);
}

function showCoverageResult(ptName, narrative) {
  const m = streamingModal(`Coverage: ${ptName}`);
  m.renderFull(narrative);
}

async function handleAiSummary(ptName, clusters, ptArticles, forceRefresh = false) {
  if (!forceRefresh && _coverageCache[ptName]) {
    showCoverageResult(ptName, _coverageCache[ptName]);
    return;
  }

  const statsHeader = h('div', { class: 'stream-stats' },
    `${clusters.length} clusters · ${clusters.reduce((s, c) => s + (c.conversations || 0), 0).toLocaleString()} conversations · ${ptArticles.length} KB articles`
  );

  let coveragePort = null;
  let done = false;
  const m = streamingModal(`Coverage: ${ptName}`, {
    header: statsHeader,
    onClose: () => { if (coveragePort) { try { coveragePort.disconnect(); } catch {} coveragePort = null; } }
  });

  try {
    coveragePort = chrome.runtime.connect({ name: 'kba-coverage-stream' });
    coveragePort.postMessage({ ptName, clusters, articles: ptArticles });
    let fullText = '';

    coveragePort.onMessage.addListener((msg) => {
      if (msg.type === 'delta') {
        fullText += msg.chunk;
        m.renderFull(fullText, { scroll: true });
      } else if (msg.type === 'done') {
        fullText = msg.narrative || fullText;
        m.renderFull(fullText);
        done = true;
        _coverageCache[ptName] = fullText;
        localGet(['coverageCache']).then(d => {
          const cache = d.coverageCache || {};
          cache[ptName] = { text: fullText, ts: Date.now() };
          localSet({ coverageCache: cache });
        });
        coveragePort.disconnect();
        coveragePort = null;
      } else if (msg.type === 'error') {
        m.setError('Error: ' + (msg.error || 'Unknown'));
        done = true;
        coveragePort.disconnect();
        coveragePort = null;
      }
    });
    coveragePort.onDisconnect.addListener(() => {
      coveragePort = null;
      if (!done) m.setError('Connection lost — try again.');
    });
  } catch (e) {
    m.setError('Error: ' + e.message);
  }
}
