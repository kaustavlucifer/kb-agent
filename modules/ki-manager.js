import { h, spinner, toast, modal, swapButtonWithLink, sectionsEditor, emptyState, multiSelect, richHtmlBox, createSorter, stickyScrollLayout, scoreColor, crossScopeToggle, requestToken, paginationBar, fieldLabel, asyncModal, streamingStatus } from '../shared/ui.js';
import { streamClaude, extractJson } from '../shared/gateway.js';
import { SCORING_MODEL, SCORING_MAX_TOKENS, SCORING_RETRY_MAX_TOKENS, SCORE_GOOD_ENOUGH_THRESHOLD, STORAGE_KEYS } from '../shared/config.js';
import { localGet, localSet } from '../shared/storage.js';
import { KI_REWRITE_SYSTEM_PROMPT, KI_SCORING_SYSTEM_PROMPT, buildKiRewriteUserPrompt, buildKiScoreUserPrompt } from '../shared/ki-prompts.js';
import { parseRewriteSections, serializeRewriteSections, markdownToHtml } from '../shared/markdown.js';
import { KI_CATEGORIES } from '../data/ki_mapping.js';


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
let _kiScoresVersion = 0;
let _kiScores = {};
let _kiDraftCache = {};
let _kiWork = {};
const _kiJobs = new Map();
const _kiJobListeners = new Map();
const _kiSorter = createSorter(null);
const KI_WORK_FIELDS = ['basis', 'basedOnDraft', 'chatterNotes', 'chatterError', 'live', 'rewriteScore', 'gateDismissed'];

const _kiStateReady = localGet([STORAGE_KEYS.KI_WORK]).then(data => {
  const stored = data[STORAGE_KEYS.KI_WORK] || {};
  for (const [id, entry] of Object.entries(stored)) {
    if (entry.score) _kiScores[id] = entry.score;
    if (entry.draft) _kiDraftCache[id] = entry.draft;
    _kiWork[id] = Object.fromEntries(KI_WORK_FIELDS.filter(k => entry[k] !== undefined).map(k => [k, entry[k]]));
  }
  _kiScoresVersion++;
}).catch(() => {});

let _kiPersistTimer = null;
function persistKiState() {
  clearTimeout(_kiPersistTimer);
  _kiPersistTimer = setTimeout(() => {
    const ids = new Set([...Object.keys(_kiScores), ...Object.keys(_kiWork), ...Object.keys(_kiDraftCache).filter(k => !k.startsWith('ext-'))]);
    const out = {};
    for (const id of ids) {
      const entry = { ...(_kiWork[id] || {}) };
      if (_kiScores[id]) entry.score = _kiScores[id];
      if (_kiDraftCache[id]) entry.draft = _kiDraftCache[id];
      out[id] = entry;
    }
    localSet({ [STORAGE_KEYS.KI_WORK]: out }).catch(() => {});
  }, 300);
}

function setKiScore(id, score) {
  _kiScores[id] = score;
  _kiScoresVersion++;
  persistKiState();
}

function clearKiScore(id) {
  delete _kiScores[id];
  _kiScoresVersion++;
  persistKiState();
}

function kiWork(id) {
  return _kiWork[id] || (_kiWork[id] = {});
}

function updateKiWork(id, patch) {
  Object.assign(kiWork(id), patch);
  persistKiState();
}

function setKiDraft(id, text) {
  if (text) _kiDraftCache[id] = text;
  else delete _kiDraftCache[id];
  persistKiState();
}

function notifyKiJob(id) {
  const listener = _kiJobListeners.get(id);
  if (listener) listener();
}

function runKiJob(id, kind, fn) {
  if (_kiJobs.has(id)) return _kiJobs.get(id).promise;
  const job = { kind, partial: '', error: null };
  job.promise = (async () => {
    try {
      return await fn(job);
    } catch (e) {
      job.error = e.message;
      throw e;
    } finally {
      _kiJobs.delete(id);
      notifyKiJob(id);
      render();
    }
  })();
  _kiJobs.set(id, job);
  notifyKiJob(id);
  render();
  return job.promise;
}
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
  setCachedText: (key, text) => { _kiDraftCache[key] = text; if (!String(key).startsWith('ext-')) persistKiState(); },
  fields: KI_FIELDS
});

export function mount(container) {
  _container = container;
  render();
  _kiStateReady.then(() => { if (_container) render(); });
  loadKnownIssues();
}

export function unmount() {
  _container = null;
  if (_renderDebounce) { clearTimeout(_renderDebounce); _renderDebounce = null; }
}

export function openKiDraftModal({ draft, caseNumber, workId, onCreated }) {
  const key = `ext-${Date.now()}`;
  _kiDraftCache[key] = serializeRewriteSections(draft, KI_FIELD_NAMES);

  const categorySelect = h('select', { class: 'input', style: { maxWidth: '200px' } },
    ...KI_CATEGORIES.map(c => h('option', { value: c }, c))
  );

  const editorHost = h('div', null);
  kiEditor.renderInto(editorHost, key);
  const workLookup = gusWorkLookup(workId);

  const body = h('div', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '14px', flexWrap: 'wrap' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Category *'),
        categorySelect
      ),
      workLookup.el
    ),
    editorHost
  );

  const footer = h('div', { class: 'modal__footer' },
    h('button', { class: 'btn btn--secondary', onClick: () => close() }, 'Close'),
    h('button', { class: 'btn btn--primary', id: 'ki-create-btn', onClick: () => createKnownIssue(key, categorySelect.value, workLookup.value(), onCreated) }, 'Create Known Issue (Draft)')
  );

  let close;
  ({ close } = modal(`Draft Known Issue${caseNumber ? ` — Case #${caseNumber}` : ''}`, body, { wide: true, footer }));
}

function gusWorkLookup(initial) {
  let selected = initial ? { name: initial } : null;
  let debounce = null;
  const searchToken = requestToken();
  const labelEl = h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'GUS Work');
  const selectedEl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
  const input = h('input', { class: 'input', type: 'text', placeholder: 'Search W-number or subject…', style: { width: '240px' } });
  const results = h('div', { style: { display: 'none', position: 'absolute', top: '100%', left: '0', zIndex: '20', width: '480px', maxHeight: '260px', overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)', marginTop: '4px' } });
  const searchBox = h('div', { style: { position: 'relative', display: 'none' } }, input, results);

  const showResults = (nodes) => {
    results.textContent = '';
    nodes.forEach(n => results.appendChild(n));
    results.style.display = nodes.length ? 'block' : 'none';
  };
  const choose = (item) => {
    selected = item;
    input.value = '';
    showResults([]);
    renderSelected();
  };
  const workLink = (name) => h('a', { href: `https://gus.my.salesforce.com/apex/ADM_WorkLocator?BugOrWorknumber=${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener', style: { fontSize: '12px', color: 'var(--primary)' } }, name);
  const renderSelected = () => {
    selectedEl.textContent = '';
    if (selected) {
      selectedEl.appendChild(workLink(selected.name));
      if (selected.status) selectedEl.appendChild(h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, `${selected.recordType ? `${selected.recordType} · ` : ''}${selected.status}`));
    } else {
      selectedEl.appendChild(h('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, 'None'));
    }
    selectedEl.appendChild(h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => {
      const open = searchBox.style.display === 'none';
      searchBox.style.display = open ? 'block' : 'none';
      if (open) input.focus();
    } }, selected ? 'Change' : 'Link'));
    if (selected) selectedEl.appendChild(h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => { selected = null; renderSelected(); } }, 'Clear'));
  };

  const runSearch = async (term) => {
    const token = searchToken.next();
    showResults([h('div', { style: { padding: '8px 10px', fontSize: '12px', color: 'var(--text-muted)' } }, 'Searching GUS…')]);
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'SEARCH_GUS_WORK', query: term });
      if (!searchToken.isCurrent(token)) return;
      if (resp?.error) { showResults([h('div', { style: { padding: '8px 10px', fontSize: '12px', color: 'var(--error)' } }, resp.error)]); return; }
      const items = resp?.items || [];
      if (!items.length) { showResults([h('div', { style: { padding: '8px 10px', fontSize: '12px', color: 'var(--text-muted)' } }, 'No matching Bugs or Investigations.')]); return; }
      showResults(items.map(item => h('div', {
        style: { padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' },
        onMouseenter: (e) => { e.currentTarget.style.background = 'var(--surface-raised)'; },
        onMouseleave: (e) => { e.currentTarget.style.background = ''; },
        onClick: () => choose(item)
      },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
          h('strong', null, item.name),
          h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, `${item.recordType} · ${item.status}`),
          item.productTag ? h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, item.productTag) : null
        ),
        h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' } }, item.subject)
      )));
    } catch (e) {
      if (searchToken.isCurrent(token)) showResults([h('div', { style: { padding: '8px 10px', fontSize: '12px', color: 'var(--error)' } }, e.message)]);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const term = input.value.trim();
    if (term.length < 3) { searchToken.next(); showResults([]); return; }
    debounce = setTimeout(() => runSearch(term), 350);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); showResults([]); searchBox.style.display = 'none'; } });

  renderSelected();
  return {
    el: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, labelEl, selectedEl, searchBox),
    value: () => selected?.name || ''
  };
}

async function createKnownIssue(key, category, workId, onCreated) {
  const sections = parseRewriteSections(_kiDraftCache[key] || '', KI_FIELD_NAMES);
  const payload = { subject: sections.subject, summary: sections.summary, repro: sections.repro, workaround: sections.workaround, category, workId };
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
  } else if (col === 'score') {
    va = _kiScores[a.id]?.overall ?? -1;
    vb = _kiScores[b.id]?.overall ?? -1;
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
  const signature = `${_kiFilterText}|${_kiFilterCategories.join(',')}|${_kiSorter.col}|${_kiSorter.dir}|${_kiSorter.col === 'score' ? _kiScoresVersion : ''}`;
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

function kiSectionsMarkdown(sections) {
  return [
    sections.subject ? `## Subject\n${sections.subject}` : '',
    sections.summary ? `## Summary\n${sections.summary}` : '',
    sections.repro ? `## Repro Steps\n${sections.repro}` : '',
    sections.workaround ? `## Workaround\n${sections.workaround}` : ''
  ].filter(Boolean).join('\n\n');
}

function partialJsonField(text, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
  if (!m) return '';
  let raw = m[1];
  const tail = /(\\+)u[0-9a-fA-F]{0,3}$/.exec(raw);
  if (tail && tail[1].length % 2 === 1) raw = raw.slice(0, tail.index + tail[1].length - 1);
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

async function streamKiJson({ system, user, maxTokensList, temperature, onPartial }) {
  let parsed = null;
  let truncated = false;
  for (const maxTokens of maxTokensList) {
    let stopReason = null;
    const full = await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      temperature,
      model: SCORING_MODEL,
      onDelta: onPartial ? (_, text) => onPartial(text) : undefined,
      onDone: (_, meta) => { stopReason = meta?.stopReason || null; }
    });
    truncated = stopReason === 'max_tokens';
    parsed = extractJson(full);
    if (parsed && !truncated) break;
  }
  return { parsed, truncated };
}

async function scoreKiContent(item, sections) {
  const { parsed, truncated } = await streamKiJson({
    system: KI_SCORING_SYSTEM_PROMPT,
    user: buildKiScoreUserPrompt(sections),
    maxTokensList: [SCORING_MAX_TOKENS, SCORING_RETRY_MAX_TOKENS],
    temperature: 0.1
  });
  if (parsed?.overall == null) throw new Error(truncated ? 'Score response was cut off by the token limit even after retry.' : 'Could not parse score.');
  chrome.runtime.sendMessage({ action: 'LOG_KI_SIGNATURE', kind: 'ki-scored', kiId: item.id }).catch(() => {});
  return parsed;
}

async function loadKiContext(item) {
  const work = kiWork(item.id);
  if (work.basis && work.live) return work;
  const ctx = await chrome.runtime.sendMessage({ action: 'PREPARE_KI_REWRITE', kiId: item.id });
  if (!ctx?.success) throw new Error(ctx?.error || 'Failed to load the Known Issue.');
  updateKiWork(item.id, { basis: ctx.basis, basedOnDraft: ctx.basedOnDraft, chatterNotes: ctx.chatterNotes || '', chatterError: ctx.chatterError || null, live: ctx.live });
  return kiWork(item.id);
}

function scoreKiJob(item) {
  return runKiJob(item.id, 'score', async () => {
    const work = await loadKiContext(item);
    const score = await scoreKiContent(item, work.live);
    setKiScore(item.id, score);
    return score;
  });
}

function rewriteKiJob(item, instructions) {
  return runKiJob(item.id, 'rewrite', async (job) => {
    const work = await loadKiContext(item);
    const current = _kiDraftCache[item.id] ? parseRewriteSections(_kiDraftCache[item.id], KI_FIELD_NAMES) : null;
    const { parsed, truncated } = await streamKiJson({
      system: KI_REWRITE_SYSTEM_PROMPT,
      user: buildKiRewriteUserPrompt(current || work.basis, work.chatterNotes, instructions),
      maxTokensList: [3000, 6000],
      temperature: 0.2,
      onPartial: (text) => { job.partial = text; notifyKiJob(item.id); }
    });
    if (!parsed) throw new Error(truncated ? 'Rewrite was cut off by the token limit even after retry.' : 'Could not parse the rewrite.');
    setKiDraft(item.id, serializeRewriteSections(parsed, KI_FIELD_NAMES));
    updateKiWork(item.id, { rewriteScore: null });
    chrome.runtime.sendMessage({ action: 'LOG_KI_SIGNATURE', kind: 'ki-rewrite-generated', kiId: item.id }).catch(() => {});
    job.kind = 'rescore';
    notifyKiJob(item.id);
    try {
      const rewriteScore = await scoreKiContent(item, parsed);
      updateKiWork(item.id, { rewriteScore });
    } catch (e) {
      updateKiWork(item.id, { rewriteScore: { error: e.message } });
    }
    return parsed;
  });
}

function startRewrite(item) {
  const instructionsInput = h('textarea', {
    class: 'input', rows: '2',
    placeholder: 'Optional: extra instructions for the rewrite (e.g. "mention the Winter release", "shorten the summary", "add a workaround using a manual refresh"). Applied when you regenerate.',
    style: { width: '100%', marginBottom: '12px', fontSize: '12px', resize: 'vertical' }
  });
  const scoreEl = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } });
  const compareBtn = h('button', { class: 'btn btn--ghost btn--sm' }, 'Compare');
  const regenBtn = h('button', { class: 'btn btn--ghost btn--sm' }, 'Regenerate');
  const updateBtn = h('button', { class: 'btn btn--primary btn--sm', id: 'ki-save-btn' }, 'Update KI');
  const noteEl = h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' } });
  const detailEl = h('div', { style: { display: 'none', marginBottom: '12px', padding: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' } });
  const streamEl = h('div', { style: { fontSize: '13px', lineHeight: '1.6', maxHeight: '520px', overflowY: 'auto' } });
  const ui = { closed: false, detailKind: null, editorShownFor: null, saved: false };

  const hideDetail = () => { detailEl.style.display = 'none'; detailEl.textContent = ''; ui.detailKind = null; };
  const showDetail = (kind, build) => {
    if (ui.detailKind === kind) { hideDetail(); return; }
    ui.detailKind = kind;
    detailEl.textContent = '';
    detailEl.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' } },
      h('button', { class: 'btn btn--ghost btn--sm', onClick: hideDetail }, 'Hide')));
    detailEl.appendChild(build());
    detailEl.style.display = '';
  };

  const scoreBadge = (label, score) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
    h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, label),
    h('span', { class: `pill pill--${scoreColor(score.overall)}`, style: { cursor: 'pointer' }, title: 'View score details', onClick: () => showDetail(`score-${label}`, () => kiScoreDetailBody(score)) }, String(score.overall)));

  const startGenerate = () => {
    const instructions = instructionsInput.value.trim().slice(0, 2000);
    instructionsInput.value = '';
    ui.editorShownFor = null;
    hideDetail();
    rewriteKiJob(item, instructions).catch(e => { if (!ui.closed) toast(e.message, 'error'); });
    update();
  };

  const update = () => {
    if (ui.closed) return;
    const job = _kiJobs.get(item.id);
    const work = kiWork(item.id);
    const draft = _kiDraftCache[item.id];
    const current = _kiScores[item.id];
    const busy = !!job;

    const notes = [];
    if (work.basedOnDraft) notes.push('Based on the pending draft for this Known Issue, not the published version.');
    if (work.chatterError) notes.push(`Chatter notes could not be loaded (${work.chatterError}), so this rewrite does not use them.`);
    noteEl.textContent = notes.join(' ');
    noteEl.style.display = notes.length ? '' : 'none';

    scoreEl.textContent = '';
    if (current?.overall != null) scoreEl.appendChild(scoreBadge('Current:', current));
    if (job?.kind === 'rescore') {
      scoreEl.appendChild(spinner('sm'));
      scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Scoring rewrite…'));
    } else if (work.rewriteScore?.overall != null && draft) {
      scoreEl.appendChild(scoreBadge('New:', work.rewriteScore));
    } else if (work.rewriteScore?.error && draft) {
      scoreEl.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--error)' } }, 'Rewrite score failed'));
    }

    regenBtn.disabled = busy;
    regenBtn.textContent = job?.kind === 'rewrite' ? 'Generating…' : (draft ? 'Regenerate' : 'Rewrite');
    compareBtn.disabled = busy || !draft;
    updateBtn.disabled = busy || !draft || ui.saved;

    if (job && job.kind !== 'rescore') {
      ui.editorShownFor = null;
      if (job.kind === 'score') { streamingStatus(streamEl, 'Scoring this Known Issue before rewrite…'); return; }
      if (!job.partial) { streamingStatus(streamEl, 'Rewriting…'); return; }
      streamEl.textContent = '';
      streamEl.appendChild(richHtmlBox(markdownToHtml(kiSectionsMarkdown({
        subject: partialJsonField(job.partial, 'subject'),
        summary: partialJsonField(job.partial, 'summary'),
        repro: partialJsonField(job.partial, 'repro'),
        workaround: partialJsonField(job.partial, 'workaround')
      }))));
      return;
    }

    if (draft) {
      if (ui.editorShownFor !== draft) {
        streamEl.textContent = '';
        kiEditor.renderInto(streamEl, item.id);
        ui.editorShownFor = draft;
      }
      return;
    }

    ui.editorShownFor = null;
    if (ui.saved) {
      streamEl.textContent = '';
      streamEl.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', padding: '8px 0' } }, 'Known Issue updated. Use Rewrite to start a new revision from the saved content.'));
      return;
    }
    if (current?.overall != null && current.overall >= SCORE_GOOD_ENOUGH_THRESHOLD) {
      streamEl.textContent = '';
      streamEl.appendChild(h('div', { style: { padding: '4px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
          h('div', { style: { fontSize: '22px', fontWeight: '700', color: 'var(--success)' } }, String(current.overall)),
          h('div', null,
            h('div', { style: { fontSize: '13px', fontWeight: '600' } }, 'Already high quality'),
            h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' } },
              `This Known Issue scores ${current.overall}, at or above the good-enough threshold of ${SCORE_GOOD_ENOUGH_THRESHOLD}. A rewrite may add little value — but you can add instructions above and rewrite anyway.`)
          )
        ),
        h('button', { class: 'btn btn--secondary btn--sm', onClick: startGenerate }, 'Rewrite anyway')
      ));
      return;
    }
    streamingStatus(streamEl, 'Preparing…');
  };

  regenBtn.addEventListener('click', startGenerate);
  compareBtn.addEventListener('click', () => showDetail('compare', () => kiComparisonBody(kiWork(item.id).basis, parseRewriteSections(_kiDraftCache[item.id] || '', KI_FIELD_NAMES))));
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    const saved = await saveKnownIssue(item);
    if (!saved) { update(); return; }
    ui.saved = true;
    hideDetail();
    update();
  });

  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${item.name || item.id}${item.subject ? ' — ' + item.subject : ''}`),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexShrink: '0' } }, scoreEl, compareBtn, regenBtn, updateBtn)
    ),
    noteEl,
    detailEl,
    instructionsInput,
    streamEl
  );

  modal(`Rewrite Known Issue — ${item.name || item.id}`, content, {
    wide: true,
    onClose: () => { ui.closed = true; if (_kiJobListeners.get(item.id) === update) _kiJobListeners.delete(item.id); }
  });
  _kiJobListeners.set(item.id, update);
  update();

  _kiStateReady.then(() => {
    if (ui.closed) return;
    update();
    if (_kiJobs.has(item.id) || _kiDraftCache[item.id] || ui.saved) return;
    autoRewriteKi(item).catch(e => {
      if (ui.closed) return;
      streamEl.textContent = '';
      streamEl.appendChild(h('div', { style: { color: 'var(--error)', fontSize: '12px' } }, e.message));
    }).finally(update);
  });
}

async function autoRewriteKi(item) {
  await loadKiContext(item);
  let score = _kiScores[item.id];
  if (score?.overall == null) score = await scoreKiJob(item);
  if (_kiJobs.has(item.id) || _kiDraftCache[item.id]) return;
  if (score?.overall != null && score.overall >= SCORE_GOOD_ENOUGH_THRESHOLD) return;
  await rewriteKiJob(item, '');
}

function kiComparisonBody(original, rewritten) {
  const column = (title, sections, accent) => h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
    h('div', { style: { fontSize: '11px', fontWeight: '700', color: accent, textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: `2px solid ${accent}` } }, title),
    ...KI_FIELDS.map(f => h('div', { style: { marginBottom: '12px' } },
      fieldLabel(f.label, { marginBottom: '4px' }),
      richHtmlBox(sections?.[f.field] ? markdownToHtml(sections[f.field]) : '')
    ))
  );
  return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', maxHeight: '50vh', overflow: 'auto' } },
    column('Original', original, 'var(--text-muted)'),
    column('Rewritten', rewritten, 'var(--primary)')
  );
}

async function saveKnownIssue(item) {
  const sections = parseRewriteSections(_kiDraftCache[item.id] || '', KI_FIELD_NAMES);
  const payload = { id: item.id, subject: sections.subject, summary: sections.summary, repro: sections.repro, workaround: sections.workaround };
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'UPDATE_KNOWN_ISSUE', payload });
    if (!resp?.success) { toast(resp?.error || 'Something went wrong.', 'error'); return null; }
    swapButtonWithLink('ki-save-btn', { url: resp.url, label: 'Open in Known Issues org ↗' });
    toast('Known Issue updated.', 'success');
    setKiDraft(item.id, null);
    updateKiWork(item.id, { basis: sections, basedOnDraft: true, live: sections, rewriteScore: null });
    clearKiScore(item.id);
    render();
    return sections;
  } catch (e) {
    toast(e.message, 'error');
    return null;
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
  if (_kiJobs.has(item.id)) return;
  try {
    const score = await scoreKiJob(item);
    toast(`${item.name || 'Known Issue'} scored ${score.overall}. Click the score to see details.`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function kiScoreDetailBody(s) {
  const rows = (s.criteria || []).map(c => h('tr', null,
    h('td', { style: { fontSize: '12px' } }, c.label || c.id),
    h('td', null, h('span', { class: `pill pill--${c.score >= c.max * 0.8 ? 'success' : c.score >= c.max * 0.5 ? 'warning' : 'error'}` }, `${c.score}/${c.max}`)),
    h('td', { style: { fontSize: '11px' } }, (c.passed || []).join('; ')),
    h('td', { style: { fontSize: '11px', color: 'var(--error)' } }, (c.issues || []).join('; '))
  ));
  return h('div', null,
    h('div', { style: { textAlign: 'center', marginBottom: '12px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, 'Overall Score'),
      h('div', { style: { fontSize: '28px', fontWeight: '700' } }, String(s.overall))
    ),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, 'Criterion'), h('th', { style: { width: '80px' } }, 'Score'), h('th', null, 'Passed'), h('th', null, 'Issues'))),
      h('tbody', null, ...rows)
    )
  );
}

function showKiScoreDetail(item, score) {
  const s = score || _kiScores[item.id];
  if (!s) return;
  modal(`Score — ${item.name || item.id}`, kiScoreDetailBody(s), { wide: true });
}

function scoreCell(item) {
  const s = _kiScores[item.id];
  if (_kiJobs.get(item.id)?.kind === 'score') return spinner('sm');
  if (s?.overall == null) return h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—');
  return h('span', { class: `pill pill--${scoreColor(s.overall)}`, style: { cursor: 'pointer' }, title: 'View score details', onClick: () => showKiScoreDetail(item, s) }, String(s.overall));
}

function scoreButton(item) {
  const scored = _kiScores[item.id]?.overall != null;
  return h('button', {
    class: 'btn btn--ghost btn--sm',
    disabled: _kiJobs.has(item.id),
    title: scored ? 'Rescore this Known Issue' : 'Score this Known Issue',
    onClick: () => scoreKi(item)
  }, scored ? 'Rescore' : 'Score');
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
      sortTh('subject', 'Subject', '13%'),
      sortTh('cloud', 'Cloud', '8%'),
      sortTh('category', 'Category', '11%'),
      sortTh('status', 'Status', '8%'),
      sortTh('createdByName', 'Created By', '9%'),
      sortTh('approverName', 'Approver', '9%'),
      sortTh('createdDate', 'Created', '7%'),
      sortTh('lastModifiedDate', 'Modified', '7%'),
      sortTh('reportingCount', 'Impacted', '6%'),
      sortTh('score', 'Score', '5%'),
      h('th', { style: { width: '13%' } }, 'Actions')
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
      h('td', null, scoreCell(item)),
      h('td', null,
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          viewButton(item),
          scoreButton(item),
          h('button', { class: 'btn btn--ghost btn--sm', title: _kiDraftCache[item.id] ? 'Open the saved rewrite' : 'Score and rewrite this Known Issue', onClick: () => startRewrite(item) },
            _kiJobs.get(item.id)?.kind === 'rewrite' || _kiJobs.get(item.id)?.kind === 'rescore' ? 'Rewriting…' : (_kiDraftCache[item.id] ? 'Rewrite •' : 'Rewrite'))
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
