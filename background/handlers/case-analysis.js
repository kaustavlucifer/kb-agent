import { detectSession } from '../../shared/auth.js';
import { sfGet, sfQuery, sfSearch, soqlIdList, sanitizeId, mapWithConcurrency, stripHtml } from '../../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../../shared/gateway.js';
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

  send({ type: 'progress', step: 3, label: 'Fetching KB articles for this product area' });
  const product = caseAbstract?.product || intentsResult.product || '';
  const allQueries = intentsResult.intents.flatMap(i => i.queries);

  // Fetch bodies for all articles in the relevant P&T — cached for subsequent runs
  const ptBodies = await fetchPtBodies(session.apiBase, session.sid, product);

  // Search using full content (title + summary + description + resolution)
  let searchResults = searchKBWithBodies(allQueries, ptBodies);
  if (!searchResults.length) {
    searchResults = await fallbackSoslSearch(session.apiBase, session.sid, allQueries);
  }

  send({ type: 'progress', step: 4, label: `Ranking ${searchResults.length} articles` });
  const ranked = rankArticles(searchResults, allQueries);
  const candidates = ranked.slice(0, 15);

  const candidateBodies = new Map();
  candidates.forEach(a => { if (ptBodies.has(a.Id)) candidateBodies.set(a.Id, ptBodies.get(a.Id)); });

  const articleDetailsForAI = candidates.map((a, i) => {
    const body = candidateBodies.get(a.Id) || {};
    const title = body.title || a.Title || '';
    const summary = body.summary || a.Summary || '';
    const desc = stripHtml(body.description || '').slice(0, 2000);
    const res = stripHtml(body.resolution || '').slice(0, 2000);
    const steps = stripHtml(body.steps || '').slice(0, 800);
    return `[${i}] #${a.ArticleNumber} "${title}"\nSummary: ${summary.slice(0, 500)}\nDescription: ${desc.slice(0, 1000)}\nResolution: ${res.slice(0, 1000)}${steps ? '\nSteps: ' + steps.slice(0, 500) : ''}`;
  }).join('\n\n');

  let topArticles;
  try {
    const resp = await callClaudeFast({
      system: `You are assessing KB article relevance to a support case. Read the FULL content of each article (Title, Summary, Description, Resolution) carefully.

Score EACH article 0-100 for relevance. Scoring criteria:
- 80-100: Article directly addresses the SAME error, symptom, or exact scenario in the case
- 60-79: Article covers the same feature/component and a closely related problem
- 40-59: Article is in the same product area but addresses a different specific issue
- 0-39: Article is tangentially related or different product area

Key matching signals:
- Same error message, exception code, or error pattern
- Same component/feature name mentioned in both case and article
- Same workflow or user scenario described
- Resolution in article would directly help this case

Return JSON: {"articles": [{"index": 0, "score": 85, "reason": "short reason"}, ...]}
Include ALL articles. Do not omit any.`,
      messages: [{ role: 'user', content: `CASE:\nSubject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 1200)}\nPriority: ${caseRecord.Priority || ''}\nComments: ${comments.slice(0, 5).map(c => c.CommentBody?.slice(0, 200)).filter(Boolean).join('\n')}\n\nARTICLES:\n${articleDetailsForAI}` }],
      maxTokens: 1200,
      temperature: 0.1
    });
    const parsed = extractJson(extractText(resp));
    if (parsed?.articles?.length) {
      const scored = parsed.articles
        .filter(a => a.index >= 0 && a.index < candidates.length && a.score > 50)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      topArticles = scored.map(s => ({
        ...candidates[s.index],
        _relevanceScore: s.score,
        _relevanceReason: s.reason
      }));
    }
  } catch {}

  if (!topArticles?.length) {
    topArticles = candidates.slice(0, TOP_K);
  }

  const scoredArticles = topArticles.map(a => ({
    id: a.Id, title: a.Title, articleNumber: a.ArticleNumber,
    score: a._relevanceScore || 50,
    reason: a._relevanceReason || '',
    url: `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${a.Id}/view`
  }));

  send({ type: 'meta', topArticles: scoredArticles });

  // Run KB scoring and decision in parallel — send score updates as each completes
  send({ type: 'progress', step: 5, label: 'Scoring articles & evaluating strategy…' });
  const kbScoredArticles = [...scoredArticles];
  const [, decision] = await Promise.all([
    mapWithConcurrency(scoredArticles, 3, async (sa, idx) => {
      try {
        const body = candidateBodies.get(sa.id) || {};
        const article = {
          ...sa,
          description: body.description || '',
          resolution: body.resolution || '',
          steps: body.steps || '',
          additionalResources: body.additionalResources || '',
          summary: candidates.find(c => c.Id === sa.id)?.Summary || '',
          topicName: candidates.find(c => c.Id === sa.id)?.topicName || ''
        };
        const kbScore = await scoreArticleForCaseScan(article);
        kbScoredArticles[idx] = { ...sa, kbScore: kbScore.overall, kbCriteria: kbScore.criteria };
        send({ type: 'meta', topArticles: [...kbScoredArticles] });
      } catch {}
    }),
    makeDecision(caseRecord, caseAbstract, topArticles)
  ]);

  const action = decision.action;
  let structured;

  if (action === 'UPDATE_EXISTING' || action === 'BOTH') {
    // Bodies already fetched for candidates — reuse candidateBodies
    const suggestions = await generateSuggestionsParallel(topArticles, candidateBodies, caseRecord, comments, caseAbstract, send);
    structured = {
      action,
      confidence: decision.confidence,
      summary: `${decision.reason} ${action === 'BOTH' ? 'Showing existing article suggestions and a new article draft.' : 'Updating existing articles.'}`,
      suggestions,
      topologyAssessment: topArticles.map(a => ({ id: a.Id, title: a.Title, articleNumber: a.ArticleNumber }))
    };
  }

  if (action === 'CREATE_NEW' || action === 'BOTH') {
    const draft = await generateNewArticleStreaming(caseRecord, comments, caseAbstract, intentsResult, send);
    if (structured) {
      structured.newArticleDraft = draft;
    } else {
      structured = {
        action: 'CREATE_NEW',
        confidence: decision.confidence,
        summary: `${decision.reason} Drafting a new article.`,
        newArticleDraft: draft
      };
    }
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

const _ptBodyCache = new Map();

async function fetchPtBodies(apiBase, sid, product) {
  const data = await chrome.storage.local.get(['kba_all_articles']);
  const allArticles = data.kba_all_articles || [];
  if (!allArticles.length) return new Map();

  // Identify matching P&Ts based on product name
  const productLower = (product || '').toLowerCase();
  const matchingPts = [...new Set(allArticles.map(a => a.topicName).filter(Boolean))].filter(pt => {
    const ptLower = pt.toLowerCase();
    if (!productLower) return true;
    return ptLower.includes(productLower) || productLower.split(/\s+/).some(w => w.length > 3 && ptLower.includes(w));
  });

  // If no product match, use all Industry/Revenue P&Ts
  const targetPts = matchingPts.length > 0 && matchingPts.length < allArticles.length / 2
    ? matchingPts : allArticles.map(a => a.topicName).filter(Boolean);

  const ptArticles = allArticles.filter(a =>
    a.validationStatus === 'Validated External' &&
    a.publishStatus === 'Online' &&
    targetPts.includes(a.topicName)
  );

  // Check cache
  const cacheKey = targetPts.sort().join('|').slice(0, 100);
  if (_ptBodyCache.has(cacheKey)) return _ptBodyCache.get(cacheKey);

  // Also check localStorage cache
  const cached = await chrome.storage.local.get(['kba_pt_bodies', 'kba_pt_bodies_key', 'kba_pt_bodies_at']);
  if (cached.kba_pt_bodies && cached.kba_pt_bodies_key === cacheKey && cached.kba_pt_bodies_at && Date.now() - cached.kba_pt_bodies_at < 60 * 60 * 1000) {
    const bodyMap = new Map(Object.entries(cached.kba_pt_bodies));
    _ptBodyCache.set(cacheKey, bodyMap);
    return bodyMap;
  }

  // Fetch bodies in batches
  const bodyMap = new Map();
  const ids = ptArticles.map(a => a.id);
  const batches = [];
  for (let i = 0; i < ids.length; i += BODY_FETCH_BATCH_SIZE) batches.push(ids.slice(i, i + BODY_FETCH_BATCH_SIZE));

  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Title, Summary, Description__c, Resolution__c, Steps__c, ArticleNumber, Product_And_Topic__r.Name FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`;
      const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, sid);
      for (const r of (result.records || [])) {
        bodyMap.set(r.Id, {
          id: r.Id,
          title: r.Title || '',
          summary: r.Summary || '',
          articleNumber: r.ArticleNumber || '',
          topicName: r.Product_And_Topic__r?.Name || '',
          description: r.Description__c || '',
          resolution: r.Resolution__c || '',
          steps: r.Steps__c || ''
        });
      }
    } catch {}
  }

  // Cache results
  _ptBodyCache.set(cacheKey, bodyMap);
  const serializable = Object.fromEntries(bodyMap);
  chrome.storage.local.set({ kba_pt_bodies: serializable, kba_pt_bodies_key: cacheKey, kba_pt_bodies_at: Date.now() }).catch(() => {});

  return bodyMap;
}

function searchKBWithBodies(queries, ptBodies) {
  if (!ptBodies.size) return [];

  const rawTerms = queries.join(' ').toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const terms = [...new Set(rawTerms)];
  const importantTerms = terms.filter(t => t.length > 4);

  const results = [];
  for (const [id, article] of ptBodies) {
    const titleText = (article.title || '').toLowerCase();
    const summaryText = (article.summary || '').toLowerCase();
    const descText = stripHtml(article.description).toLowerCase().slice(0, 3000);
    const resText = stripHtml(article.resolution).toLowerCase().slice(0, 3000);
    const fullText = `${titleText} ${summaryText} ${descText} ${resText}`;

    let score = 0;
    for (const t of terms) {
      if (fullText.includes(t)) score += (t.length > 5 ? 2 : 1);
    }
    for (const t of importantTerms) {
      if (titleText.includes(t)) score += 4;
      if (summaryText.includes(t)) score += 2;
    }

    if (score > 0) {
      results.push({
        Id: id,
        Title: article.title,
        Summary: article.summary,
        ArticleNumber: article.articleNumber,
        topicName: article.topicName,
        _score: score
      });
    }
  }

  return results.sort((a, b) => b._score - a._score).slice(0, 20);
}

async function fallbackSoslSearch(apiBase, sid, queries) {
  const seen = new Set();
  const results = [];
  const uniqueQueries = [...new Set(queries.map(q => q.replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, ' ').trim()).filter(Boolean))].slice(0, MAX_SOSL_QUERIES);
  for (const q of uniqueQueries) {
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${q}} IN ALL FIELDS RETURNING Knowledge__kav(Id,KnowledgeArticleId,Title,Summary,ArticleNumber,UrlName,ValidationStatus,PublishStatus WHERE PublishStatus = 'Online' AND Language = 'en_US' AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%')) LIMIT ${SOSL_PER_QUERY}`
      );
      for (const r of records) { if (!seen.has(r.Id)) { seen.add(r.Id); results.push(r); } }
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


async function fetchArticleBodies(apiBase, sid, ids) {
  const bodies = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += BODY_FETCH_BATCH_SIZE) batches.push(ids.slice(i, i + BODY_FETCH_BATCH_SIZE));
  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Description__c, Resolution__c, Steps__c, additional_resources__c FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`;
      const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, sid);
      for (const r of (result.records || [])) {
        bodies.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '', steps: r.Steps__c || '', additionalResources: r.additional_resources__c || '' });
      }
    } catch {}
  }
  return bodies;
}

const SCORING_CRITERIA = [
  { id: 'title', label: 'Title Quality', baseMax: 12 },
  { id: 'summary', label: 'Summary Quality', baseMax: 10 },
  { id: 'headers', label: 'Header Structure', baseMax: 10 },
  { id: 'content', label: 'Content Completeness', baseMax: 18 },
  { id: 'scannability', label: 'Scannability & Structure', baseMax: 10 },
  { id: 'media', label: 'Alt Text / Media', baseMax: 8 },
  { id: 'code', label: 'Code Block Quality', baseMax: 8 },
  { id: 'tables', label: 'Table Quality', baseMax: 8 },
  { id: 'links', label: 'Links & URLs', baseMax: 8 },
  { id: 'taxonomy', label: 'Taxonomy & Product Context', baseMax: 8 }
];

async function scoreArticleForCaseScan(article) {
  const descRaw = article.description || '';
  const resRaw = article.resolution || '';
  const descText = stripHtml(descRaw).slice(0, MAX_BODY_CHARS);
  const resText = stripHtml(resRaw).slice(0, MAX_BODY_CHARS);
  const stepsText = stripHtml(article.steps || '').slice(0, 1500);

  const flags = [];
  if (/(<img\s)/i.test(descRaw + resRaw)) flags.push('HAS_IMAGES');
  if (/(<video|youtube|vimeo)/i.test(descRaw + resRaw)) flags.push('HAS_VIDEO');
  if (/<pre[^>]*class="[^"]*ckeditor_codeblock/i.test(descRaw + resRaw)) flags.push('HAS_CODE_BLOCKS');
  if (/<table[\s>]/i.test(descRaw + resRaw)) flags.push('HAS_TABLES');

  const naSet = new Set();
  if (!flags.includes('HAS_IMAGES') && !flags.includes('HAS_VIDEO')) naSet.add('media');
  if (!flags.includes('HAS_CODE_BLOCKS')) naSet.add('code');
  if (!flags.includes('HAS_TABLES')) naSet.add('tables');

  const freedPoints = SCORING_CRITERIA.filter(c => naSet.has(c.id)).reduce((sum, c) => sum + c.baseMax, 0);
  const maxes = {};
  if (freedPoints === 0) {
    SCORING_CRITERIA.forEach(c => { maxes[c.id] = c.baseMax; });
  } else {
    const redistribution = {};
    const contentBonus = Math.round(freedPoints * 0.45);
    redistribution['content'] = contentBonus;
    const activeIds = SCORING_CRITERIA.filter(c => !naSet.has(c.id)).map(c => c.id);
    const secondaryIds = activeIds.filter(id => id !== 'content' && id !== 'title' && id !== 'summary');
    const secondaryBase = secondaryIds.reduce((s, id) => s + SCORING_CRITERIA.find(c => c.id === id).baseMax, 0);
    const remaining = freedPoints - contentBonus;
    for (const id of secondaryIds) {
      const base = SCORING_CRITERIA.find(c => c.id === id).baseMax;
      redistribution[id] = Math.round(remaining * (base / secondaryBase));
    }
    for (const c of SCORING_CRITERIA) {
      if (naSet.has(c.id)) maxes[c.id] = 0;
      else maxes[c.id] = c.baseMax + (redistribution[c.id] || 0);
    }
    const total = Object.values(maxes).reduce((a, b) => a + b, 0);
    if (total !== 100) maxes['content'] += (100 - total);
  }

  const m = maxes;
  const resp = await callClaudeFast({
    system: `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce readiness.
Score this article. Dynamic max points per criterion are provided. TOTAL MUST EQUAL 100.
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : ''}
SCORING: Be STRICT. Most articles score 55-75.
CRITERIA: title(max ${m.title}), summary(max ${m.summary}), headers(max ${m.headers}), content(max ${m.content}), scannability(max ${m.scannability}), media(max ${m.media}), code(max ${m.code}), tables(max ${m.tables}), links(max ${m.links}), taxonomy(max ${m.taxonomy}).
Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"...","score":<n>,"passed":["..."],"issues":["..."],"suggestions":["..."]},...]}`,
    messages: [{ role: 'user', content: `Title: ${article.title}\nArticle#: ${article.articleNumber}\nP&T: ${article.topicName || '(none)'}\nSUMMARY: ${article.summary || '(empty)'}\nDESCRIPTION (${descText.length} chars): ${descText || '(empty)'}\nRESOLUTION (${resText.length} chars): ${resText || '(empty)'}${stepsText ? '\nSTEPS: ' + stepsText : ''}` }],
    maxTokens: 2200,
    temperature: 0.1,
    model: 'claude-haiku-4-5-20251001'
  });

  const text = extractText(resp);
  const obj = extractJson(text);
  if (!obj) return { overall: null, criteria: [], error: 'No JSON' };

  const criteria = SCORING_CRITERIA.map(c => {
    const found = (obj.criteria || []).find(x => x.id === c.id) || {};
    const effectiveMax = maxes[c.id] ?? c.baseMax;
    const isNa = found.na === true || effectiveMax === 0;
    const score = isNa ? 0 : Math.min(effectiveMax, Math.max(0, Math.round(Number(found.score) || 0)));
    return { id: c.id, label: c.label, score, max: effectiveMax, na: isNa, passed: Array.isArray(found.passed) ? found.passed.filter(Boolean) : [], issues: Array.isArray(found.issues) ? found.issues.filter(Boolean) : [], suggestions: Array.isArray(found.suggestions) ? found.suggestions.filter(Boolean) : [] };
  });
  const overall = Math.min(100, criteria.reduce((s, c) => s + c.score, 0));
  return { overall, criteria, error: null };
}

async function generateSuggestionsParallel(articles, bodyMap, caseRecord, comments, abstract, send) {
  const allSuggestions = [];
  const commentSnippets = comments.filter(c => c.CommentBody?.length > 30).slice(0, 3).map(c => c.CommentBody.slice(0, 300)).join('\n---\n');

  const tasks = articles.slice(0, 2).map(article => async () => {
    const body = bodyMap.get(article.Id) || {};
    const descText = stripHtml(body.description).slice(0, MAX_BODY_CHARS);
    const resText = stripHtml(body.resolution).slice(0, MAX_BODY_CHARS);

    try {
      const fullText = await streamClaude({
        system: `You are an expert KB editor optimizing articles for Agentforce readiness. Given an article and a case, identify 1-3 improvements based on these rules:
- Titles must be product-specific and describe the exact issue
- Use H2/H3 headers (not bold text) to break content into sections for chunking
- Description should state problem, symptoms, context and WHY
- Resolution should start with what steps accomplish, then numbered steps
- Code blocks need plain-text explanations
- Explain acronyms. Use present tense. Be specific about product + feature.
Return JSON: {"suggestions":[{"title":"...","location":"...","content":"...","impact":"HIGH"|"MEDIUM"|"LOW"}]}`,
        messages: [{ role: 'user', content: `ARTICLE: #${article.ArticleNumber} "${article.Title}"\nDESCRIPTION: ${descText.slice(0, 2000)}\nRESOLUTION: ${resText.slice(0, 2000)}\n\nCASE: ${caseRecord.Subject}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 800)}\n${commentSnippets ? 'Comments:\n' + commentSnippets : ''}` }],
        maxTokens: 1500,
        temperature: 0.2,
        onDelta: (chunk) => {
          send({ type: 'suggestion-delta', articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title, chunk });
        }
      });
      const parsed = extractJson(fullText);
      if (parsed?.suggestions) {
        const articleSugs = parsed.suggestions.map(s => ({ ...s, articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title }));
        allSuggestions.push(...articleSugs);
        send({ type: 'suggestion-ready', articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title, suggestions: articleSugs });
      }
    } catch (e) {
      send({ type: 'suggestion-error', articleId: article.Id, articleNumber: article.ArticleNumber, error: e?.message || 'Failed' });
    }
  });

  await Promise.all(tasks.map(fn => fn()));
  return allSuggestions;
}

async function makeDecision(caseRecord, abstract, topArticles) {
  if (!topArticles.length) return { action: 'CREATE_NEW', confidence: 'HIGH', reason: 'No existing articles found.' };
  const articleList = topArticles.slice(0, 5).map((a, i) => `${i+1}. #${a.ArticleNumber} "${a.Title}" — ${(a.Summary || '').slice(0, 150)}`).join('\n');
  const resp = await callClaudeFast({
    system: `You decide whether to UPDATE existing KB articles or CREATE a new one. Rules:
- STRONGLY prefer UPDATE_EXISTING or BOTH — article proliferation is expensive, updating existing articles is always better
- If ANY article covers the same product area, same feature, or same category of problem, choose UPDATE_EXISTING — even if the specific error is different, the article can be expanded
- Only choose CREATE_NEW when ZERO articles relate to the same product feature area at all — this should be very rare when articles exist
- Choose BOTH when you want to update existing articles AND also draft a new one for a distinctly different aspect not covered
- When in doubt, choose BOTH over CREATE_NEW — always produce update suggestions for existing articles
Return JSON: {"action":"UPDATE_EXISTING"|"CREATE_NEW"|"BOTH","confidence":"HIGH"|"MEDIUM"|"LOW","reason":"one sentence"}`,
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 600)}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\n\nExisting articles (these were already scored as relevant):\n${articleList}` }],
    maxTokens: 200,
    temperature: 0.1
  });
  const parsed = extractJson(extractText(resp));
  return parsed || { action: 'UPDATE_EXISTING', confidence: 'LOW', reason: 'Defaulting to update.' };
}

async function generateNewArticleStreaming(caseRecord, comments, abstract, intents, send) {
  const commentText = comments.slice(0, 5).map(c => c.CommentBody?.slice(0, 400)).filter(Boolean).join('\n---\n');
  const fullText = await streamClaude({
    system: `You are drafting a new Salesforce KB article optimized for Agentforce consumption. Follow these Agentforce writing rules strictly:

KEY RULES FROM THE WRITING GUIDE:
- TITLE: Must be specific to the product + exact issue. Include product name, error text, or scenario. Not general (e.g. "Troubleshooting Tableau Prep Flows" not "Troubleshooting Flows").
- SUMMARY: 2-4 sentences covering problem context and resolution approach.
- HEADERS: Use H2/H3 headers to break content into logical sections. Never use bold text as substitute for headers. Headers are used in chunking for Agentforce.
- DESCRIPTION: State the problem, symptoms, and context. Explain WHY this happens. Include product name with feature terms to avoid ambiguity.
- RESOLUTION: Begin with a brief statement of what the steps accomplish, then provide numbered steps. After code blocks, add plain-text explanation.
- Explain acronyms and abbreviations. Use simple present tense.
- Each FAQ item must be specific in intent and solution. Very large FAQs are not consumed well.
- Code blocks should be described succinctly in text for better Agentforce response.
- Tables should use text, not visual indicators like checkmarks.

Return JSON: {"title":"...","sections":[{"heading":"...","body":"..."}]}`,
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${abstract?.product || intents.product || ''}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nTopology: ${abstract?.configurationTopology || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 1500)}\nComments:\n${commentText}` }],
    maxTokens: FINAL_MAX_TOKENS,
    temperature: 0.3,
    onDelta: (chunk) => { send({ type: 'delta', chunk }); }
  });
  return extractJson(fullText) || { title: caseRecord.Subject, sections: [{ heading: 'Description', body: caseRecord.Description || '' }] };
}
