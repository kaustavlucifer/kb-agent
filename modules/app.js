import { h, chip, toast } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS } from '../shared/config.js';

const TABS = [
  { id: 'case-analysis', label: 'Case Analysis' },
  { id: 'kb-articles', label: 'KB Articles' },
  { id: 'coverage', label: 'P&T Coverage' },
  { id: 'dedup', label: 'Duplicates' }
];

let _activeModule = null;
let _tabContent = null;
let _tabGen = 0;

async function init() {
  const hashTab = location.hash.replace('#', '');
  const validTab = TABS.find(t => t.id === hashTab);
  setState('app.activeTab', validTab ? hashTab : 'case-analysis');
  setState('app.connections', { sf: null, ai: null });

  const cached = await localGet([STORAGE_KEYS.AUTH_CACHE]);
  if (cached[STORAGE_KEYS.AUTH_CACHE]) {
    setState('app.connections', cached[STORAGE_KEYS.AUTH_CACHE]);
  }

  render();
  checkConnections();

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

function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  app.appendChild(buildHeader());
  _tabContent = h('div', { class: 'main' });
  app.appendChild(_tabContent);
  activateTab(getState('app.activeTab'));

  subscribe('app.activeTab', (tabId) => activateTab(tabId));
  subscribe('app.connections', () => updateConnectionChips());
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
      h('div', { class: 'header__title' }, 'KB Agent')
    ),
    buildTabs(),
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
    'coverage': './coverage.js',
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
}

async function refreshConnections() {
  await chrome.runtime.sendMessage({ action: 'REFRESH_AUTH' }).catch(() => {});
  await checkConnections();
  toast('Auth status refreshed.', 'info');
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
    onClick: () => chrome.tabs.create({ url: 'https://known-issues-prd1.lightning.force.com' })
  }));

  const refreshBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    style: { fontSize: '13px', padding: '2px 6px', marginLeft: '4px', lineHeight: '1' },
    title: 'Refresh auth status (clears auth cache and re-checks all connections)',
    onClick: refreshConnections
  }, '↻');
  container.appendChild(refreshBtn);

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
