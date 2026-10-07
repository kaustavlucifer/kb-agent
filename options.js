import { STORAGE_KEYS, SETTINGS_SCHEMA, MODEL_CHOICES, currentSettings, applySettings, articleUrl, ORGCS_BASE, KI_BASE } from './shared/config.js';
import { h, modal, progressBar } from './shared/ui.js';
import { refreshModelCatalog } from './shared/gateway.js';
import { localGet, localSet } from './shared/storage.js';

const tokenEl = document.getElementById('token');
const bypassEl = document.getElementById('bypass-guard-rails');
const statusEl = document.getElementById('status');
const modelsWrap = document.getElementById('models');
const thresholdsWrap = document.getElementById('thresholds');

const modelItems = SETTINGS_SCHEMA.filter(s => s.kind === 'model');
const numberItems = SETTINGS_SCHEMA.filter(s => s.kind === 'number');

const controls = {};
let _modelCatalog = null;

function readableModelLabel(id) {
  const parts = id.replace(/^claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p));
  const family = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : id;
  const version = parts.slice(1).join('.');
  return `Claude ${family}${version ? ' ' + version : ''}`;
}

function labelForCatalogEntry(m) {
  return (m.label && m.label !== m.value) ? m.label : readableModelLabel(m.value);
}

function modelOptionsFor(item, currentValue) {
  const dynamic = !!(_modelCatalog && _modelCatalog.length);
  const catalog = dynamic ? _modelCatalog : MODEL_CHOICES;
  const options = catalog.map(m => {
    let label = labelForCatalogEntry(m);
    if (dynamic && m.value === item.default) label += ' (default)';
    return { value: m.value, label, title: m.value };
  });
  if (currentValue && !options.some(o => o.value === currentValue)) {
    options.push({ value: currentValue, label: `${currentValue} (saved — not in your gateway list)`, title: currentValue });
  }
  if (!options.some(o => o.value === item.default)) {
    options.push({ value: item.default, label: `${readableModelLabel(item.default)} (default)`, title: item.default });
  }
  return options;
}

function fieldShell(item, control) {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.textContent = item.label;
  label.setAttribute('for', `opt-${item.key}`);
  const help = document.createElement('div');
  help.className = 'help';
  help.textContent = item.help;
  field.appendChild(label);
  field.appendChild(control);
  field.appendChild(help);
  return field;
}

function fillModelSelect(select, item, value) {
  select.textContent = '';
  for (const m of modelOptionsFor(item, value)) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    opt.title = m.title;
    select.appendChild(opt);
  }
  select.value = value;
}

function buildModelField(item, value) {
  const select = document.createElement('select');
  select.id = `opt-${item.key}`;
  fillModelSelect(select, item, value);
  controls[item.key] = { kind: 'model', read: () => select.value };
  return fieldShell(item, select);
}

function refreshModelDropdowns() {
  for (const item of modelItems) {
    const select = document.getElementById(`opt-${item.key}`);
    if (select) fillModelSelect(select, item, select.value);
  }
}

function buildNumberField(item, value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'input';
  input.id = `opt-${item.key}`;
  input.min = item.min;
  input.max = item.max;
  input.step = item.step || 1;
  input.value = value;
  controls[item.key] = { kind: 'number', item, read: () => input.value };
  return fieldShell(item, input);
}

function renderForm() {
  const current = currentSettings();
  modelsWrap.textContent = '';
  thresholdsWrap.textContent = '';
  for (const item of modelItems) modelsWrap.appendChild(buildModelField(item, current[item.key]));
  for (const item of numberItems) thresholdsWrap.appendChild(buildNumberField(item, current[item.key]));
}

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color || 'var(--text-secondary)';
}

async function load() {
  const data = await localGet([STORAGE_KEYS.GATEWAY_TOKEN, STORAGE_KEYS.BYPASS_GUARD_RAILS, STORAGE_KEYS.SETTINGS, STORAGE_KEYS.MODEL_CATALOG]);
  if (data[STORAGE_KEYS.GATEWAY_TOKEN]) tokenEl.placeholder = '••••••••  (saved)';
  if (data[STORAGE_KEYS.BYPASS_GUARD_RAILS]) bypassEl.checked = true;
  applySettings(data[STORAGE_KEYS.SETTINGS]);
  _modelCatalog = data[STORAGE_KEYS.MODEL_CATALOG]?.models || null;
  renderForm();
  fetchModelCatalog(false);
}

async function fetchModelCatalog(force) {
  const statusEl2 = document.getElementById('model-refresh-status');
  if (force && statusEl2) statusEl2.textContent = 'Loading…';
  const { catalog, refreshed, error } = await refreshModelCatalog({ force }).catch(e => ({ error: e.message }));
  if (refreshed) {
    _modelCatalog = catalog.models;
    refreshModelDropdowns();
    if (statusEl2) statusEl2.textContent = `${catalog.models.length} models`;
  } else if (force && statusEl2) {
    statusEl2.textContent = `Failed${error ? `: ${error}` : ''}`;
  }
}

document.getElementById('refresh-models-btn').addEventListener('click', () => fetchModelCatalog(true));

function collectSettings() {
  const out = {};
  const errors = [];
  for (const item of SETTINGS_SCHEMA) {
    const ctrl = controls[item.key];
    if (!ctrl) continue;
    if (ctrl.kind === 'model') {
      out[item.key] = ctrl.read();
    } else {
      const n = Number(ctrl.read());
      if (!Number.isFinite(n) || n < item.min || n > item.max) {
        errors.push(`${item.label} must be between ${item.min} and ${item.max}.`);
        continue;
      }
      out[item.key] = n;
    }
  }
  return { out, errors };
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const { out, errors } = collectSettings();
  if (errors.length) { setStatus(errors[0], 'var(--error)'); return; }

  const token = tokenEl.value.trim();
  const updates = {
    [STORAGE_KEYS.BYPASS_GUARD_RAILS]: bypassEl.checked,
    [STORAGE_KEYS.SETTINGS]: out
  };
  if (token) updates[STORAGE_KEYS.GATEWAY_TOKEN] = token;
  await localSet(updates);
  applySettings(out);
  setStatus('Saved.', 'var(--success)');
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.SETTINGS);
  applySettings({});
  renderForm();
  setStatus('Reset to defaults and saved.', 'var(--success)');
});

document.getElementById('test-btn').addEventListener('click', async () => {
  setStatus('Testing…', 'var(--text-secondary)');
  const resp = await chrome.runtime.sendMessage({ action: 'VERIFY_AI_TOKEN' });
  if (resp?.connected) setStatus('Connected.', 'var(--success)');
  else setStatus('Failed: ' + (resp?.error || 'Unknown error'), 'var(--error)');
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove([
    STORAGE_KEYS.ALL_ARTICLES, STORAGE_KEYS.ALL_ARTICLES_AT, STORAGE_KEYS.ARTICLE_SCORES,
    STORAGE_KEYS.DEDUP_RESULTS, STORAGE_KEYS.DEDUP_AT, STORAGE_KEYS.RECENT_CASES,
    STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT,
    STORAGE_KEYS.AUTH_CACHE, STORAGE_KEYS.MERGE_CACHE, STORAGE_KEYS.MODEL_CATALOG, STORAGE_KEYS.KI_WORK
  ]);
  setStatus('Cache cleared.', 'var(--text-secondary)');
});

const KIND_LABELS = {
  'case-scan': 'Cases scanned',
  'article-scored': 'Articles scored',
  'rewrite-generated': 'Rewrites generated',
  'rewrite-published': 'Rewrites published',
  'ki-created': 'KIs created',
  'ki-updated': 'KIs updated',
  'ki-rewrite-generated': 'KI rewrites generated',
  'ki-scored': 'KIs scored'
};

const kiRecordUrl = id => `${KI_BASE}/lightning/r/Known_Issue__c/${id}/view`;

const KIND_RECORD_URL = {
  'case-scan': id => `${ORGCS_BASE}/lightning/r/Case/${id}/view`,
  'article-scored': articleUrl,
  'rewrite-generated': articleUrl,
  'rewrite-published': articleUrl,
  'ki-created': kiRecordUrl,
  'ki-updated': kiRecordUrl,
  'ki-rewrite-generated': kiRecordUrl,
  'ki-scored': kiRecordUrl
};

function recordLink(record) {
  const toUrl = KIND_RECORD_URL[record.kind];
  if (!toUrl || !record.parentId) return record.label;
  return h('a', { href: toUrl(record.parentId), target: '_blank', rel: 'noopener' }, record.label);
}

document.getElementById('analytics-btn').addEventListener('click', runAnalytics);

const updateBtn = document.getElementById('update-check-btn');
const updateStatus = document.getElementById('update-status');

async function runUpdateCheck(force) {
  updateBtn.disabled = true;
  updateStatus.textContent = 'Checking…';
  updateStatus.style.color = 'var(--text-secondary)';
  try {
    const r = await chrome.runtime.sendMessage({ action: 'CHECK_FOR_UPDATE', force });
    updateStatus.textContent = '';
    if (!r?.ok) {
      updateStatus.style.color = 'var(--error)';
      updateStatus.textContent = `Check failed${r?.error ? `: ${r.error}` : ''} (current v${r?.current || chrome.runtime.getManifest().version})`;
    } else if (r.latest && r.updateAvailable) {
      updateStatus.style.color = 'var(--warning)';
      updateStatus.append(`v${r.latest} available (current v${r.current}) — `, h('a', { href: r.downloadUrl, target: '_blank', rel: 'noopener' }, 'Download'));
    } else {
      updateStatus.style.color = 'var(--success)';
      updateStatus.textContent = `Up to date (v${r.current})`;
    }
  } catch (e) {
    updateStatus.style.color = 'var(--error)';
    updateStatus.textContent = `Check failed: ${e.message}`;
  } finally {
    updateBtn.disabled = false;
  }
}

updateBtn.addEventListener('click', () => runUpdateCheck(true));
runUpdateCheck(false);

function runAnalytics() {
  const btn = document.getElementById('analytics-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';

  const progressEl = h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, 'Starting…');
  const port = chrome.runtime.connect({ name: 'kba-audit' });
  let finished = false;
  const resetButton = () => { btn.disabled = false; btn.textContent = 'Run Analytics'; };
  const showError = (message) => {
    progressEl.textContent = '';
    progressEl.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + message));
    resetButton();
  };
  const ref = modal('Usage Analytics', progressEl, {
    footer: h('div', { class: 'modal__footer' },
      h('button', { class: 'btn btn--secondary', onClick: () => { port.disconnect(); ref.close(); } }, 'Close')
    ),
    onClose: () => { finished = true; try { port.disconnect(); } catch {} resetButton(); }
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      progressEl.textContent = '';
      progressEl.appendChild(progressBar(Math.round((msg.done / Math.max(1, msg.total)) * 100)));
    } else if (msg.type === 'done') {
      finished = true;
      renderAnalyticsReport(ref, msg.report);
      resetButton();
    } else if (msg.type === 'error') {
      finished = true;
      showError(msg.error);
    }
  });
  port.onDisconnect.addListener(() => {
    if (finished) return;
    finished = true;
    showError(chrome.runtime.lastError?.message || 'The background worker stopped before the analytics finished. Try again.');
  });
  port.postMessage({ action: 'RUN_AUDIT', monthsBack: 3 });
}

function renderAnalyticsReport(ref, report) {
  const summary = h('div', { style: { display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' } },
    ...Object.entries(KIND_LABELS).map(([key, label]) => h('div', { style: { flex: '1', minWidth: '110px', textAlign: 'center', padding: '10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' } },
      h('div', { style: { fontSize: '22px', fontWeight: '700' } }, String(report.byKind[key] || 0)),
      h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, label)
    ))
  );

  const monthRows = report.months.map(m => h('tr', null, h('td', null, m.label), h('td', { style: { textAlign: 'right' } }, String(m.count))));
  const authorRows = report.authors.slice(0, 15).map(a => h('tr', null, h('td', null, a.label), h('td', { style: { textAlign: 'right' } }, String(a.count))));
  const recordRows = report.records.slice(0, 50).map(r => h('tr', null,
    h('td', null, recordLink(r)),
    h('td', null, KIND_LABELS[r.kind] || r.kind),
    h('td', { style: { textAlign: 'right' } }, String(r.count)),
    h('td', null, (r.lastDate || '').slice(0, 10))
  ));

  const tables = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' } },
    h('div', null,
      h('div', { style: { fontWeight: '600', marginBottom: '6px', fontSize: '12px' } }, 'By month'),
      h('table', { class: 'data-table' }, h('tbody', null, ...monthRows))
    ),
    h('div', null,
      h('div', { style: { fontWeight: '600', marginBottom: '6px', fontSize: '12px' } }, 'By user'),
      h('table', { class: 'data-table' }, h('tbody', null, ...authorRows))
    )
  );

  const detail = h('details', null,
    h('summary', { style: { cursor: 'pointer', fontSize: '12px', fontWeight: '600' } }, `Per-record breakdown (${report.records.length})`),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', null, 'Record'), h('th', null, 'Type'), h('th', null, 'Count'), h('th', null, 'Last activity'))),
      h('tbody', null, ...recordRows)
    )
  );

  const body = h('div', null,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' } }, `${(report.windowFrom || '').slice(0, 10)} — ${(report.windowTo || '').slice(0, 10)}`),
    report.failedSlices ? h('div', { style: { fontSize: '12px', color: 'var(--warning)', marginBottom: '12px' } },
      `Incomplete: ${report.failedSlices} of ${report.totalSlices} search windows failed${report.firstError ? ` (${report.firstError})` : ''}. Counts below are undercounted — re-run after re-logging in.`) : null,
    summary, tables, detail
  );

  const bodyEl = ref.box.querySelector('.modal__body');
  bodyEl.textContent = '';
  bodyEl.appendChild(body);
}

load();
