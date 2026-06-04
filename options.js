const tokenEl = document.getElementById('token');
const modelEl = document.getElementById('model');
const bypassEl = document.getElementById('bypass-guard-rails');
const statusEl = document.getElementById('status');

chrome.storage.local.get(['gatewayToken', 'modelName', 'bypassGuardRails'], (data) => {
  if (data.gatewayToken) tokenEl.placeholder = '••••••••  (saved)';
  if (data.modelName) modelEl.value = data.modelName;
  if (data.bypassGuardRails) bypassEl.checked = true;
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const token = tokenEl.value.trim();
  const model = modelEl.value;
  const bypass = bypassEl.checked;
  const updates = { modelName: model, bypassGuardRails: bypass };
  if (token) updates.gatewayToken = token;
  await chrome.storage.local.set(updates);
  statusEl.textContent = 'Saved.';
  statusEl.style.color = 'var(--success)';
});

document.getElementById('test-btn').addEventListener('click', async () => {
  statusEl.textContent = 'Testing…';
  statusEl.style.color = 'var(--text-secondary)';
  const resp = await chrome.runtime.sendMessage({ action: 'VERIFY_AI_TOKEN' });
  if (resp.connected) {
    statusEl.textContent = 'Connected.';
    statusEl.style.color = 'var(--success)';
  } else {
    statusEl.textContent = 'Failed: ' + (resp.error || 'Unknown error');
    statusEl.style.color = 'var(--error)';
  }
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['kba_all_articles', 'kba_all_articles_at', 'kba_all_articles_tier2_at', 'kba_article_scores', 'kba_dedup_results', 'kba_dedup_at']);
  statusEl.textContent = 'Cache cleared.';
  statusEl.style.color = 'var(--text-secondary)';
});
