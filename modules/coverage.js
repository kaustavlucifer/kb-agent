import { h, spinner, emptyState, toast, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { PT_HIGH_VOLUME_CONVS, PT_MID_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _data = null;
let _selectedPt = null;
let _ptAnalysis = {};
let _ptAnalysisLoading = {};
let _ptGaps = {};
let _ptGapsLoading = {};

function renderMarkdown(text, container) {
  if (!text) return;
  const lines = text.split('\n');
  lines.forEach(line => {
    if (line.startsWith('### ')) container.appendChild(h('h4', { style: { fontSize: '12px', fontWeight: '600', marginTop: '8px', color: 'var(--text-primary)' } }, line.slice(4)));
    else if (line.startsWith('## ')) container.appendChild(h('h3', { style: { fontSize: '13px', fontWeight: '600', marginTop: '10px' } }, line.slice(3)));
    else if (line.startsWith('# ')) container.appendChild(h('h2', { style: { fontSize: '14px', fontWeight: '700', marginTop: '12px' } }, line.slice(2)));
    else if (line.startsWith('- ')) container.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px', lineHeight: '1.5' } }, '• ' + line.slice(2)));
    else if (/^\d+\.\s/.test(line)) container.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px', lineHeight: '1.5' } }, line));
    else if (line.startsWith('|')) {
      container.appendChild(h('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '2px 0', borderBottom: '1px solid var(--border)' } }, line));
    }
    else if (line.trim()) container.appendChild(h('p', { style: { margin: '3px 0', fontSize: '12px', lineHeight: '1.5' } }, line));
  });
}

export function mount(container) {
  _container = container;
  if (!_data) loadData();
  else renderView();
  _unsubs.push(subscribe('kb.articles', renderView));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
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

  if (!_data) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('md')));
    return;
  }

  const ptNames = Object.keys(_data).sort();

  const toolbar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } },
    h('select', { class: 'input', id: 'pt-select', style: { maxWidth: '300px' } },
      h('option', { value: '' }, `All P&Ts (${ptNames.length})`),
      ...ptNames.map(pt => h('option', { value: pt, selected: _selectedPt === pt }, pt))
    ),
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginLeft: 'auto' } },
      articles.length ? `${articles.length} articles loaded` : 'Load articles in KB tab for coverage matching'
    )
  );
  _container.appendChild(toolbar);
  document.getElementById('pt-select')?.addEventListener('change', e => {
    _selectedPt = e.target.value || null;
    renderView();
  });

  if (_selectedPt) {
    renderPtDetail(_selectedPt, articles);
  } else {
    renderOverview(ptNames, articles);
  }
}

function renderOverview(ptNames, articles) {
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
    return { pt, totalConvs, resPct, clusterCount: clusters.length, gapCount, articleCount: ptArticles.length };
  }).sort((a, b) => b.totalConvs - a.totalConvs);

  const summaryCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
    h('div', { style: { display: 'flex', gap: '24px', fontSize: '12px' } },
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' } }, String(ptNames.length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Product & Topics')
      ),
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)' } }, String(rows.reduce((s, r) => s + r.clusterCount, 0))),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Clusters')
      ),
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--error)' } }, String(rows.reduce((s, r) => s + r.gapCount, 0))),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Coverage Gaps')
      ),
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--success)' } }, String(rows.reduce((s, r) => s + r.totalConvs, 0).toLocaleString())),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Total Conversations')
      )
    )
  );
  _container.appendChild(summaryCard);

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Product & Topic'),
      h('th', { style: { width: '90px' } }, 'Convs'),
      h('th', { style: { width: '70px' } }, 'Res %'),
      h('th', { style: { width: '70px' } }, 'Clusters'),
      h('th', { style: { width: '70px' } }, 'Articles'),
      h('th', { style: { width: '70px' } }, 'Gaps'),
      h('th', { style: { width: '90px' } }, 'Actions')
    )),
    h('tbody', null)
  );
  const tbody = table.querySelector('tbody');
  rows.forEach(r => {
    const row = h('tr', { style: { cursor: 'pointer' }, onClick: () => { _selectedPt = r.pt; renderView(); document.getElementById('pt-select').value = r.pt; } },
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
        h('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); handleFindGaps(r.pt, _data[r.pt].clusters || [], articles.filter(a => (a.topicName || '').toLowerCase() === r.pt.toLowerCase())); } }, 'Gaps'),
        h('button', { class: 'btn btn--ghost btn--sm', style: { marginLeft: '4px' }, onClick: (e) => { e.stopPropagation(); handleAiSummary(r.pt, _data[r.pt].clusters || [], articles.filter(a => (a.topicName || '').toLowerCase() === r.pt.toLowerCase())); } }, 'AI')
      )
    );
    tbody.appendChild(row);
  });
  _container.appendChild(table);
}

function renderPtDetail(ptName, articles) {
  const ptData = _data[ptName];
  if (!ptData) return;
  const clusters = ptData.clusters || [];
  const ptArticles = articles.filter(a => (a.topicName || '').toLowerCase() === ptName.toLowerCase());

  const headerCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('div', null,
        h('div', { style: { fontSize: '14px', fontWeight: '600' } }, ptName),
        h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' } },
          `${(ptData.total_conversations || 0).toLocaleString()} conversations · ${Math.round((ptData.resolution_pct || 0) * 100)}% resolution · ${ptData.escalations || 0} escalations`
        )
      ),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('button', {
          class: 'btn btn--primary btn--sm',
          disabled: _ptGapsLoading[ptName],
          onClick: () => handleFindGaps(ptName, clusters, ptArticles)
        }, _ptGapsLoading[ptName] ? 'Analyzing…' : 'Find Gaps'),
        h('button', {
          class: 'btn btn--secondary btn--sm',
          disabled: _ptAnalysisLoading[ptName],
          onClick: () => handleAiSummary(ptName, clusters, ptArticles)
        }, _ptAnalysisLoading[ptName] ? 'Generating…' : 'AI Summary'),
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => { _selectedPt = null; renderView(); document.getElementById('pt-select').value = ''; } }, '← All P&Ts')
      )
    )
  );
  _container.appendChild(headerCard);

  if (_ptAnalysis[ptName]) {
    const narrativeContainer = h('div', null);
    renderMarkdown(_ptAnalysis[ptName], narrativeContainer);
    const analysisCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'AI Coverage Summary'),
      narrativeContainer
    );
    _container.appendChild(analysisCard);
  }

  if (_ptAnalysisLoading[ptName] && !_ptAnalysis[ptName]) {
    _container.appendChild(h('div', { class: 'card', style: { marginBottom: '12px', padding: '16px', textAlign: 'center' } }, spinner('sm')));
  }

  if (_ptGaps[ptName]) {
    const gapCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'Gap Analysis'),
      h('div', { style: { fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap' } }, _ptGaps[ptName])
    );
    _container.appendChild(gapCard);
  }

  if (_ptGapsLoading[ptName] && !_ptGaps[ptName]) {
    _container.appendChild(h('div', { class: 'card', style: { marginBottom: '12px', padding: '16px', textAlign: 'center' } }, spinner('sm')));
  }

  const table = h('table', { class: 'data-table' },
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
  clusters.sort((a, b) => (b.conversations || 0) - (a.conversations || 0));

  clusters.forEach(c => {
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
      h('td', null, h('span', { class: `pill pill--${(c.conversations || 0) >= 200 ? 'error' : (c.conversations || 0) >= 50 ? 'warning' : 'neutral'}` }, String(c.conversations || 0))),
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
  _container.appendChild(table);
}

function handleFindGaps(ptName, clusters, articles) {
  _ptGapsLoading[ptName] = true;
  renderView();
  const port = chrome.runtime.connect({ name: 'kbs-coverage' });
  port.postMessage({ clusters: Object.fromEntries(clusters.map(c => [c.label || c.name, { keywords: [c.name, c.label, ...(c.top_utterances || []).slice(0, 3)], conversations: c.conversations || 0 }])), articles });
  port.onMessage.addListener((resp) => {
    if (resp.type === 'done') {
      const gapText = (resp.gaps || []).map(g => `${g.cluster} (${g.conversations} convs) — ${g.coverage} [${g.priority}]`).join('\n') || 'No gaps found.';
      _ptGaps[ptName] = gapText;
      _ptGapsLoading[ptName] = false;
      port.disconnect();
      renderView();
    } else if (resp.type === 'error') {
      _ptGapsLoading[ptName] = false;
      toast(resp.error, 'error');
      port.disconnect();
      renderView();
    }
  });
}

function handleAiSummary(ptName, clusters, articles) {
  _ptAnalysisLoading[ptName] = true;
  renderView();
  chrome.runtime.sendMessage({
    action: 'COVERAGE_ANALYZE_PT',
    ptName,
    clusters,
    articles
  }, (resp) => {
    _ptAnalysisLoading[ptName] = false;
    if (resp && resp.success) {
      _ptAnalysis[ptName] = resp.narrative;
    } else {
      toast((resp && resp.error) || 'AI analysis failed', 'error');
    }
    renderView();
  });
}
