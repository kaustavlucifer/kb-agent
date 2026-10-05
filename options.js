import { STORAGE_KEYS, SETTINGS_SCHEMA, MODEL_CHOICES, currentSettings, applySettings } from './shared/config.js';
import { h, modal, progressBar } from './shared/ui.js';

const tokenEl = document.getElementById('token');
const bypassEl = document.getElementById('bypass-guard-rails');
const statusEl = document.getElementById('status');
const modelsWrap = document.getElementById('models');
const thresholdsWrap = document.getElementById('thresholds');

const modelItems = SETTINGS_SCHEMA.filter(s => s.kind === 'model');
const numberItems = SETTINGS_SCHEMA.filter(s => s.kind === 'number');

const controls = {};

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

function buildModelField(item, value) {
  const select = document.createElement('select');
  select.id = `opt-${item.key}`;
  for (const m of MODEL_CHOICES) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
  select.value = value;
  controls[item.key] = { kind: 'model', read: () => select.value };
  return fieldShell(item, select);
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
  const data = await chrome.storage.local.get([STORAGE_KEYS.GATEWAY_TOKEN, STORAGE_KEYS.BYPASS_GUARD_RAILS, STORAGE_KEYS.SETTINGS]);
  if (data[STORAGE_KEYS.GATEWAY_TOKEN]) tokenEl.placeholder = '••••••••  (saved)';
  if (data[STORAGE_KEYS.BYPASS_GUARD_RAILS]) bypassEl.checked = true;
  applySettings(data[STORAGE_KEYS.SETTINGS]);
  renderForm();
}

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
  await chrome.storage.local.set(updates);
  applySettings(out);
  setStatus('Saved.', 'var(--success)');
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.SETTINGS);
  applySettings({});
  for (const item of SETTINGS_SCHEMA) {
    const ctrl = controls[item.key];
    if (ctrl) document.getElementById(`opt-${item.key}`).value = item.default;
  }
  setStatus('Reset to defaults. Click Save to apply.', 'var(--text-secondary)');
});

document.getElementById('test-btn').addEventListener('click', async () => {
  setStatus('Testing…', 'var(--text-secondary)');
  const resp = await chrome.runtime.sendMessage({ action: 'VERIFY_AI_TOKEN' });
  if (resp?.connected) setStatus('Connected.', 'var(--success)');
  else setStatus('Failed: ' + (resp?.error || 'Unknown error'), 'var(--error)');
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['kba_all_articles', 'kba_all_articles_at', 'kba_all_articles_tier2_at', 'kba_article_scores', 'kba_dedup_results', 'kba_dedup_at', STORAGE_KEYS.RECENT_CASES, STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]);
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

document.getElementById('analytics-btn').addEventListener('click', runAnalytics);

function runAnalytics() {
  const btn = document.getElementById('analytics-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';

  const progressEl = h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, 'Starting…');
  const port = chrome.runtime.connect({ name: 'kba-audit' });
  const ref = modal('Usage Analytics', progressEl, {
    footer: h('div', { class: 'modal__footer' },
      h('button', { class: 'btn btn--secondary', onClick: () => { port.disconnect(); ref.close(); } }, 'Close')
    ),
    onClose: () => { try { port.disconnect(); } catch {} btn.disabled = false; btn.textContent = 'Run Analytics'; }
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      progressEl.textContent = '';
      progressEl.appendChild(progressBar(Math.round((msg.done / Math.max(1, msg.total)) * 100)));
    } else if (msg.type === 'done') {
      renderAnalyticsReport(ref, msg.report);
      btn.disabled = false;
      btn.textContent = 'Run Analytics';
    } else if (msg.type === 'error') {
      progressEl.textContent = '';
      progressEl.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + msg.error));
      btn.disabled = false;
      btn.textContent = 'Run Analytics';
    }
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
    h('td', null, r.label),
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
    summary, tables, detail
  );

  const bodyEl = ref.box.querySelector('.modal__body');
  bodyEl.textContent = '';
  bodyEl.appendChild(body);
}

load();
