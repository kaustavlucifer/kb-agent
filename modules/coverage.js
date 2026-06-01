import { h, spinner, toast, modal } from '../shared/ui.js';
import { getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { PT_HIGH_VOLUME_CONVS, PT_MID_VOLUME_CONVS } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _data = null;
let _selectedPt = null;
let _cloudFilter = '';
let _sortCol = 'totalConvs';
let _sortDir = 'desc';
let _popstateHandler = null;
let _coverageCache = {};

function inlineFormat(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      frag.appendChild(h('strong', { style: { fontWeight: '600' } }, part.slice(2, -2)));
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      frag.appendChild(h('em', { style: { fontStyle: 'italic' } }, part.slice(1, -1)));
    } else {
      frag.appendChild(document.createTextNode(part));
    }
  }
  return frag;
}

function renderMarkdown(text, container) {
  if (!text) return;
  const lines = text.split('\n');
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (!tableRows.length) return;
    const table = h('table', { class: 'data-table', style: { marginTop: '8px', marginBottom: '12px', width: '100%' } });
    const headerRow = tableRows[0];
    const separatorIdx = tableRows.findIndex(r => /^[\s|:-]+$/.test(r.replace(/\|/g, '').replace(/[-:]/g, '')));
    const dataStart = separatorIdx >= 0 ? separatorIdx + 1 : 1;

    if (headerRow) {
      const cells = headerRow.split('|').map(c => c.trim()).filter(Boolean);
      const thead = h('thead', null, h('tr', null, ...cells.map(c => { const th = h('th', { style: { fontSize: '11px', padding: '6px 8px' } }); th.appendChild(inlineFormat(c)); return th; })));
      table.appendChild(thead);
    }

    const tbody = h('tbody', null);
    for (let i = dataStart; i < tableRows.length; i++) {
      const cells = tableRows[i].split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length) {
        tbody.appendChild(h('tr', null, ...cells.map(c => { const td = h('td', { style: { fontSize: '11px', padding: '5px 8px' } }); td.appendChild(inlineFormat(c)); return td; })));
      }
    }
    table.appendChild(tbody);
    container.appendChild(table);
    tableRows = [];
    inTable = false;
  }

  lines.forEach(line => {
    if (line.trim().startsWith('|')) {
      inTable = true;
      tableRows.push(line.trim());
      return;
    }
    if (inTable) flushTable();

    if (/^#{4,}\s/.test(line)) {
      const text = line.replace(/^#+\s*/, '');
      const el = h('h5', { style: { fontSize: '12px', fontWeight: '600', marginTop: '10px', marginBottom: '4px', color: 'var(--primary)' } });
      el.appendChild(inlineFormat(text));
      container.appendChild(el);
    } else if (line.startsWith('### ')) {
      const el = h('h4', { style: { fontSize: '12px', fontWeight: '600', marginTop: '12px', marginBottom: '4px', color: 'var(--text-primary)' } });
      el.appendChild(inlineFormat(line.slice(4)));
      container.appendChild(el);
    } else if (line.startsWith('## ')) {
      const el = h('h3', { style: { fontSize: '13px', fontWeight: '700', marginTop: '14px', marginBottom: '6px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border)', paddingBottom: '4px' } });
      el.appendChild(inlineFormat(line.slice(3)));
      container.appendChild(el);
    } else if (line.startsWith('# ')) {
      const el = h('h2', { style: { fontSize: '14px', fontWeight: '700', marginTop: '16px', marginBottom: '8px' } });
      el.appendChild(inlineFormat(line.slice(2)));
      container.appendChild(el);
    } else if (/^---+$/.test(line.trim())) {
      container.appendChild(h('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' } }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const el = h('div', { style: { paddingLeft: '14px', fontSize: '12px', lineHeight: '1.6', marginBottom: '3px', position: 'relative' } });
      el.appendChild(h('span', { style: { position: 'absolute', left: '2px' } }, '•'));
      const span = h('span', null);
      span.appendChild(inlineFormat(line.slice(2)));
      el.appendChild(span);
      container.appendChild(el);
    } else if (/^\d+\.\s/.test(line)) {
      const el = h('div', { style: { paddingLeft: '14px', fontSize: '12px', lineHeight: '1.6', marginBottom: '3px' } });
      el.appendChild(inlineFormat(line));
      container.appendChild(el);
    } else if (line.trim()) {
      const el = h('p', { style: { margin: '4px 0', fontSize: '12px', lineHeight: '1.6' } });
      el.appendChild(inlineFormat(line));
      container.appendChild(el);
    }
  });

  if (inTable) flushTable();
}

function pushHistoryState() {
  const state = { selectedPt: _selectedPt, sortCol: _sortCol, sortDir: _sortDir };
  history.pushState(state, '', '');
}

function onPopState(e) {
  if (e.state && ('selectedPt' in e.state)) {
    _selectedPt = e.state.selectedPt;
    _sortCol = e.state.sortCol || 'totalConvs';
    _sortDir = e.state.sortDir || 'desc';
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
      for (const [key, val] of Object.entries(d.coverageCache)) {
        if (val.text && val.ts && Date.now() - val.ts < 7 * 24 * 60 * 60 * 1000) {
          _coverageCache[key] = val.text;
        }
      }
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

  const stickySection = h('div', { class: 'main__sticky' });
  const scrollSection = h('div', { class: 'main__scroll' });
  _container.appendChild(stickySection);
  _container.appendChild(scrollSection);

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
    h('option', { value: 'Industry', selected: _cloudFilter === 'Industry' }, 'Industry'),
    h('option', { value: 'Revenue', selected: _cloudFilter === 'Revenue' }, 'Revenue')
  );

  const toolbar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '0', flexWrap: 'wrap' } },
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
  if (_sortCol === col) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  else { _sortCol = col; _sortDir = 'asc'; }
  pushHistoryState();
  renderView();
}

function sortIndicator(col) {
  return _sortCol === col ? (_sortDir === 'asc' ? ' ↑' : ' ↓') : '';
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
    return { pt, totalConvs, resPct, clusterCount: clusters.length, gapCount, articleCount: ptArticles.length };
  });

  rows.sort((a, b) => {
    let va, vb;
    if (_sortCol === 'pt') { va = a.pt.toLowerCase(); vb = b.pt.toLowerCase(); }
    else { va = a[_sortCol] ?? 0; vb = b[_sortCol] ?? 0; }
    if (va < vb) return _sortDir === 'asc' ? -1 : 1;
    if (va > vb) return _sortDir === 'asc' ? 1 : -1;
    return 0;
  });

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
  target.appendChild(summaryCard);

  const table = h('table', { class: 'data-table' },
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
  target.appendChild(table);
}

function showCoverageResult(ptName, narrative) {
  const streamEl = h('div', { id: 'coverage-stream', style: { fontSize: '12px', lineHeight: '1.7', maxHeight: '500px', overflowY: 'auto', padding: '4px' } });
  renderMarkdown(narrative, streamEl);

  const content = h('div', null, streamEl);
  modal(`Coverage: ${ptName}`, content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(narrative).then(() => toast('Copied.', 'success'));
    }}
  });
}

async function handleAiSummary(ptName, clusters, ptArticles, forceRefresh = false) {
  if (!forceRefresh && _coverageCache[ptName]) {
    showCoverageResult(ptName, _coverageCache[ptName]);
    return;
  }

  const streamEl = h('div', { id: 'coverage-stream', style: { fontSize: '12px', lineHeight: '1.7', maxHeight: '500px', overflowY: 'auto', padding: '4px' } });
  streamEl.appendChild(spinner('md'));

  const statsHeader = h('div', { style: { marginBottom: '12px', padding: '8px', background: 'var(--surface-raised)', borderRadius: 'var(--radius-xs)', fontSize: '11px', color: 'var(--text-secondary)' } },
    `${clusters.length} clusters · ${clusters.reduce((s, c) => s + (c.conversations || 0), 0).toLocaleString()} conversations · ${ptArticles.length} KB articles`
  );

  const content = h('div', null, statsHeader, streamEl);

  modal(`Coverage: ${ptName}`, content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(document.getElementById('coverage-stream')?.getAttribute('data-raw') || '').then(() => toast('Copied.', 'success'));
    }}
  });

  try {
    const port = chrome.runtime.connect({ name: 'kba-coverage-stream' });
    port.postMessage({ ptName, clusters, articles: ptArticles });
    let fullText = '';

    port.onMessage.addListener((msg) => {
      const el = document.getElementById('coverage-stream');
      if (!el) return;
      if (msg.type === 'delta') {
        fullText += msg.chunk;
        el.textContent = '';
        renderMarkdown(fullText, el);
        el.scrollTop = el.scrollHeight;
      } else if (msg.type === 'done') {
        fullText = msg.narrative || fullText;
        el.textContent = '';
        el.setAttribute('data-raw', fullText);
        renderMarkdown(fullText, el);
        _coverageCache[ptName] = fullText;
        localGet(['coverageCache']).then(d => {
          const cache = d.coverageCache || {};
          cache[ptName] = { text: fullText, ts: Date.now() };
          localSet({ coverageCache: cache });
        });
        port.disconnect();
      } else if (msg.type === 'error') {
        el.textContent = 'Error: ' + (msg.error || 'Unknown');
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {});
  } catch (e) {
    const el = document.getElementById('coverage-stream');
    if (el) el.textContent = 'Error: ' + e.message;
  }
}
