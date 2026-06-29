import { STORAGE_KEYS, SETTINGS_SCHEMA, MODEL_CHOICES, currentSettings, applySettings } from './shared/config.js';

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
  if (resp.connected) setStatus('Connected.', 'var(--success)');
  else setStatus('Failed: ' + (resp.error || 'Unknown error'), 'var(--error)');
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['kba_all_articles', 'kba_all_articles_at', 'kba_all_articles_tier2_at', 'kba_article_scores', 'kba_dedup_results', 'kba_dedup_at']);
  setStatus('Cache cleared.', 'var(--text-secondary)');
});

load();
