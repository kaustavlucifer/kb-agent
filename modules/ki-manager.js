import { h, spinner, toast, modal, swapButtonWithLink, sectionsEditor, emptyState, multiSelect, richHtmlBox } from '../shared/ui.js';
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
  _kiCrossLoading = true;
  render();
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'SEARCH_KI_UNSCOPED', query: query.trim() });
    if (resp?.error) { toast(resp.error, 'error'); _kiCrossResults = []; }
    else { _kiCrossResults = resp?.items || []; }
  } catch (e) {
    toast(e.message, 'error');
    _kiCrossResults = [];
  } finally {
    _kiCrossLoading = false;
    render();
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

function getFilteredKis() {
  const signature = `${_kiFilterText}|${_kiFilterCategories.join(',')}`;
  if (_filteredMemo && _filteredMemo.items === _kiAllItems && _filteredMemo.signature === signature) {
    return _filteredMemo.result;
  }
  let filtered = _kiAllItems;
  if (_kiFilterCategories.length) filtered = filtered.filter(ki => _kiFilterCategories.includes(ki.category));
  if (_kiFilterText) {
    const term = _kiFilterText.toLowerCase();
    filtered = filtered.filter(ki => `${ki.name || ''} ${ki.subject || ''}`.toLowerCase().includes(term));
  }
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
    openRewriteModal(item);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    _kiRewriteLoadingId = null;
    render();
  }
}

function openRewriteModal(item) {
  const editorHost = h('div', null);
  kiEditor.renderInto(editorHost, item.id);

  const footer = h('div', { class: 'modal__footer' },
    h('button', { class: 'btn btn--secondary', onClick: () => close() }, 'Close'),
    h('button', { class: 'btn btn--primary', id: 'ki-save-btn', onClick: () => saveKnownIssue(item) }, 'Save')
  );

  let close;
  ({ close } = modal(`Rewrite Known Issue — ${item.name || item.id}`, editorHost, { wide: true, footer }));
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
  const content = h('div', { style: { minHeight: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, spinner('md'));
  modal(`${item.name || item.id}${item.subject ? ' — ' + item.subject : ''}`, content, { wide: true });

  chrome.runtime.sendMessage({ action: 'FETCH_KI_DETAIL', id: item.id }).then(resp => {
    content.style.display = '';
    content.style.minHeight = '';
    content.textContent = '';
    if (!resp?.success) {
      content.appendChild(h('div', { style: { color: 'var(--error)', fontSize: '12px' } }, resp?.error || 'Failed to load.'));
      return;
    }
    const ki = resp.ki;
    const field = (label, value) => h('div', { style: { marginBottom: '12px' } },
      h('div', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' } }, label),
      richHtmlBox(value ? markdownToHtml(value) : '')
    );
    content.appendChild(h('div', null,
      item.workId ? h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '14px' } }, 'Work Item: ', workItemCell(item)) : null,
      field('Summary', ki.summary),
      field('Repro Steps', ki.repro),
      field('Workaround', ki.workaround)
    ));
  }).catch(e => {
    content.style.display = '';
    content.style.minHeight = '';
    content.textContent = '';
    content.appendChild(h('div', { style: { color: 'var(--error)', fontSize: '12px' } }, e.message));
  });
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
  const color = s.overall >= 80 ? 'success' : s.overall >= 60 ? 'warning' : 'error';
  return h('span', { class: `pill pill--${color}`, style: { cursor: 'pointer' }, title: 'View score details and rescore', onClick: () => showKiScoreDetail(item, s) }, String(s.overall));
}

function truncatedCell(value, widthPct) {
  return h('td', {
    style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: `${widthPct}%`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    title: value || ''
  }, value || '');
}

function renderResultsTable(pageItems) {
  if (_kiLoading) {
    return h('div', { style: { padding: '24px', textAlign: 'center' } }, spinner('md'));
  }
  if (!pageItems.length) {
    return emptyState('🔍', 'No Known Issues found.');
  }
  return h('table', { class: 'data-table', style: { tableLayout: 'fixed', width: '100%' } },
    h('thead', null, h('tr', null,
      h('th', { style: { width: '9%' } }, 'Name'),
      h('th', { style: { width: '18%' } }, 'Subject'),
      h('th', { style: { width: '10%' } }, 'Cloud'),
      h('th', { style: { width: '14%' } }, 'Category'),
      h('th', { style: { width: '10%' } }, 'Status'),
      h('th', { style: { width: '10%' } }, 'Created By'),
      h('th', { style: { width: '10%' } }, 'Approver'),
      h('th', { style: { width: '7%' } }, 'Impacted'),
      h('th', { style: { width: '12%' } }, 'Actions')
    )),
    h('tbody', null, ...pageItems.map(item => h('tr', null,
      h('td', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, h('a', { href: item.url, target: '_blank', rel: 'noopener' }, item.name || item.id)),
      h('td', { style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.subject || '' }, item.subject || ''),
      truncatedCell(item.cloud, 10),
      truncatedCell(item.category, 14),
      truncatedCell(item.status, 10),
      truncatedCell(item.createdByName, 10),
      truncatedCell(item.approverName, 10),
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
  const filtered = crossMode ? _kiCrossResults : getFilteredKis();
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

  const crossScopeCheckbox = h('input', { type: 'checkbox' });
  crossScopeCheckbox.checked = _kiCrossScope;
  crossScopeCheckbox.addEventListener('change', e => {
    _kiCrossScope = e.target.checked;
    _page = 0;
    if (_kiCrossScope) {
      if (_kiFilterText.trim().length >= 2) runCrossSearch(_kiFilterText);
      else render();
    } else {
      _kiCrossResults = [];
      render();
    }
  });
  const crossScopeLabel = h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }, title: 'Search ALL categories, not just the configured list — use this to find and score/rewrite a KI outside the usual scope.' }, crossScopeCheckbox, 'Search all categories');

  const categoryFilter = multiSelect('ki-category-filter', 'Category', KI_CATEGORIES.map(c => ({ value: c, label: c })), _kiFilterCategories, (selected) => {
    _kiFilterCategories = selected;
    _page = 0;
    render();
  });

  const refreshBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: _kiLoading }, _kiLoading ? 'Loading…' : 'Refresh');
  refreshBtn.addEventListener('click', () => loadKnownIssues(true));

  const statsRow = _kiCrossScope ? null : h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' } },
    `${filtered.length !== _kiAllItems.length ? `${filtered.length} of ${_kiAllItems.length}` : `${_kiAllItems.length}`} Known Issues`
  );

  const paginationRow = crossMode ? null : h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '12px' } },
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: _page === 0, onClick: () => { _page--; render(); } }, '← Prev') : null,
    h('span', { style: { color: 'var(--text-secondary)' } },
      filtered.length ? `Showing ${pageStart + 1}–${pageStart + pageItems.length} of ${filtered.length} (Page ${_page + 1}/${totalPages})` : ''
    ),
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: _page >= totalPages - 1, onClick: () => { _page++; render(); } }, 'Next →') : null
  );

  const searchCard = h('div', { class: 'card', style: { padding: '16px' } },
    h('h3', { style: { fontSize: '14px', marginBottom: '10px' } }, 'Existing Known Issues'),
    h('div', { class: 'tab-toolbar', style: { marginBottom: '10px' } }, searchInput, crossScopeLabel, categoryFilter, refreshBtn),
    statsRow,
    (crossMode && _kiCrossLoading) ? h('div', { style: { padding: '24px', textAlign: 'center' } }, spinner('md')) : renderResultsTable(pageItems),
    paginationRow
  );

  _container.appendChild(searchCard);
}
