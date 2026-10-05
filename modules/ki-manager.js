import { h, spinner, toast, modal, swapButtonWithLink, sectionsEditor, emptyState, multiSelect, richHtmlBox, createSorter, stickyScrollLayout, scoreColor, crossScopeToggle, requestToken, paginationBar, fieldLabel, asyncModal } from '../shared/ui.js';
import { parseRewriteSections, serializeRewriteSections, markdownToHtml } from '../shared/markdown.js';
import { KI_CLOUD_MAPPING, KI_CATEGORIES } from '../data/ki_mapping.js';

const KI_CLOUDS = [...new Set(Object.values(KI_CLOUD_MAPPING).map(e => e.cloud))].sort();

let _container = null;
let _kiAllItems = [];
let _kiLoading = false;
let _kiFilterText = '';
let _kiFilterCategories = [];
let _renderDebounce = null;
let _page = 0;
const _pageSize = 50;
let _kiCrossScope = false;
let _kiCrossResults = [];
let _kiCrossLoading = false;
let _kiRewriteLoadingId = null;
let _kiScoringId = null;
let _kiScores = {};
let _kiDraftCache = {};
const _kiSorter = createSorter(null);
const _crossSearchToken = requestToken();

function toggleKiSort(col) {
  _kiSorter.toggle(col);
  render();
}

const KI_FIELDS = [
  { field: 'subject', label: 'Subject', plain: true, singleLine: true },
  { field: 'summary', label: 'Summary', plain: true },
  { field: 'repro', label: 'Repro Steps', rows: 8 },
  { field: 'workaround', label: 'Workaround', rows: 8 }
];
const KI_FIELD_NAMES = KI_FIELDS.map(f => f.field);

const kiEditor = sectionsEditor({
  getCachedText: (key) => _kiDraftCache[key] || '',
  setCachedText: (key, text) => { _kiDraftCache[key] = text; },
  fields: KI_FIELDS
});

export function mount(container) {
  _container = container;
  render();
  loadKnownIssues();
}

export function unmount() {
  _container = null;
  if (_renderDebounce) { clearTimeout(_renderDebounce); _renderDebounce = null; }
}

export function openKiDraftModal({ draft, cloud, caseNumber, workId, onCreated }) {
  const key = `ext-${Date.now()}`;
  _kiDraftCache[key] = serializeRewriteSections(draft, KI_FIELD_NAMES);

  const cloudSelect = h('select', { class: 'input', style: { maxWidth: '160px' } },
    ...KI_CLOUDS.map(c => h('option', { value: c }, c))
  );
  cloudSelect.value = KI_CLOUDS.includes(cloud) ? cloud : KI_CLOUDS[0];

  const categorySelect = h('select', { class: 'input', style: { maxWidth: '200px' } },
    ...KI_CATEGORIES.map(c => h('option', { value: c }, c))
  );

  const editorHost = h('div', null);
  kiEditor.renderInto(editorHost, key);

  const body = h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', flexWrap: 'wrap' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Cloud'),
        cloudSelect
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Category *'),
        categorySelect
      ),
      workId ? h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, `Work Item: ${workId}`) : null
    ),
    editorHost
  );

  const footer = h('div', { class: 'modal__footer' },
    h('button', { class: 'btn btn--secondary', onClick: () => close() }, 'Close'),
    h('button', { class: 'btn btn--primary', id: 'ki-create-btn', onClick: () => createKnownIssue(key, cloudSelect.value, categorySelect.value, workId, onCreated) }, 'Create Known Issue (Draft)')
  );

  let close;
  ({ close } = modal(`Draft Known Issue${caseNumber ? ` — Case #${caseNumber}` : ''}`, body, { wide: true, footer }));
}

async function createKnownIssue(key, cloud, category, workId, onCreated) {
  const sections = parseRewriteSections(_kiDraftCache[key] || '', KI_FIELD_NAMES);
  const payload = { subject: sections.subject, summary: sections.summary, repro: sections.repro, workaround: sections.workaround, cloud, category, workId };
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'CREATE_KNOWN_ISSUE', payload });
    if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return; }
    swapButtonWithLink('ki-create-btn', { url: resp.url, label: 'Open in Known Issues org ↗' });
    toast('Known Issue created.', 'success');
    delete _kiDraftCache[key];
    if (onCreated) onCreated(resp);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function runCrossSearch(query) {
  if (!query || query.trim().length < 2) { _kiCrossResults = []; render(); return; }
  const token = _crossSearchToken.next();
  _kiCrossLoading = true;
  render();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'SEARCH_KI_UNSCOPED', query: query.trim() });
    if (!_crossSearchToken.isCurrent(token)) return;
    if (resp?.error) { toast(resp.error, 'error'); _kiCrossResults = []; }
    else { _kiCrossResults = resp?.items || []; }
  } catch (e) {
    if (!_crossSearchToken.isCurrent(token)) return;
    toast(e.message, 'error');
    _kiCrossResults = [];
  } finally {
    if (_crossSearchToken.isCurrent(token)) {
      _kiCrossLoading = false;
      render();
    }
  }
}

async function loadKnownIssues(forceLive = false) {
  _kiLoading = true;
  render();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'LOAD_ALL_KNOWN_ISSUES', forceLive });
    if (resp?.error) { toast(resp.error, 'error'); _kiAllItems = []; }
    else {
      _kiAllItems = resp?.items || [];
      toast(`Loaded ${_kiAllItems.length} Known Issues${resp?.fromCache ? ' (cached)' : ''}.`, 'success');
    }
  } catch (e) {
    toast(e.message, 'error');
    _kiAllItems = [];
  } finally {
    _kiLoading = false;
    _page = 0;
    render();
  }
}

let _filteredMemo = null;

function compareKis(a, b) {
  const col = _kiSorter.col;
  let va, vb;
  if (col === 'reportingCount') {
    va = a.reportingCount || 0;
    vb = b.reportingCount || 0;
  } else if (col === 'createdDate' || col === 'lastModifiedDate') {
    va = a[col] || '';
    vb = b[col] || '';
  } else {
    va = (a[col] || '').toLowerCase();
    vb = (b[col] || '').toLowerCase();
  }
  return _kiSorter.compare(va, vb);
}

function getFilteredKis() {
  const signature = `${_kiFilterText}|${_kiFilterCategories.join(',')}|${_kiSorter.col}|${_kiSorter.dir}`;
  if (_filteredMemo && _filteredMemo.items === _kiAllItems && _filteredMemo.signature === signature) {
    return _filteredMemo.result;
  }
  let filtered = _kiAllItems;
  if (_kiFilterCategories.length) filtered = filtered.filter(ki => _kiFilterCategories.includes(ki.category));
  if (_kiFilterText) {
    const term = _kiFilterText.toLowerCase();
    filtered = filtered.filter(ki => `${ki.name || ''} ${ki.subject || ''}`.toLowerCase().includes(term));
  }
  if (_kiSorter.col) filtered = [...filtered].sort(compareKis);
  _filteredMemo = { items: _kiAllItems, signature, result: filtered };
  return filtered;
}

async function startRewrite(item) {
  _kiRewriteLoadingId = item.id;
  render();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'GENERATE_KI_REWRITE', kiId: item.id });
    if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return; }
    _kiDraftCache[item.id] = serializeRewriteSections(resp.draft, KI_FIELD_NAMES);
    openRewriteModal(item, resp.basedOnDraft);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    _kiRewriteLoadingId = null;
    render();
  }
}

function openRewriteModal(item, basedOnDraft) {
  const editorHost = h('div', null);
  kiEditor.renderInto(editorHost, item.id);

  const instructionsInput = h('textarea', {
    class: 'input', rows: '2',
    placeholder: 'Optional: extra instructions for the rewrite (e.g. "mention the Winter release", "shorten the summary", "add a workaround using a manual refresh"). Applied when you regenerate.',
    style: { width: '100%', marginBottom: '12px', fontSize: '12px', resize: 'vertical' }
  });

  const regenBtn = h('button', { class: 'btn btn--ghost btn--sm' }, 'Regenerate');
  regenBtn.addEventListener('click', async () => {
    const current = parseRewriteSections(_kiDraftCache[item.id] || '', KI_FIELD_NAMES);
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating…';
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'GENERATE_KI_REWRITE', kiId: item.id, instructions: instructionsInput.value, current });
      if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return; }
      _kiDraftCache[item.id] = serializeRewriteSections(resp.draft, KI_FIELD_NAMES);
      instructionsInput.value = '';
      editorHost.textContent = '';
      kiEditor.renderInto(editorHost, item.id);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerate';
    }
  });

  const body = h('div', null,
    basedOnDraft ? h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '10px' } }, 'Based on the pending draft for this Known Issue, not the published version.') : null,
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
      h('div', { style: { flex: '1' } }, instructionsInput),
      regenBtn
    ),
    editorHost
  );

  const footer = h('div', { class: 'modal__footer' },
    h('button', { class: 'btn btn--secondary', onClick: () => close() }, 'Close'),
    h('button', { class: 'btn btn--primary', id: 'ki-save-btn', onClick: () => saveKnownIssue(item) }, 'Save')
  );

  let close;
  ({ close } = modal(`Rewrite Known Issue — ${item.name || item.id}`, body, { wide: true, footer }));
}

async function saveKnownIssue(item) {
  const sections = parseRewriteSections(_kiDraftCache[item.id] || '', KI_FIELD_NAMES);
  const payload = { id: item.id, subject: sections.subject, summary: sections.summary, repro: sections.repro, workaround: sections.workaround };
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'UPDATE_KNOWN_ISSUE', payload });
    if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return; }
    swapButtonWithLink('ki-save-btn', { url: resp.url, label: 'Open in Known Issues org ↗' });
    toast('Known Issue updated.', 'success');
    delete _kiDraftCache[item.id];
  } catch (e) {
    toast(e.message, 'error');
  }
}

function workItemCell(item) {
  if (!item.workId) return h('span', null, '');
  return h('a', {
    href: `https://gus.my.salesforce.com/apex/ADM_WorkLocator?BugOrWorknumber=${encodeURIComponent(item.workId)}`,
    target: '_blank', rel: 'noopener', style: { fontSize: '11px' }
  }, item.workId);
}

function viewKi(item) {
  asyncModal(
    `${item.name || item.id}${item.subject ? ' — ' + item.subject : ''}`,
    () => chrome.runtime.sendMessage({ action: 'FETCH_KI_DETAIL', id: item.id }).then(resp => {
      if (!resp?.success) throw new Error(resp?.error || 'Failed to load.');
      return resp.ki;
    }),
    (ki) => {
      const field = (label, value) => h('div', { style: { marginBottom: '12px' } },
        fieldLabel(label, { marginBottom: '4px' }),
        richHtmlBox(value ? markdownToHtml(value) : '')
      );
      return h('div', null,
        item.workId ? h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' } }, 'Work Item: ', workItemCell(item)) : null,
        field('Summary', ki.summary),
        field('Repro Steps', ki.repro),
        field('Workaround', ki.workaround)
      );
    },
    { wide: true }
  );
}

function viewButton(item) {
  return h('button', {
    class: 'btn btn--ghost btn--sm', title: 'Preview Known Issue content',
    onClick: (e) => { e.stopPropagation(); viewKi(item); }
  }, '👁');
}

async function scoreKi(item) {
  _kiScoringId = item.id;
  render();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'SCORE_KNOWN_ISSUE', kiId: item.id });
    if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return; }
    _kiScores[item.id] = resp.score;
    showKiScoreDetail(item, resp.score);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    _kiScoringId = null;
    render();
  }
}

function showKiScoreDetail(item, score) {
  const s = score || _kiScores[item.id];
  if (!s) return;
  const rows = (s.criteria || []).map(c => h('tr', null,
    h('td', { style: { fontSize: '12px' } }, c.label || c.id),
    h('td', null, h('span', { class: `pill pill--${c.score >= c.max * 0.8 ? 'success' : c.score >= c.max * 0.5 ? 'warning' : 'error'}` }, `${c.score}/${c.max}`)),
    h('td', { style: { fontSize: '11px' } }, (c.passed || []).join('; ')),
    h('td', { style: { fontSize: '11px', color: 'var(--error)' } }, (c.issues || []).join('; '))
  ));
  const body = h('div', null,
    h('div', { style: { textAlign: 'center', marginBottom: '12px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Overall Score'),
      h('div', { style: { fontSize: '28px', fontWeight: '700' } }, String(s.overall))
    ),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, 'Criterion'), h('th', { style: { width: '80px' } }, 'Score'), h('th', null, 'Passed'), h('th', null, 'Issues'))),
      h('tbody', null, ...rows)
    )
  );
  modal(`Score — ${item.name || item.id}`, body, { wide: true });
}

function scorePill(item) {
  const s = _kiScores[item.id];
  if (_kiScoringId === item.id) return spinner('sm');
  if (s?.overall == null) {
    return h('button', { class: 'btn btn--ghost btn--sm', onClick: () => scoreKi(item) }, 'Score');
  }
  return h('span', { class: `pill pill--${scoreColor(s.overall)}`, style: { cursor: 'pointer' }, title: 'View score details and rescore', onClick: () => showKiScoreDetail(item, s) }, String(s.overall));
}

function truncatedCell(value, widthPct) {
  return h('td', {
    style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: `${widthPct}%`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    title: value || ''
  }, value || '');
}

function formatKiDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
}

function renderResultsTable(pageItems) {
  if (_kiLoading) {
    return h('div', { style: { padding: '24px', textAlign: 'center' } }, spinner('md'));
  }
  if (!pageItems.length) {
    return emptyState('🔍', 'No Known Issues found.');
  }
  const ind = (col) => _kiSorter.indicator(col);
  const sortTh = (col, label, width) => h('th', { style: { width, cursor: 'pointer' }, onClick: () => toggleKiSort(col) }, label + ind(col));
  return h('table', { class: 'data-table', style: { tableLayout: 'fixed', width: '100%' } },
    h('thead', null, h('tr', null,
      sortTh('name', 'Name', '8%'),
      sortTh('subject', 'Subject', '16%'),
      sortTh('cloud', 'Cloud', '8%'),
      sortTh('category', 'Category', '11%'),
      sortTh('status', 'Status', '8%'),
      sortTh('createdByName', 'Created By', '9%'),
      sortTh('approverName', 'Approver', '9%'),
      sortTh('createdDate', 'Created', '7%'),
      sortTh('lastModifiedDate', 'Modified', '7%'),
      sortTh('reportingCount', 'Impacted', '6%'),
      h('th', { style: { width: '11%' } }, 'Actions')
    )),
    h('tbody', null, ...pageItems.map(item => h('tr', null,
      h('td', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, h('a', { href: item.url, target: '_blank', rel: 'noopener' }, item.name || item.id)),
      h('td', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.subject || '' }, item.subject || ''),
      truncatedCell(item.cloud, 8),
      truncatedCell(item.category, 11),
      truncatedCell(item.status, 8),
      truncatedCell(item.createdByName, 9),
      truncatedCell(item.approverName, 9),
      truncatedCell(formatKiDate(item.createdDate), 7),
      truncatedCell(formatKiDate(item.lastModifiedDate), 7),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'right' } }, String(item.reportingCount || 0)),
      h('td', null,
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          viewButton(item),
          scorePill(item),
          h('button', {
            class: 'btn btn--ghost btn--sm',
            disabled: _kiRewriteLoadingId === item.id,
            onClick: () => startRewrite(item)
          }, _kiRewriteLoadingId === item.id ? '…' : 'Rewrite')
        )
      )
    )))
  );
}

function render() {
  if (!_container) return;
  const searchFocused = document.activeElement?.id === 'ki-search';
  _container.textContent = '';

  const crossMode = _kiCrossScope && _kiFilterText.trim().length >= 2;
  const filtered = crossMode ? (_kiSorter.col ? [..._kiCrossResults].sort(compareKis) : _kiCrossResults) : getFilteredKis();
  const totalPages = crossMode ? 1 : (Math.ceil(filtered.length / _pageSize) || 1);
  if (_page >= totalPages) _page = Math.max(0, totalPages - 1);
  const pageStart = crossMode ? 0 : _page * _pageSize;
  const pageItems = crossMode ? filtered : filtered.slice(pageStart, pageStart + _pageSize);

  const searchInput = h('input', {
    type: 'text', class: 'input', id: 'ki-search', style: { maxWidth: '280px' },
    placeholder: 'Search by name or subject…', value: _kiFilterText
  });
  searchInput.addEventListener('input', e => {
    _kiFilterText = e.target.value;
    _page = 0;
    clearTimeout(_renderDebounce);
    if (_kiCrossScope) _renderDebounce = setTimeout(() => runCrossSearch(_kiFilterText), 300);
    else _renderDebounce = setTimeout(render, 200);
  });
  if (searchFocused) {
    setTimeout(() => { const el = document.getElementById('ki-search'); if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, 0);
  }

  const crossScopeLabel = crossScopeToggle({
    label: 'Search all categories',
    title: 'Search ALL categories, not just the configured list — use this to find and score/rewrite a KI outside the usual scope.',
    checked: _kiCrossScope,
    onChange: (checked) => {
      _kiCrossScope = checked;
      _page = 0;
      if (_kiCrossScope) {
        if (_kiFilterText.trim().length >= 2) runCrossSearch(_kiFilterText);
        else render();
      } else {
        _crossSearchToken.next();
        _kiCrossResults = [];
        render();
      }
    }
  });

  const categoryFilter = multiSelect('ki-category-filter', 'Category', KI_CATEGORIES.map(c => ({ value: c, label: c })), _kiFilterCategories, (selected) => {
    _kiFilterCategories = selected;
    _page = 0;
    render();
  });

  const refreshBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: _kiLoading }, _kiLoading ? 'Loading…' : 'Refresh');
  refreshBtn.addEventListener('click', () => loadKnownIssues(true));

  const { sticky: stickySection, scroll: scrollSection } = stickyScrollLayout(_container);

  stickySection.appendChild(h('div', { class: 'tab-toolbar' },
    searchInput, crossScopeLabel, categoryFilter,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } }, refreshBtn)
  ));

  if (!_kiCrossScope) {
    stickySection.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', margin: '8px 0 0' } },
      `${filtered.length !== _kiAllItems.length ? `${filtered.length} of ${_kiAllItems.length}` : `${_kiAllItems.length}`} Known Issues`
    ));
  }

  if (crossMode && _kiCrossLoading) {
    scrollSection.appendChild(h('div', { style: { padding: '48px 24px', textAlign: 'center' } }, spinner('lg'),
      h('div', { style: { fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' } }, 'Searching all categories…')));
    return;
  }

  const paginationRow = crossMode ? null : paginationBar({
    page: _page, totalPages, pageStart, pageCount: pageItems.length, total: filtered.length,
    onPage: (p) => { _page = p; render(); }
  });

  scrollSection.appendChild(h('div', { class: 'card', style: { padding: '16px' } }, renderResultsTable(pageItems), paginationRow));
}
