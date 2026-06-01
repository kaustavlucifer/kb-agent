import { detectSession } from '../../shared/auth.js';
import { sfGet, sfQuery, sfSearch, soqlIdList, sanitizeId, escapeSoql, mapWithConcurrency, stripHtml } from '../../shared/api.js';
import { callClaude, callClaudeFast, extractText, extractJson } from '../../shared/gateway.js';
import { TOP_K, FINAL_MAX_TOKENS, SOSL_PER_QUERY, MAX_SOSL_QUERIES, SF_API_VERSION, MAX_BODY_CHARS, BODY_FETCH_BATCH_SIZE } from '../../shared/config.js';

export async function handleAnalyze(port, msg) {
  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No Salesforce session. Log into OrgCS.' }); return; }

  const send = (data) => { try { port.postMessage(data); } catch {} };
  const caseId = sanitizeId(msg.caseId);

  send({ type: 'progress', step: 0, label: 'Connecting to Salesforce' });

  send({ type: 'progress', step: 1, label: 'Fetching case + comments' });
  const caseFields = 'Id,CaseNumber,Subject,Description,Status,Priority,CreatedDate';
  const caseRecord = await sfGet(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}?fields=${caseFields}`, session.sid);
  if (!caseRecord || !caseRecord.Id) { send({ type: 'error', error: 'Case not found.' }); return; }
  send({ type: 'progress', step: 1, label: 'Fetching comments…', caseNumber: caseRecord.CaseNumber });

  const comments = await sfQuery(session.apiBase, session.sid,
    `SELECT Id, CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${caseId}' ORDER BY CreatedDate ASC LIMIT 50`
  );

  send({ type: 'progress', step: 2, label: 'Extracting intents' });
  const intentsResult = await extractIntents(caseRecord, comments);
  const caseAbstract = await extractAbstract(caseRecord, comments);

  send({ type: 'progress', step: 3, label: 'Searching the knowledge base' });
  const allQueries = intentsResult.intents.flatMap(i => i.queries);
  const searchResults = await searchKB(session.apiBase, session.sid, allQueries);

  send({ type: 'progress', step: 4, label: `Ranking ${searchResults.length} articles` });
  const ranked = rankArticles(searchResults, allQueries);
  const topArticles = ranked.slice(0, TOP_K);

  send({ type: 'progress', step: 5, label: 'Generating recommendation' });
  const decision = await makeDecision(caseRecord, caseAbstract, topArticles);

  let structured;
  if (decision.action === 'UPDATE_EXISTING' && topArticles.length) {
    const bodies = await fetchArticleBodies(session.apiBase, session.sid, topArticles.map(a => a.Id));
    const suggestions = await generateSuggestions(topArticles, bodies, caseRecord, comments, caseAbstract);
    structured = { action: 'UPDATE_EXISTING', confidence: decision.confidence, summary: decision.reason, suggestions, topologyAssessment: topArticles.map(a => ({ id: a.Id, title: a.Title, articleNumber: a.ArticleNumber })) };
  } else {
    const draft = await generateNewArticle(caseRecord, comments, caseAbstract, intentsResult);
    structured = { action: 'CREATE_NEW', confidence: decision.confidence, summary: decision.reason, newArticleDraft: draft };
  }

  send({ type: 'result', success: true, caseId, caseNumber: caseRecord.CaseNumber, subject: caseRecord.Subject, caseAbstract, structured });
}

export async function handleThemeVolume(port, msg) {
  port.postMessage({ type: 'themeVolumeResult', success: false, error: 'Theme volume not yet implemented.' });
}

export async function handleBroaden(port, msg) {
  port.postMessage({ type: 'broadenResult', success: false, error: 'Broaden not yet implemented.' });
}

async function extractIntents(caseRecord, comments) {
  const commentsText = comments.slice(0, 10).map((c, i) => `Comment ${i + 1}: ${c.CommentBody}`).join('\n');
  const resp = await callClaudeFast({
    system: 'Extract search intents from this support case. Return JSON: {"theme":"...","product":"...","intents":[{"intent":"...","queries":["..."]}]}',
    messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 2000)}\nComments:\n${commentsText.slice(0, 3000)}` }],
    maxTokens: 800,
    temperature: 0.1
  });
  const parsed = extractJson(extractText(resp));
  if (!parsed?.intents) return { theme: caseRecord.Subject, product: null, intents: [{ intent: caseRecord.Subject, queries: [caseRecord.Subject] }] };
  return { theme: parsed.theme || '', product: parsed.product || null, intents: parsed.intents };
}

async function extractAbstract(caseRecord, comments) {
  const commentsText = comments.slice(0, 8).map((c, i) => `Comment ${i + 1}: ${c.CommentBody}`).join('\n');
  try {
    const resp = await callClaudeFast({
      system: 'Extract a problem signature from this case. Return JSON: {"product":"...","symptomClass":"...","errorSignature":"...or null","configurationTopology":"...","audienceHint":"..."}',
      messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 1500)}\nComments:\n${commentsText.slice(0, 2000)}` }],
      maxTokens: 500,
      temperature: 0.1
    });
    return extractJson(extractText(resp)) || null;
  } catch { return null; }
}

async function searchKB(apiBase, sid, queries) {
  const seen = new Set();
  const results = [];
  const uniqueQueries = [...new Set(queries.map(q => q.replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, ' ').trim()).filter(Boolean))].slice(0, MAX_SOSL_QUERIES);

  for (const q of uniqueQueries) {
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${q}} IN ALL FIELDS RETURNING Knowledge__kav(Id,KnowledgeArticleId,Title,Summary,ArticleNumber,UrlName,ValidationStatus,PublishStatus WHERE PublishStatus = 'Online' AND Language = 'en_US') LIMIT ${SOSL_PER_QUERY}`
      );
      for (const r of records) {
        if (!seen.has(r.Id)) { seen.add(r.Id); results.push(r); }
      }
    } catch {}
  }
  return results;
}

function rankArticles(articles, queries) {
  const terms = queries.join(' ').toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return articles.map(a => {
    const text = `${a.Title || ''} ${a.Summary || ''}`.toLowerCase();
    const score = terms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
    return { ...a, _score: score };
  }).sort((a, b) => b._score - a._score);
}

async function makeDecision(caseRecord, abstract, topArticles) {
  const articleList = topArticles.map((a, i) => `${i + 1}. #${a.ArticleNumber} — "${a.Title}" (${a.ValidationStatus || '?'})`).join('\n');
  const resp = await callClaudeFast({
    system: 'Decide if a KB article should be UPDATED or CREATED. Return JSON: {"action":"UPDATE_EXISTING"|"CREATE_NEW","confidence":"HIGH"|"MEDIUM"|"LOW","reason":"...","primaryArticleId":"...or null"}',
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${abstract?.product || null || ''}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || 'none'}\nDescription: ${(caseRecord.Description || '').slice(0, 600)}\n\nExisting articles:\n${articleList}` }],
    maxTokens: 400,
    temperature: 0.1
  });
  return extractJson(extractText(resp)) || { action: 'CREATE_NEW', confidence: 'LOW', reason: 'Could not determine.' };
}

async function fetchArticleBodies(apiBase, sid, ids) {
  const bodies = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += BODY_FETCH_BATCH_SIZE) batches.push(ids.slice(i, i + BODY_FETCH_BATCH_SIZE));
  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Description__c, Resolution__c, Steps__c FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`;
      const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, sid);
      for (const r of (result.records || [])) {
        bodies.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '', steps: r.Steps__c || '' });
      }
    } catch {}
  }
  return bodies;
}

async function generateSuggestions(articles, bodyMap, caseRecord, comments, abstract) {
  const allSuggestions = [];
  const commentSnippets = comments.filter(c => c.CommentBody?.length > 30).slice(0, 3).map(c => c.CommentBody.slice(0, 300)).join('\n---\n');

  for (const article of articles.slice(0, 3)) {
    const body = bodyMap.get(article.Id) || {};
    const descText = stripHtml(body.description).slice(0, MAX_BODY_CHARS);
    const resText = stripHtml(body.resolution).slice(0, MAX_BODY_CHARS);

    try {
      const resp = await callClaude({
        system: `You are an expert KB editor optimizing articles for Agentforce. Given an article and a case, identify 1-3 improvements. Return JSON: {"suggestions":[{"title":"...","location":"...","content":"...","impact":"HIGH"|"MEDIUM"|"LOW"}]}`,
        messages: [{ role: 'user', content: `ARTICLE: #${article.ArticleNumber} "${article.Title}"\nDESCRIPTION: ${descText.slice(0, 2000)}\nRESOLUTION: ${resText.slice(0, 2000)}\n\nCASE: ${caseRecord.Subject}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 800)}\n${commentSnippets ? 'Comments:\n' + commentSnippets : ''}` }],
        maxTokens: 1500,
        temperature: 0.2
      });
      const parsed = extractJson(extractText(resp));
      if (parsed?.suggestions) {
        parsed.suggestions.forEach(s => allSuggestions.push({ ...s, articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title }));
      }
    } catch {}
  }
  return allSuggestions;
}

async function generateNewArticle(caseRecord, comments, abstract, intents) {
  const commentText = comments.slice(0, 5).map(c => c.CommentBody?.slice(0, 400)).filter(Boolean).join('\n---\n');
  const resp = await callClaude({
    system: `You are drafting a new Salesforce KB article. Follow Agentforce writing rules: product-specific title, H2 headers, clear description+resolution. Return JSON: {"title":"...","sections":[{"heading":"...","body":"..."}]}`,
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${abstract?.product || intents.product || ''}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nTopology: ${abstract?.configurationTopology || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 1500)}\nComments:\n${commentText}` }],
    maxTokens: FINAL_MAX_TOKENS,
    temperature: 0.3
  });
  return extractJson(extractText(resp)) || { title: caseRecord.Subject, sections: [{ heading: 'Description', body: caseRecord.Description || '' }] };
}
