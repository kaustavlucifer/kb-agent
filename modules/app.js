import { h, chip, toast, modal } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS, applySettings, MODEL_PRICING, KI_BASE } from '../shared/config.js';
import { getCostTotals, resetCostTotals, onCostStorageChange, fmtUsd } from '../shared/cost.js';
import { listGatewayModels, fetchGatewayKeyLimits } from '../shared/gateway.js';

const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TABS = [
  { id: 'case-analysis', label: 'Case Analysis' },
  { id: 'kb-articles', label: 'KB Articles' },
  { id: 'known-issues', label: 'Known Issues' },
  { id: 'dedup', label: 'KB Dedupe' }
];

let _activeModule = null;
let _tabContent = null;
let _tabGen = 0;
let _subscribed = false;

async function init() {
  try {
    const s = await localGet([STORAGE_KEYS.SETTINGS]);
    applySettings(s[STORAGE_KEYS.SETTINGS]);
  } catch {}

  const hashTab = location.hash.replace('#', '');
  const validTab = TABS.find(t => t.id === hashTab);
  setState('app.activeTab', validTab ? hashTab : 'case-analysis');
  setState('app.connections', { sf: null, ai: null });

  const cached = await localGet([STORAGE_KEYS.AUTH_CACHE]);
  if (cached[STORAGE_KEYS.AUTH_CACHE]) {
    setState('app.connections', cached[STORAGE_KEYS.AUTH_CACHE]);
  }

  setState('app.cost', await getCostTotals());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') onCostStorageChange(changes);
  });

  render();
  checkConnections();
  checkUpdate();
  refreshModelCatalogIfStale();

  const params = new URLSearchParams(window.location.search);
  const caseUrl = params.get('caseUrl');
  if (caseUrl) {
    setState('app.activeTab', 'case-analysis');
    setState('case.pendingUrl', caseUrl);
  }

  window.addEventListener('popstate', (event) => {
    if (event.state && event.state.tab) {
      setState('app.activeTab', event.state.tab);
    }
  });
}

async function refreshModelCatalogIfStale() {
  const data = await localGet([STORAGE_KEYS.MODEL_CATALOG, STORAGE_KEYS.GATEWAY_TOKEN]);
  const catalogAt = data[STORAGE_KEYS.MODEL_CATALOG]?.at || 0;
  if (catalogAt && (Date.now() - catalogAt < MODEL_CATALOG_MAX_AGE_MS)) return;
  const token = data[STORAGE_KEYS.GATEWAY_TOKEN];
  if (!token) return;
  const [models, limits] = await Promise.all([listGatewayModels(token), fetchGatewayKeyLimits(token)]);
  if (models && models.length) {
    await localSet({ [STORAGE_KEYS.MODEL_CATALOG]: { models, limits, at: Date.now() } });
  }
}

function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  app.appendChild(buildHeader());
  _tabContent = h('div', { class: 'main' });
  app.appendChild(_tabContent);
  activateTab(getState('app.activeTab'));

  if (!_subscribed) {
    _subscribed = true;
    subscribe('app.activeTab', (tabId) => activateTab(tabId));
    subscribe('app.connections', () => updateConnectionChips());
    subscribe('app.cost', () => updateCostChip());
  }
  updateCostChip();
}

function updateCostChip() {
  const container = document.getElementById('cost-chip');
  if (!container) return;
  container.textContent = '';
  const cost = getState('app.cost');
  const total = cost?.costUsd || 0;
  const el = chip('neutral', fmtUsd(total), {
    title: `${(cost?.calls || 0).toLocaleString()} AI calls this session — click for a breakdown`,
    onClick: showCostDetail
  });
  el.style.cursor = 'pointer';
  container.appendChild(el);
}

function showCostDetail() {
  const cost = getState('app.cost') || {};
  const byModel = cost.byModel || {};
  const rows = Object.entries(byModel)
    .sort((a, b) => (b[1].costUsd || 0) - (a[1].costUsd || 0))
    .map(([model, v]) => h('tr', null,
      h('td', { style: { fontSize: '12px' } }, MODEL_PRICING[model] ? model.replace(/-\d{8}$/, '') : model),
      h('td', { style: { textAlign: 'right', fontSize: '12px' } }, (v.calls || 0).toLocaleString()),
      h('td', { style: { textAlign: 'right', fontSize: '12px' } }, ((v.inputTokens || 0) + (v.cacheReadTokens || 0) + (v.cacheCreationTokens || 0)).toLocaleString()),
      h('td', { style: { textAlign: 'right', fontSize: '12px' } }, (v.outputTokens || 0).toLocaleString()),
      h('td', { style: { textAlign: 'right', fontSize: '12px', fontWeight: '600' } }, fmtUsd(v.costUsd || 0))
    ));

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Model'),
      h('th', { style: { textAlign: 'right' } }, 'Calls'),
      h('th', { style: { textAlign: 'right' } }, 'Input tok'),
      h('th', { style: { textAlign: 'right' } }, 'Output tok'),
      h('th', { style: { textAlign: 'right' } }, 'Cost')
    )),
    h('tbody', null, ...(rows.length ? rows : [h('tr', null, h('td', { colspan: '5', style: { textAlign: 'center', color: 'var(--text-muted)', padding: '16px' } }, 'No AI usage recorded yet.'))]))
  );

  const content = h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' } },
      h('div', { style: { fontSize: '24px', fontWeight: '700' } }, fmtUsd(cost.costUsd || 0)),
      h('div', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, `${(cost.calls || 0).toLocaleString()} calls · ${(cost.outputTokens || 0).toLocaleString()} output tokens`)
    ),
    table,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' } },
      'Actual cost from gateway-reported token usage at public Anthropic list prices. Cache reads bill at ~0.1×.')
  );

  modal('AI Cost — this session', content, {
    primaryAction: {
      label: 'Reset',
      handler: async () => { await resetCostTotals(); toast('Cost counter reset.', 'success'); }
    }
  });
}

function buildHeader() {
  const settingsBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    title: 'Settings',
    style: { fontSize: '16px', padding: '4px 8px' },
    onClick: () => chrome.runtime.openOptionsPage()
  }, '⚙');

  const header = h('header', { class: 'header' },
    h('div', { class: 'header__brand' },
      h('div', { class: 'header__logo' }, 'K'),
      h('div', { class: 'header__text' },
        h('div', { class: 'header__title' }, 'KB Agent'),
        h('div', { class: 'header__version' }, `v${chrome.runtime.getManifest().version}`)
      )
    ),
    buildTabs(),
    h('div', { class: 'header__cost', id: 'cost-chip' }),
    h('div', { id: 'update-chip' }),
    h('div', { class: 'header__status', id: 'connection-chips' }),
    settingsBtn
  );
  return header;
}

function buildTabs() {
  const activeTab = getState('app.activeTab');
  const container = h('nav', { class: 'tabs', id: 'tab-nav' });
  TABS.forEach(tab => {
    const btn = h('button', {
      class: `tab ${tab.id === activeTab ? 'tab--active' : ''}`,
      'data-tab': tab.id,
      onClick: () => setState('app.activeTab', tab.id)
    }, tab.label);
    container.appendChild(btn);
  });
  return container;
}

function activateTab(tabId) {
  document.querySelectorAll('#tab-nav .tab').forEach(btn => {
    btn.classList.toggle('tab--active', btn.dataset.tab === tabId);
  });

  if (history.state?.tab !== tabId) {
    history.pushState({ tab: tabId }, '', `#${tabId}`);
  }

  if (_activeModule && _activeModule.unmount) {
    _activeModule.unmount();
    _activeModule = null;
  }
  _tabContent.textContent = '';

  const gen = ++_tabGen;
  const moduleMap = {
    'case-analysis': './case-analysis.js',
    'kb-articles': './kb-scorer.js',
    'known-issues': './ki-manager.js',
    'dedup': './dedup.js'
  };
  const path = moduleMap[tabId];
  if (!path) return;
  import(path).then(m => {
    if (gen !== _tabGen) return;
    _activeModule = m;
    m.mount(_tabContent);
  }).catch(e => {
    if (gen !== _tabGen) return;
    _tabContent.textContent = `Module load failed: ${e.message}`;
  });
}

async function checkConnections() {
  const [sfResp, aiResp, gusResp, kiResp] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'CHECK_CONNECTION' }).catch(() => ({ connected: false })),
    chrome.runtime.sendMessage({ action: 'VERIFY_AI_TOKEN' }).catch(() => ({ connected: false })),
    chrome.runtime.sendMessage({ action: 'CHECK_GUS_CONNECTION' }).catch(() => ({ connected: false })),
    chrome.runtime.sendMessage({ action: 'CHECK_KI_CONNECTION' }).catch(() => ({ connected: false }))
  ]);
  const connections = { sf: sfResp, ai: aiResp, gus: gusResp, ki: kiResp };
  setState('app.connections', connections);
  localSet({ [STORAGE_KEYS.AUTH_CACHE]: connections });

  const sfOk = sfResp?.connected;
  const gusOk = gusResp?.connected;
  const kiOk = kiResp?.connected;

  if (!sfOk) autoOpenAuthTab('sf', `https://${sfResp?.lightningHost || 'orgcs.lightning.force.com'}`);
  else _authAutoOpened.sf = false;

  if (!gusOk) autoOpenAuthTab('gus', `https://${gusResp?.lightningHost || 'gus.lightning.force.com'}`);
  else _authAutoOpened.gus = false;

  if (!kiOk) autoOpenAuthTab('ki', KI_BASE);
  else _authAutoOpened.ki = false;

  scheduleAuthCheckIfNeeded(sfOk && gusOk && kiOk);
}

async function refreshConnections() {
  const resp = await chrome.runtime.sendMessage({ action: 'REFRESH_AUTH' }).catch(() => null);
  await checkConnections();
  if (resp) toast('Auth status refreshed.', 'info');
  else toast('Auth refresh failed.', 'error');
}

let _pendingUpdate = null;
let _authCheckTimer = null;
const _authAutoOpened = { sf: false, gus: false, ki: false };

async function checkUpdate(force = false) {
  const r = await chrome.runtime.sendMessage({ action: 'CHECK_FOR_UPDATE', force }).catch(() => null);
  _pendingUpdate = r && r.ok && r.updateAvailable ? r : null;
  renderUpdateChip();
  renderUpdateButton();
}

async function autoOpenAuthTab(kind, url) {
  if (_authAutoOpened[kind]) return;
  _authAutoOpened[kind] = true;
  try {
    const host = new URL(url).hostname;
    const existing = await chrome.tabs.query({ url: `https://${host}/*` });
    if (existing && existing.length) return;
    await chrome.tabs.create({ url, active: false });
  } catch {}
}

function scheduleAuthCheckIfNeeded(allHealthy) {
  if (allHealthy) {
    if (_authCheckTimer) { clearTimeout(_authCheckTimer); _authCheckTimer = null; }
    return;
  }
  if (_authCheckTimer) return;
  const delay = 10000 + Math.random() * 5000;
  _authCheckTimer = setTimeout(() => {
    _authCheckTimer = null;
    checkConnections();
  }, delay);
}

function renderUpdateChip() {
  const container = document.getElementById('update-chip');
  if (!container) return;
  container.textContent = '';
  if (!_pendingUpdate) return;
  const el = chip('pending', `⬆ v${_pendingUpdate.latest} available`, {
    title: `You have v${_pendingUpdate.current}. Click to update.`,
    onClick: openUpdateModal
  });
  el.style.cursor = 'pointer';
  container.appendChild(el);
}

function openUpdateModal() {
  if (!_pendingUpdate) return;
  const content = h('div', { style: { fontSize: '13px', lineHeight: '1.6' } },
    h('p', { style: { marginBottom: '12px' } }, `You have v${_pendingUpdate.current}. The latest is v${_pendingUpdate.latest}.`),
    h('a', {
      href: _pendingUpdate.downloadUrl, target: '_blank', rel: 'noopener',
      class: 'btn btn--primary', style: { marginBottom: '16px', textDecoration: 'none' }
    }, '⬇ Download the latest zip'),
    h('ol', { style: { paddingLeft: '20px' } },
      h('li', null, 'Click the button above and save the zip (you need to be signed in to Google with your work account).'),
      h('li', null, 'Extract the zip into a new folder.'),
      h('li', null, h('span', null, 'In Chrome, open '), h('b', null, 'chrome://extensions'), h('span', null, ', turn on '), h('b', null, 'Developer mode'), h('span', null, ' (top right) and remove the old '), h('b', null, 'KB Agent'), h('span', null, '.')),
      h('li', null, h('span', null, 'Click '), h('b', null, 'Load unpacked'), h('span', null, ' and pick the folder you just extracted.'))
    )
  );
  let ref;
  const footer = h('div', { class: 'modal__footer' },
    h('button', {
      class: 'btn btn--ghost',
      onClick: async () => {
        await chrome.runtime.sendMessage({ action: 'DISMISS_UPDATE', version: _pendingUpdate.latest }).catch(() => {});
        _pendingUpdate = null;
        renderUpdateChip();
        ref.close();
      }
    }, 'Dismiss until next version'),
    h('button', { class: 'btn btn--secondary', onClick: () => ref.close() }, 'Close')
  );
  ref = modal(`Update available — v${_pendingUpdate.latest}`, content, { footer });
}

function updateConnectionChips() {
  const container = document.getElementById('connection-chips');
  if (!container) return;
  container.textContent = '';
  const conn = getState('app.connections');
  if (!conn) return;

  container.appendChild(chip(
    conn.sf?.connected ? 'connected' : 'disconnected',
    conn.sf?.connected ? 'OrgCS' : 'OrgCS Offline',
    {
      title: conn.sf?.connected ? 'Connected to Salesforce — click to open' : 'Not connected — click to log into OrgCS',
      onClick: () => {
        const host = conn.sf?.lightningHost || conn.sf?.orgKey;
        const url = host ? `https://${host}` : 'https://orgcs.lightning.force.com';
        chrome.tabs.create({ url });
      }
    }
  ));

  const aiState = !conn.ai ? 'pending'
    : conn.ai.connected ? 'connected'
    : conn.ai.hasToken ? 'disconnected' : 'pending';
  const aiLabel = !conn.ai ? 'AI…'
    : conn.ai.connected ? 'AI Ready'
    : conn.ai.hasToken ? 'AI Error' : 'Set AI Key';
  const aiChip = chip(aiState, aiLabel, {
    title: conn.ai?.error || 'Click to configure AI gateway token',
    onClick: openTokenPopover
  });
  aiChip.style.cursor = 'pointer';
  container.appendChild(aiChip);

  const gusState = conn.gus?.connected ? 'connected' : 'disconnected';
  const gusLabel = conn.gus?.connected ? 'GUS' : 'GUS Offline';
  container.appendChild(chip(gusState, gusLabel, {
    title: conn.gus?.connected ? 'Connected to GUS' : 'Log into GUS for work item enrichment',
    onClick: () => chrome.tabs.create({ url: 'https://gus.lightning.force.com' })
  }));

  const kiState = conn.ki?.connected ? 'connected' : 'disconnected';
  const kiLabel = conn.ki?.connected ? 'KI' : 'KI Offline';
  container.appendChild(chip(kiState, kiLabel, {
    title: conn.ki?.connected ? 'Connected to Known Issues org' : 'Log into Known Issues org for KI enrichment',
    onClick: () => chrome.tabs.create({ url: KI_BASE })
  }));

  const refreshBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    style: { fontSize: '13px', padding: '2px 6px', marginLeft: '4px', lineHeight: '1' },
    title: 'Refresh auth status (clears auth cache and re-checks all connections)',
    onClick: refreshConnections
  }, '↻');
  container.appendChild(refreshBtn);

  const updateBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    id: 'update-btn-header',
    style: { fontSize: '13px', padding: '2px 6px', marginLeft: '4px', lineHeight: '1' },
    onClick: handleUpdateButtonClick
  });
  container.appendChild(updateBtn);
  renderUpdateButton();
}

function renderUpdateButton() {
  const btn = document.getElementById('update-btn-header');
  if (!btn) return;
  if (_pendingUpdate) {
    btn.textContent = `⬆ v${_pendingUpdate.latest}`;
    btn.title = 'Download the latest version and see how to install it';
    btn.disabled = false;
  } else {
    btn.textContent = '⬆ Check';
    btn.title = 'Check Google Drive for a newer version';
    btn.disabled = false;
  }
}

async function handleUpdateButtonClick() {
  const btn = document.getElementById('update-btn-header');
  if (!btn) return;
  if (_pendingUpdate) {
    openUpdateModal();
    return;
  }
  btn.disabled = true;
  btn.textContent = '⬆ Checking…';
  const r = await chrome.runtime.sendMessage({ action: 'CHECK_FOR_UPDATE', force: true }).catch(() => null);
  if (!r || !r.ok) {
    btn.textContent = '⬆ Failed';
    btn.title = `Could not check for updates: ${(r && r.error) || 'no response'}`;
  } else if (r.updateAvailable) {
    _pendingUpdate = r;
    renderUpdateButton();
    renderUpdateChip();
    return;
  } else {
    btn.textContent = '✓ Current';
  }
  btn.disabled = false;
  setTimeout(() => {
    if (!_pendingUpdate) {
      btn.textContent = '⬆ Check';
      btn.title = 'Check Google Drive for a newer version';
    }
  }, 2500);
}

function openTokenPopover(e) {
  const existing = document.getElementById('token-popover');
  if (existing) { existing.remove(); return; }

  const rect = e.currentTarget.getBoundingClientRect();
  const popover = h('div', { class: 'popover', id: 'token-popover', style: { top: `${rect.bottom + 6}px`, right: `${window.innerWidth - rect.right}px` } },
    h('div', { class: 'popover__title' }, 'AI Gateway Token'),
    h('div', { class: 'popover__sub' }, 'Paste your gateway token to enable AI features.'),
    h('input', { type: 'password', class: 'input', id: 'token-input', placeholder: 'Paste token…', autocomplete: 'off' }),
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn--secondary btn--sm', onClick: () => document.getElementById('token-popover')?.remove() }, 'Cancel'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: saveToken }, 'Save & Verify')
    )
  );
  document.body.appendChild(popover);
  document.getElementById('token-input')?.focus();

  const triggerEl = e.currentTarget;
  setTimeout(() => {
    const dismiss = (ev) => {
      if (!popover.contains(ev.target) && (!triggerEl || !triggerEl.contains(ev.target))) {
        popover.remove();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    document.addEventListener('mousedown', dismiss, true);
  }, 0);
}

async function saveToken() {
  const input = document.getElementById('token-input');
  const val = (input?.value || '').trim();
  if (!val) { toast('Paste a token first.', 'error'); return; }
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'SAVE_TOKEN', token: val });
    if (resp?.connected) {
      toast('AI Gateway connected.', 'success');
    } else {
      toast('Token saved but verification failed: ' + (resp?.error || ''), 'error');
    }
    document.getElementById('token-popover')?.remove();
    checkConnections();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

init();
