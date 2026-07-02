import { detectSession, pingKiSession, clearAuthCache } from '../shared/auth.js';
import { pingGateway, callClaude, extractText, extractJson } from '../shared/gateway.js';
import { flushCost, onCostStorageChange } from '../shared/cost.js';
import { localGet, localSet } from '../shared/storage.js';
import { sfQuery, sfQueryAll, escapeSoql, sanitizeId, stripHtml } from '../shared/api.js';
import { STORAGE_KEYS, CACHE_TTL_MS, SF_API_VERSION, applySettings } from '../shared/config.js';
import { mapArticleRecord, scoreArticle as sharedScoreArticle } from '../shared/scoring.js';
import { GUIDE_GENERATION, GUIDE_STYLE } from '../data/writing_guide_prompts.js';

import { handleAnalyze, handleGenerateNew } from './handlers/case-analysis.js';
import { handleCoverage, analyzePtCoverage } from './handlers/coverage.js';
import { handleDedup, handleMerge } from './handlers/dedup.js';
import { publishNewArticle, publishUpdateDraft } from './handlers/article-publish.js';
import { checkGusConnection } from './handlers/gus-enrichment.js';

let _settingsReady = (async () => {
  try {
    const data = await localGet([STORAGE_KEYS.SETTINGS]);
    applySettings(data[STORAGE_KEYS.SETTINGS]);
  } catch {}
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEYS.SETTINGS]) {
    applySettings(changes[STORAGE_KEYS.SETTINGS].newValue);
  }
  onCostStorageChange(changes);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  _settingsReady.then(() => handleMessage(msg))
    .then(result => flushCost().then(() => sendResponse(result)))
    .catch(e => flushCost().then(() => sendResponse({ error: e.message })));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  _settingsReady.then(() => handlePort(port));
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'CHECK_CONNECTION': {
      const session = await detectSession();
      if (!session.sid) return { connected: false, orgKey: null, lightningHost: null };
      try {
        const r = await fetch(`${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent('SELECT Id, Name FROM User WHERE IsActive = true LIMIT 1')}`, {
          headers: { Authorization: `Bearer ${session.sid}`, Accept: 'application/json' }
        });
        if (!r.ok) return { connected: false, orgKey: session.key || null, lightningHost: session.lightningHost, reason: 'session_expired' };
      } catch {
        return { connected: false, orgKey: session.key || null, lightningHost: session.lightningHost, reason: 'network_error' };
      }
      return { connected: true, orgKey: session.key || null, lightningHost: session.lightningHost };
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
    case 'COVERAGE_ANALYZE_PT': return analyzePtCoverage(msg);
    case 'REFINE_SECTION': return refineSection(msg);
    case 'PUBLISH_NEW_ARTICLE': return publishNewArticle(msg.payload);
    case 'PUBLISH_UPDATE_DRAFT': return publishUpdateDraft(msg.payload);
    case 'CHECK_GUS_CONNECTION': return checkGusConnection();
    case 'GENERATE_ARTICLE_UPDATE': return generateArticleUpdate(msg);
    case 'FETCH_ARTICLE_PREVIEW': return fetchArticlePreview(msg.articleId);
    case 'CHECK_KI_CONNECTION': return checkKiConnection();
    case 'REFRESH_AUTH': { clearAuthCache(); return { cleared: true }; }
    case 'SCORE_DRAFT_ARTICLE': return scoreDraftArticle(msg.article);
    default: return { error: `Unknown action: ${msg.action}` };
  }
}

async function generateArticleUpdate(msg) {
  const { articleTitle, caseSubject, caseAbstract } = msg;
  const safeId = sanitizeId(msg.articleId);
  const session = await detectSession();
  if (!session.sid) return { success: false, error: 'No SF session' };

  let articleBody = '';
  try {
    const soql = `SELECT Id, Title, Summary, Description__c, Resolution__c, Steps__c FROM Knowledge__kav WHERE Id = '${safeId}' LIMIT 1`;
    const records = await sfQuery(session.apiBase, session.sid, soql);
    if (records.length) {
      const r = records[0];
      articleBody = `Title: ${r.Title || ''}\nSummary: ${r.Summary || ''}\nDescription: ${(r.Description__c || '').slice(0, 3000)}\nResolution: ${(r.Resolution__c || '').slice(0, 3000)}`;
    }
  } catch {}

  if (!articleBody) articleBody = `Title: ${articleTitle}\n(Article body could not be fetched)`;

  try {
    const resp = await callClaude({
      system: `You are rewriting a Salesforce KB article to incorporate new case context. Follow Agentforce writing rules:
${GUIDE_GENERATION}

${GUIDE_STYLE}

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

async function scoreDraftArticle(article) {
  if (!article) return { success: false, error: 'No article provided' };
  try {
    const result = await sharedScoreArticle(article);
    if (result.overall == null) return { success: false, error: result.error || 'Could not parse score' };
    return { success: true, score: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fetchArticlePreview(articleId) {
  const safeId = sanitizeId(articleId);
  if (!safeId) return { success: false, error: 'Invalid article ID' };
  const session = await detectSession();
  if (!session.sid) return { success: false, error: 'No SF session' };
  try {
    const soql = `SELECT Id, Title, Summary, ArticleNumber, Description__c, Resolution__c, Steps__c FROM Knowledge__kav WHERE Id = '${safeId}' LIMIT 1`;
    const records = await sfQuery(session.apiBase, session.sid, soql);
    if (!records.length) return { success: false, error: 'Article not found' };
    const r = records[0];
    return {
      success: true,
      article: {
        id: r.Id,
        title: r.Title || '',
        summary: r.Summary || '',
        articleNumber: r.ArticleNumber || '',
        descriptionHtml: r.Description__c || '',
        resolutionHtml: r.Resolution__c || '',
        stepsHtml: r.Steps__c || '',
        description: stripHtml(r.Description__c || ''),
        resolution: stripHtml(r.Resolution__c || ''),
        steps: stripHtml(r.Steps__c || '')
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

${GUIDE_STYLE}${focusInstruction}

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

async function searchCases(query) {
  if (!query || query.length < 3) return { cases: [] };
  const escaped = escapeSoql(query);

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await detectSession();
    if (!session.sid) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 500)); continue; }
      return { cases: [] };
    }
    try {
      let soql;
      if (/^\d+$/.test(query)) {
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber LIKE '${escaped}%' ORDER BY CreatedDate DESC LIMIT 8`;
      } else if (/^[a-zA-Z0-9]{15,18}$/.test(query)) {
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE Id = '${escaped}' LIMIT 1`;
      } else {
        soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE (Subject LIKE '%${escaped}%' OR CaseNumber LIKE '%${escaped}%') ORDER BY CreatedDate DESC LIMIT 8`;
      }
      const records = await sfQuery(session.apiBase, session.sid, soql);
      return { cases: records };
    } catch (e) {
      if (attempt === 0 && /session|unauthorized|401/i.test(e?.message || '')) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return { cases: [] };
    }
  }
  return { cases: [] };
}

async function resolveCase(caseNumber) {
  if (!/^\d{3,15}$/.test(caseNumber)) return { success: false, error: 'Invalid case number format' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await detectSession();
    if (!session.sid) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 500)); continue; }
      return { success: false, error: 'No SF session — log into OrgCS first' };
    }
    try {
      const soql = `SELECT Id, CaseNumber, Subject FROM Case WHERE CaseNumber = '${escapeSoql(caseNumber)}' LIMIT 1`;
      const records = await sfQuery(session.apiBase, session.sid, soql);
      if (!records.length) return { success: false, error: `Case #${caseNumber} not found in ${session.key || 'org'}` };
      return { success: true, caseId: records[0].Id, caseNumber: records[0].CaseNumber, subject: records[0].Subject };
    } catch (e) {
      if (attempt === 0 && /session|unauthorized|401/i.test(e?.message || '')) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return { success: false, error: `Query failed: ${e.message}` };
    }
  }
  return { success: false, error: 'Failed to resolve case number after retries' };
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
    fn(guardedPort, msg)
      .catch(e => {
        if (!disconnected) { try { port.postMessage({ type: 'error', error: e.message }); } catch {} }
      })
      .finally(() => { flushCost(); });
  };

  switch (port.name) {
    case 'kba-analyze':
      port.onMessage.addListener((msg) => {
        if (msg.action === 'ANALYZE_CASE') wrap(handleAnalyze)(msg);
        else if (msg.action === 'GENERATE_NEW_ARTICLE') wrap(handleGenerateNew)(msg);
      });
      break;
    case 'kbs-coverage':
      port.onMessage.addListener(wrap(handleCoverage));
      break;
    case 'kba-coverage-stream':
      port.onMessage.addListener((msg) => {
        analyzePtCoverage(msg, guardedPort)
          .catch(e => {
            if (!disconnected) { try { port.postMessage({ type: 'error', error: e.message }); } catch {} }
          })
          .finally(() => { flushCost(); });
      });
      break;
    case 'kbs-dedup':
      port.onMessage.addListener(wrap(handleDedup));
      break;
    case 'kbs-merge':
      port.onMessage.addListener(wrap(handleMerge));
      break;
  }
}


(async () => {
  try {
    const cached = await localGet([STORAGE_KEYS.ALL_ARTICLES_AT]);
    const cachedAt = cached[STORAGE_KEYS.ALL_ARTICLES_AT] || 0;
    if (Date.now() - cachedAt < CACHE_TTL_MS) {
      return;
    }

    const session = await detectSession();
    if (!session.sid) return;

    const META_FIELDS = 'Id, KnowledgeArticleId, ArticleNumber, Title, Summary, UrlName, PublishStatus, ValidationStatus, LastPublishedDate, LastModifiedDate, Contains_Image__c, Contains_Video__c, Article_Length__c, ArticleTotalViewCount, ArticleCaseAttachCount, Product_And_Topic__r.Name';

    const [tier1Records, tier2Records] = await Promise.all([
      sfQueryAll(session.apiBase, session.sid,
        `SELECT ${META_FIELDS} FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language IN ('en_US','en_GB') AND ValidationStatus = 'Validated External' AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%') ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`
      ),
      sfQueryAll(session.apiBase, session.sid,
        `SELECT ${META_FIELDS} FROM Knowledge__kav WHERE Language IN ('en_US','en_GB') AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%') ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`
      )
    ]);

    const tier1 = tier1Records.map(mapArticleRecord);
    const tier1Ids = new Set(tier1.map(a => a.id));
    const tier2Only = tier2Records.map(mapArticleRecord).filter(a => !tier1Ids.has(a.id));
    const allArticles = [...tier1, ...tier2Only];

    await localSet({
      [STORAGE_KEYS.ALL_ARTICLES]: allArticles,
      [STORAGE_KEYS.ALL_ARTICLES_AT]: Date.now()
    });
  } catch (e) {
  }
})();
