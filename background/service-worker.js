import { detectSession } from '../shared/auth.js';
import { pingGateway, callClaude, extractText } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { sfQuery, sfQueryAll, escapeSoql } from '../shared/api.js';
import { STORAGE_KEYS } from '../shared/config.js';
import { WRITING_GUIDE } from '../data/writing_guide.js';

import { handleAnalyze, handleThemeVolume, handleBroaden } from './handlers/case-analysis.js';
import { handleScoreBatch, handleRewrite } from './handlers/kb-scorer.js';
import { handleCoverage, analyzePtCoverage } from './handlers/coverage.js';
import { handleDedup, handleMerge } from './handlers/dedup.js';
import { publishNewArticle, publishUpdateDraft } from './handlers/article-publish.js';
import { checkGusConnection } from './handlers/gus-enrichment.js';

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
    case 'RESOLVE_CASE_NUMBER': return resolveCase(msg.caseNumber);
    case 'SEARCH_CASES': return searchCases(msg.query);
    case 'COVERAGE_ANALYZE_PT': return analyzePtCoverage(msg);
    case 'REFINE_SECTION': return refineSection(msg);
    case 'PUBLISH_NEW_ARTICLE': return publishNewArticle(msg.payload);
    case 'PUBLISH_UPDATE_DRAFT': return publishUpdateDraft(msg.payload);
    case 'CHECK_GUS_CONNECTION': return checkGusConnection();
    default: return { error: `Unknown action: ${msg.action}` };
  }
}

async function refineSection(msg) {
  const { content, title, focus } = msg;
  if (!content) return { success: false, error: 'No content provided' };
  try {
    const guideRules = WRITING_GUIDE.slice(0, 2500);
    const focusInstruction = focus ? `\n\nUSER FOCUS: "${focus}" — prioritize this aspect in your refinement.` : '';
    const resp = await callClaude({
      system: `You are an expert KB editor for Salesforce Agentforce. Refine this section following the Agentforce writing guide rules:
- Titles must be specific to product + exact issue (not generic)
- Use H2/H3 headers for structure (not bold text) — headers are used for chunking
- Be specific about product names + features to avoid ambiguity
- Explain acronyms and abbreviations. Use simple present tense
- For resolutions: brief summary of what steps accomplish, then numbered steps
- After code blocks, add plain-text explanation of what the code does
- Tables should use text, not visual indicators like checkmarks
- Give real-life examples when information is complex
- Keep content concise but complete${focusInstruction}

Return ONLY the improved text, no JSON wrapping or explanation.`,
      messages: [{ role: 'user', content: `WRITING GUIDE REFERENCE:\n${guideRules}\n\n---\nSection Title: ${title}\n\nContent to refine:\n${content}` }],
      maxTokens: 2000,
      temperature: 0.2
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
  let disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; });

  const guardedPort = new Proxy(port, {
    get(target, prop) {
      if (prop === 'postMessage') return (...args) => { if (!disconnected) { try { target.postMessage(...args); } catch {} } };
      return target[prop];
    }
  });

  const wrap = (fn) => (msg) => {
    fn(guardedPort, msg).catch(e => {
      if (!disconnected) { try { port.postMessage({ type: 'error', error: e.message }); } catch {} }
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
    case 'kba-coverage-stream':
      port.onMessage.addListener((msg) => {
        analyzePtCoverage(msg, guardedPort).catch(e => {
          if (!disconnected) { try { port.postMessage({ type: 'error', error: e.message }); } catch {} }
        });
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

function mapArticleRecord(r) {
  return {
    id: r.Id,
    knowledgeArticleId: r.KnowledgeArticleId,
    articleNumber: r.ArticleNumber,
    title: r.Title,
    summary: r.Summary,
    urlName: r.UrlName,
    publishStatus: r.PublishStatus || 'Online',
    validationStatus: r.ValidationStatus,
    topicName: r.Product_And_Topic__r?.Name || '',
    containsImage: !!r.Contains_Image__c,
    containsVideo: !!r.Contains_Video__c,
    articleLength: r.Article_Length__c || 0,
    viewCount: r.ArticleTotalViewCount || 0,
    caseAttachCount: r.ArticleCaseAttachCount || 0,
    lastPublished: r.LastPublishedDate
  };
}

(async () => {
  try {
    const session = await detectSession();
    if (!session.sid) return;

    const META_FIELDS = 'Id, KnowledgeArticleId, ArticleNumber, Title, Summary, UrlName, PublishStatus, ValidationStatus, LastPublishedDate, LastModifiedDate, Contains_Image__c, Contains_Video__c, Article_Length__c, ArticleTotalViewCount, ArticleCaseAttachCount, Product_And_Topic__r.Name';

    const tier1Records = await sfQueryAll(session.apiBase, session.sid,
      `SELECT ${META_FIELDS} FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language IN ('en_US','en_GB') AND ValidationStatus = 'Validated External' AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%') ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`
    );

    const tier2Records = await sfQueryAll(session.apiBase, session.sid,
      `SELECT ${META_FIELDS} FROM Knowledge__kav WHERE Language IN ('en_US','en_GB') AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%') ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`
    );

    const tier1 = tier1Records.map(mapArticleRecord);
    const tier1Ids = new Set(tier1.map(a => a.id));
    const tier2Only = tier2Records.map(mapArticleRecord).filter(a => !tier1Ids.has(a.id));
    const allArticles = [...tier1, ...tier2Only];

    await localSet({
      [STORAGE_KEYS.ALL_ARTICLES]: allArticles,
      [STORAGE_KEYS.ALL_ARTICLES_AT]: Date.now()
    });
    console.log(`[KB-Agent] Preloaded ${allArticles.length} articles (${tier1.length} validated, ${tier2Only.length} other).`);
  } catch (e) {
    console.warn('[KB-Agent] Preload failed:', e.message);
  }
})();
