import { detectSession, detectKiSession, pingKiSession, pingOrgcsSession, clearAuthCache } from '../shared/auth.js';
import { pingGateway, callClaude, extractText, extractJson } from '../shared/gateway.js';
import { flushCost, onCostStorageChange } from '../shared/cost.js';
import { localGet, localSet } from '../shared/storage.js';
import { sfQuery, escapeSoql, escapeSoqlLike, sanitizeId, stripHtml, absolutizeSfUrls } from '../shared/api.js';
import { STORAGE_KEYS, applySettings } from '../shared/config.js';
import { redactPii } from '../shared/pii.js';
import { GUIDE_GENERATION, GUIDE_STYLE, MARKDOWN_OUTPUT_RULE } from '../data/writing_guide_prompts.js';

import { handleAnalyze, handleGenerateNew } from './handlers/case-analysis.js';
import { publishNewArticle, publishUpdateDraft, checkDraftExists } from './handlers/article-publish.js';
import { checkGusConnection, searchGusWorkItems } from './handlers/gus-enrichment.js';
import { checkForUpdate, dismissUpdate } from './update-check.js';
import { auditSignatures, mergeAuditReports } from './signature-audit.js';
import { prepareKiRewrite, logKiSignature, createKnownIssue, updateKnownIssue, loadAllKnownIssues, searchKnownIssuesUnscoped, fetchKnownIssueDetail } from './handlers/ki-publish.js';

const _settingsReady = (async () => {
  try {
    const data = await localGet([STORAGE_KEYS.SETTINGS]);
    applySettings(data[STORAGE_KEYS.SETTINGS]);
  } catch {}
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.SETTINGS]) {
    applySettings(changes[STORAGE_KEYS.SETTINGS].newValue || {});
  }
  onCostStorageChange(changes);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  _settingsReady.then(() => handleMessage(msg))
    .then(result => { sendResponse(result); })
    .catch(e => { sendResponse({ error: e.message }); })
    .finally(() => { flushCost().catch(() => {}); });
  return true;
});

chrome.runtime.onConnect.addListener(handlePort);

async function handleMessage(msg) {
  switch (msg.action) {
    case 'CHECK_CONNECTION': {
      const ping = await pingOrgcsSession();
      if (ping.status === 'none') return { connected: false, orgKey: null, lightningHost: null };
      const base = { orgKey: ping.key, lightningHost: ping.lightningHost };
      if (ping.status === 'active') return { connected: true, ...base };
      return { connected: false, ...base, reason: ping.status === 'expired' ? 'session_expired' : 'network_error' };
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
    case 'RESOLVE_CASE_NUMBER': return resolveCase(msg.caseNumber);
    case 'SEARCH_CASES': return searchCases(msg.query);
    case 'REFINE_SECTION': return refineSection(msg);
    case 'PUBLISH_NEW_ARTICLE': return publishNewArticle(msg.payload);
    case 'PUBLISH_UPDATE_DRAFT': return publishUpdateDraft(msg.payload);
    case 'CHECK_DRAFT_EXISTS': return checkDraftExists(msg.payload);
    case 'CHECK_GUS_CONNECTION': return checkGusConnection();
    case 'SEARCH_GUS_WORK': return searchGusWorkItems(msg.query);
    case 'GENERATE_ARTICLE_UPDATE': return generateArticleUpdate(msg);
    case 'FETCH_ARTICLE_PREVIEW': return fetchArticlePreview(msg.articleId);
    case 'CHECK_KI_CONNECTION': return checkKiConnection();
    case 'REFRESH_AUTH': { clearAuthCache(); return { cleared: true }; }
    case 'CHECK_FOR_UPDATE': return checkForUpdate({ force: !!msg.force });
    case 'DISMISS_UPDATE': { await dismissUpdate(String(msg.version || '')); return { ok: true }; }
    case 'CREATE_KNOWN_ISSUE': return createKnownIssue(msg.payload);
    case 'UPDATE_KNOWN_ISSUE': return updateKnownIssue(msg.payload);
    case 'LOAD_ALL_KNOWN_ISSUES': return loadAllKnownIssues({ forceLive: !!msg.forceLive });
    case 'SEARCH_KI_UNSCOPED': return searchKnownIssuesUnscoped(msg.query);
    case 'FETCH_KI_DETAIL': return fetchKnownIssueDetail(msg.id);
    case 'PREPARE_KI_REWRITE': return prepareKiRewrite(msg.kiId);
    case 'LOG_KI_SIGNATURE': return logKiSignature(msg.kind, msg.kiId);
    default: return { error: `Unknown action: ${msg.action}` };
  }
}

async function generateArticleUpdate(msg) {
  const { articleTitle, caseAbstract } = msg;
  const caseSubject = redactPii(msg.caseSubject);
  const safeId = sanitizeId(msg.articleId);
  const session = await detectSession();
  if (!session.sid) return { success: false, error: 'No SF session' };

  let articleBody = '';
  try {
    const soql = `SELECT Id, Title, Summary, Description__c, Resolution__c FROM Knowledge__kav WHERE Id = '${safeId}' LIMIT 1`;
    const records = await sfQuery(session.apiBase, session.sid, soql);
    if (records.length) {
      const r = records[0];
      articleBody = `Title: ${r.Title || ''}\nSummary: ${r.Summary || ''}\nDescription: ${stripHtml(r.Description__c).slice(0, 3000)}\nResolution: ${stripHtml(r.Resolution__c).slice(0, 3000)}`;
    }
  } catch {}

  if (!articleBody) articleBody = `Title: ${articleTitle}\n(Article body could not be fetched)`;

  try {
    const resp = await callClaude({
      system: `You are rewriting a Salesforce KB article to incorporate new case context. Follow Agentforce writing rules:
${GUIDE_GENERATION}

${GUIDE_STYLE}

${MARKDOWN_OUTPUT_RULE}

Return the FULL rewritten article. Use EXACTLY these 4 fields.
JSON: {"title":"...","summary":"...","sections":[{"heading":"Description","body":"..."},{"heading":"Resolution","body":"..."}]}`,
      messages: [{ role: 'user', content: `EXISTING ARTICLE:\n${articleBody}\n\nCASE CONTEXT:\nSubject: ${caseSubject || ''}\nProduct: ${caseAbstract?.product || ''}\nSymptom: ${caseAbstract?.symptomClass || ''}\nError: ${caseAbstract?.errorSignature || ''}` }],
      maxTokens: 3000,
      temperature: 0.2,
      cache: true
    });
    const text = extractText(resp);
    const parsed = extractJson(text);
    if (!parsed) return { success: false, error: 'Could not parse AI response' };
    return { success: true, rewrite: parsed };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fetchArticlePreview(articleId) {
  const session = await detectSession();
  if (!session.sid) return { success: false, error: 'No SF session' };
  try {
    const safeId = sanitizeId(articleId);
    const soql = `SELECT Id, Title, Summary, ArticleNumber, PublishStatus, ValidationStatus, CreatedBy.Name, LastModifiedBy.Name, LastModifiedDate, Description__c, Resolution__c, Steps__c FROM Knowledge__kav WHERE Id = '${safeId}' LIMIT 1`;
    const records = await sfQuery(session.apiBase, session.sid, soql);
    if (!records.length) return { success: false, error: 'Article not found' };
    const r = records[0];
    const descriptionHtml = absolutizeSfUrls(r.Description__c || '', session.apiBase);
    const resolutionHtml = absolutizeSfUrls(r.Resolution__c || '', session.apiBase);
    const stepsHtml = absolutizeSfUrls(r.Steps__c || '', session.apiBase);
    return {
      success: true,
      article: {
        id: r.Id,
        title: r.Title || '',
        summary: r.Summary || '',
        articleNumber: r.ArticleNumber || '',
        publishStatus: r.PublishStatus || '',
        validationStatus: r.ValidationStatus || '',
        createdByName: r.CreatedBy?.Name || '',
        lastModifiedByName: r.LastModifiedBy?.Name || '',
        lastModifiedDate: r.LastModifiedDate || '',
        descriptionHtml,
        resolutionHtml,
        stepsHtml,
        description: stripHtml(descriptionHtml),
        resolution: stripHtml(resolutionHtml),
        steps: stripHtml(stepsHtml)
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function checkKiConnection() {
  const result = await pingKiSession();
  return { connected: result.status === 'active' };
}


async function refineSection(msg) {
  const { content, title, focus } = msg;
  if (!content) return { success: false, error: 'No content provided' };
  try {
    const focusInstruction = focus ? `\n\nUSER FOCUS: "${focus}" — prioritize this aspect in your refinement.` : '';
    const resp = await callClaude({
      system: `You are an expert KB editor for Salesforce Agentforce. Refine this section following Agentforce writing guide rules:

${GUIDE_GENERATION}

${GUIDE_STYLE}

${MARKDOWN_OUTPUT_RULE}${focusInstruction}

Return ONLY the improved text, no JSON wrapping or explanation.`,
      messages: [{ role: 'user', content: `Section Title: ${title}\n\nContent to refine:\n${content}` }],
      maxTokens: 2000,
      temperature: 0.2,
      cache: true
    });
    const refined = extractText(resp);
    return { success: true, refined };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function withSession(run, { onNoSession, onError }) {
  const session = await detectSession();
  if (!session.sid) return onNoSession();
  try {
    return await run(session);
  } catch (e) {
    return onError(e);
  }
}

async function searchCases(query) {
  if (!query || query.length < 3) return { cases: [] };

  return withSession(
    async (session) => {
      let soql;
      if (/^\d+$/.test(query)) {
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber LIKE '${escapeSoqlLike(query)}%' ORDER BY CreatedDate DESC LIMIT 8`;
      } else if (/^[a-zA-Z0-9]{15,18}$/.test(query)) {
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE Id = '${escapeSoql(query)}' LIMIT 1`;
      } else {
        const like = escapeSoqlLike(query);
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE (Subject LIKE '%${like}%' OR CaseNumber LIKE '%${like}%') ORDER BY CreatedDate DESC LIMIT 8`;
      }
      const records = await sfQuery(session.apiBase, session.sid, soql);
      return { cases: records };
    },
    {
      onNoSession: () => ({ cases: [], error: 'No SF session — log into OrgCS first' }),
      onError: (e) => ({ cases: [], error: `Search failed: ${e.message}` })
    }
  );
}

async function resolveCase(caseNumber) {
  if (!/^\d{3,15}$/.test(caseNumber)) return { success: false, error: 'Invalid case number format' };

  return withSession(
    async (session) => {
      const soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber = '${escapeSoql(caseNumber)}' LIMIT 1`;
      const records = await sfQuery(session.apiBase, session.sid, soql);
      if (!records.length) return { success: false, error: `Case #${caseNumber} not found in ${session.key || 'org'}` };
      return { success: true, caseId: records[0].Id, caseNumber: records[0].CaseNumber, subject: records[0].Subject };
    },
    {
      onNoSession: () => ({ success: false, error: 'No SF session — log into OrgCS first' }),
      onError: (e) => ({ success: false, error: `Query failed: ${e.message}` })
    }
  );
}

function handlePort(port) {
  let disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; });

  const guardedPort = new Proxy(port, {
    get(target, prop) {
      if (prop === 'postMessage') return (...args) => { if (!disconnected) { try { target.postMessage(...args); } catch {} } };
      return target[prop];
    }
  });

  const wrap = (fn) => (msg) => {
    _settingsReady.then(() => fn(guardedPort, msg))
      .catch(e => {
        if (!disconnected) { try { port.postMessage({ type: 'error', error: e.message }); } catch {} }
      })
      .finally(() => { flushCost().catch(() => {}); });
  };

  switch (port.name) {
    case 'kba-analyze':
      port.onMessage.addListener((msg) => {
        if (msg.action === 'ANALYZE_CASE') wrap(handleAnalyze)(msg);
        else if (msg.action === 'GENERATE_NEW_ARTICLE') wrap(handleGenerateNew)(msg);
      });
      break;
    case 'kba-audit':
      port.onMessage.addListener((msg) => {
        if (msg.action === 'RUN_AUDIT') wrap(handleAudit)(msg);
      });
      break;
  }
}

async function handleAudit(port, msg) {
  const [orgcsSession, kiSession] = await Promise.all([detectSession(), detectKiSession()]);
  const sources = [orgcsSession, kiSession].filter((s, i, all) => s.sid && all.findIndex(x => x.apiBase === s.apiBase) === i);
  if (!sources.length) { port.postMessage({ type: 'error', error: 'No Salesforce session.' }); return; }

  const abortController = new AbortController();
  const signal = abortController.signal;
  port.onDisconnect.addListener(() => abortController.abort());

  const keepalive = setInterval(() => {
    try { port.postMessage({ type: 'keepalive' }); } catch { clearInterval(keepalive); }
  }, 25_000);

  const progressState = sources.map(() => ({ done: 0, total: 0 }));
  const reportProgress = () => {
    const done = progressState.reduce((sum, p) => sum + p.done, 0);
    const total = progressState.reduce((sum, p) => sum + p.total, 0);
    try { port.postMessage({ type: 'progress', done, total }); } catch {}
  };

  try {
    const reports = await Promise.all(sources.map((session, i) =>
      auditSignatures(session.apiBase, session.sid, {
        monthsBack: msg.monthsBack || 3,
        signal,
        onProgress: (done, total) => {
          progressState[i] = { done, total };
          reportProgress();
        }
      })
    ));

    const report = reports.length === 2 ? mergeAuditReports(reports[0], reports[1]) : reports[0];
    port.postMessage({ type: 'done', report });
  } catch (e) {
    if (signal.aborted || e?.name === 'AbortError') {
      try { port.postMessage({ type: 'stopped', partial: true }); } catch {}
    } else {
      try { port.postMessage({ type: 'error', error: e?.message || 'Audit failed.' }); } catch {}
    }
  } finally {
    clearInterval(keepalive);
  }
}
