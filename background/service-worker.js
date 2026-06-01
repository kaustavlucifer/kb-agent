import { detectSession, checkGus, checkSlack } from '../shared/auth.js';
import { pingGateway } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { sfQuery, escapeSoql } from '../shared/api.js';
import { STORAGE_KEYS } from '../shared/config.js';

import { handleAnalyze, handleThemeVolume, handleBroaden } from './handlers/case-analysis.js';
import { handleScoreBatch, handleRewrite } from './handlers/kb-scorer.js';
import { handleCoverage } from './handlers/coverage.js';
import { handleDedup, handleMerge } from './handlers/dedup.js';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  handlePort(port);
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'CHECK_CONNECTION': {
      const session = await detectSession();
      return { connected: !!session.sid, orgKey: session.key || null, lightningHost: session.lightningHost };
    }
    case 'VERIFY_AI_TOKEN': {
      const data = await localGet([STORAGE_KEYS.GATEWAY_TOKEN]);
      const token = data[STORAGE_KEYS.GATEWAY_TOKEN];
      if (!token) return { connected: false, hasToken: false };
      return pingGateway(token);
    }
    case 'SAVE_TOKEN': {
      const token = msg.token;
      await localSet({ [STORAGE_KEYS.GATEWAY_TOKEN]: token });
      const result = await pingGateway(token);
      return { success: true, ...result };
    }
    case 'CHECK_GUS': return checkGus();
    case 'CHECK_SLACK': return checkSlack();
    case 'RESOLVE_CASE_NUMBER': return resolveCase(msg.caseNumber);
    default: return { error: `Unknown action: ${msg.action}` };
  }
}

async function resolveCase(caseNumber) {
  if (!/^\d{3,15}$/.test(caseNumber)) return { success: false, error: 'Invalid case number format' };
  const session = await detectSession();
  console.log('[KB-Agent] resolveCase session:', session.key, 'sid:', !!session.sid, 'apiBase:', session.apiBase);
  if (!session.sid) return { success: false, error: 'No SF session — log into OrgCS first' };
  try {
    const soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber = '${escapeSoql(caseNumber)}' LIMIT 1`;
    console.log('[KB-Agent] resolveCase SOQL:', soql);
    const records = await sfQuery(session.apiBase, session.sid, soql);
    console.log('[KB-Agent] resolveCase result:', records.length, 'records');
    if (!records.length) return { success: false, error: `Case #${caseNumber} not found in ${session.key || 'org'}` };
    return { success: true, caseId: records[0].Id, caseNumber: records[0].CaseNumber, subject: records[0].Subject };
  } catch (e) {
    console.error('[KB-Agent] resolveCase error:', e);
    return { success: false, error: `Query failed: ${e.message}` };
  }
}

function handlePort(port) {
  const wrap = (fn) => (msg) => {
    fn(port, msg).catch(e => {
      try { port.postMessage({ type: 'error', error: e.message }); } catch {}
    });
  };

  switch (port.name) {
    case 'kba-analyze':
      port.onMessage.addListener(wrap(handleAnalyze));
      break;
    case 'kba-theme-volume':
      port.onMessage.addListener(wrap(handleThemeVolume));
      break;
    case 'kba-broaden':
      port.onMessage.addListener(wrap(handleBroaden));
      break;
    case 'kbs-score-batch':
      port.onMessage.addListener(wrap(handleScoreBatch));
      break;
    case 'kbs-rewrite':
      port.onMessage.addListener(wrap(handleRewrite));
      break;
    case 'kbs-coverage':
      port.onMessage.addListener(wrap(handleCoverage));
      break;
    case 'kbs-dedup':
      port.onMessage.addListener(wrap(handleDedup));
      break;
    case 'kbs-merge':
      port.onMessage.addListener(wrap(handleMerge));
      break;
  }
}
