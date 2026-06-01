import { detectSession, checkGus, checkSlack } from '../shared/auth.js';
import { pingGateway } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS } from '../shared/config.js';

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
      const result = await pingGateway(token);
      return result;
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
  if (!session.sid) return { success: false, error: 'No SF session' };
  const { sfQuery, escapeSoql } = await import('../shared/api.js');
  const records = await sfQuery(session.apiBase, session.sid,
    `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber = '${escapeSoql(caseNumber)}' LIMIT 1`
  );
  if (!records.length) return { success: false, error: 'Case not found' };
  return { success: true, caseId: records[0].Id, caseNumber: records[0].CaseNumber, subject: records[0].Subject };
}

function handlePort(port) {
  switch (port.name) {
    case 'kba-analyze':
      port.onMessage.addListener(msg => routeAnalyze(port, msg));
      break;
    case 'kba-theme-volume':
      port.onMessage.addListener(msg => routeThemeVolume(port, msg));
      break;
    case 'kba-broaden':
      port.onMessage.addListener(msg => routeBroaden(port, msg));
      break;
    case 'kbs-score-batch':
      port.onMessage.addListener(msg => routeScoreBatch(port, msg));
      break;
    case 'kbs-rewrite':
      port.onMessage.addListener(msg => routeRewrite(port, msg));
      break;
    case 'kbs-coverage':
      port.onMessage.addListener(msg => routeCoverage(port, msg));
      break;
    case 'kbs-dedup':
      port.onMessage.addListener(msg => routeDedup(port, msg));
      break;
    case 'kbs-merge':
      port.onMessage.addListener(msg => routeMerge(port, msg));
      break;
  }
}

async function routeAnalyze(port, msg) {
  try {
    const { handleAnalyze } = await import('../modules/case-analysis.js');
    await handleAnalyze(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeThemeVolume(port, msg) {
  try {
    const { handleThemeVolume } = await import('../modules/case-analysis.js');
    await handleThemeVolume(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeBroaden(port, msg) {
  try {
    const { handleBroaden } = await import('../modules/case-analysis.js');
    await handleBroaden(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeScoreBatch(port, msg) {
  try {
    const { handleScoreBatch } = await import('../modules/kb-scorer.js');
    await handleScoreBatch(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeRewrite(port, msg) {
  try {
    const { handleRewrite } = await import('../modules/kb-scorer.js');
    await handleRewrite(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeCoverage(port, msg) {
  try {
    const { handleCoverage } = await import('../modules/coverage.js');
    await handleCoverage(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeDedup(port, msg) {
  try {
    const { handleDedup } = await import('../modules/dedup.js');
    await handleDedup(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

async function routeMerge(port, msg) {
  try {
    const { handleMerge } = await import('../modules/dedup.js');
    await handleMerge(port, msg);
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}
