import { detectSession, isCaseAnalysisAllowed, verifyGuardRailFields } from '../../shared/auth.js';
import { sfGet, sfQuery, sfSearch, soqlIdList, sanitizeId, escapeSosl, mapWithConcurrency, stripHtml } from '../../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../../shared/gateway.js';
import { TOP_K, FINAL_MAX_TOKENS, SOSL_PER_QUERY, MAX_SOSL_QUERIES, SF_API_VERSION, MAX_BODY_CHARS, BODY_FETCH_BATCH_SIZE, STORAGE_KEYS, SCORE_CONCURRENCY } from '../../shared/config.js';
import { resolveTargetPts } from '../../data/pt_routing.js';
import { extractWorkItemNames, fetchGusWorkItems } from './gus-enrichment.js';
import { fetchRelatedKnownIssues } from './ki-enrichment.js';
import { GUIDE_GENERATION, GUIDE_SCORING, GUIDE_DECISION, GUIDE_STYLE } from '../../data/writing_guide_prompts.js';

function getGuardRailExtraFields(guardRailFields) {
  const extra = [];
  if (guardRailFields?.supportLevelName) extra.push(guardRailFields.supportLevelName);
  if (guardRailFields?.hyperforceName) extra.push(guardRailFields.hyperforceName);
  return extra.length ? ',' + extra.join(',') : '';
}

export async function handleAnalyze(port, msg) {
  const abortController = new AbortController();
  const signal = abortController.signal;
  let stopped = false;

  port.onMessage.addListener((m) => {
    if (m.action === 'STOP') {
      stopped = true;
      abortController.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    stopped = true;
    abortController.abort();
  });

  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No Salesforce session. Log into OrgCS.' }); return; }

  const send = (data) => { try { port.postMessage(data); } catch {} };
  const caseId = sanitizeId(msg.caseId);

  send({ type: 'progress', step: 0, label: 'Connecting to Salesforce' });

  send({ type: 'progress', step: 1, label: 'Fetching case + comments' });

  // Guard rail field discovery first (fast, cached), then case fetch with extra fields
  const guardRailFields = await verifyGuardRailFields(session.apiBase, session.sid);
  const extraFields = getGuardRailExtraFields(guardRailFields);
  const caseFields = `Id,CaseNumber,Subject,Description,Status,Priority,CreatedDate${extraFields}`;
  const caseRecord = await sfGet(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Case/${caseId}?fields=${caseFields}`, session.sid);
  if (!caseRecord || !caseRecord.Id) { send({ type: 'error', error: 'Case not found.' }); return; }

  // Check bypass setting
  const settings = await chrome.storage.local.get([STORAGE_KEYS.BYPASS_GUARD_RAILS]);
  const bypassEnabled = settings[STORAGE_KEYS.BYPASS_GUARD_RAILS] === true;

  if (!bypassEnabled && guardRailFields.bothPresent) {
    const supportLevel = guardRailFields.supportLevelName ? (caseRecord[guardRailFields.supportLevelName] || '') : '';
    const hyperforce = guardRailFields.hyperforceName ? (caseRecord[guardRailFields.hyperforceName] || '') : '';
    caseRecord.__supportLevel = supportLevel;
    caseRecord.__hyperforce = hyperforce;
    const guardCheck = isCaseAnalysisAllowed(caseRecord);
    if (!guardCheck.allowed) {
      send({ type: 'error', error: guardCheck.reason });
      return;
    }
  }

  send({ type: 'meta', caseRecord: { id: caseRecord.Id, caseNumber: caseRecord.CaseNumber, subject: caseRecord.Subject, status: caseRecord.Status, priority: caseRecord.Priority, createdDate: caseRecord.CreatedDate, description: (caseRecord.Description || '').slice(0, 500) } });
  send({ type: 'progress', step: 1, label: 'Fetching comments…', caseNumber: caseRecord.CaseNumber });

  const comments = await sfQuery(session.apiBase, session.sid,
    `SELECT Id, CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${caseId}' ORDER BY CreatedDate ASC LIMIT 50`
  );

  const completeness = computeCompleteness(caseRecord, comments);
  send({ type: 'meta', caseCompleteness: completeness });

  const gusWorkNames = extractWorkItemNames(comments);
  const gusPromise = gusWorkNames.length ? fetchGusWorkItems(gusWorkNames) : Promise.resolve({ items: [], feed: [], error: null });

  send({ type: 'progress', step: 2, label: 'Analyzing case (parallel)' });
  const [intentsResult, caseAbstract, gusData] = await Promise.all([
    extractIntents(caseRecord, comments, signal),
    extractAbstract(caseRecord, comments, signal),
    gusPromise
  ]);

  const caseSummaryPromise = streamCaseSummary(caseRecord, comments, gusData, send, signal);
  send({ type: 'meta', gusItems: gusData.items });

  send({ type: 'progress', step: 3, label: 'Searching KB articles (SOSL)' });
  const product = caseAbstract?.product || intentsResult.product || '';
  const allQueries = intentsResult.intents.flatMap(i => i.queries);
  const ptPatterns = resolveTargetPts(product, caseRecord.Subject, caseRecord.Description);

  send({ type: 'meta', detectedPts: ptPatterns, caseAbstract: { product, symptomClass: caseAbstract?.symptomClass || '', errorSignature: caseAbstract?.errorSignature || '' } });

  const kiPromise = fetchRelatedKnownIssues(caseAbstract, ptPatterns, caseRecord.Subject).catch(() => ({ items: [], error: null }));

  const [soslResults, productDocs, kiData] = await Promise.all([
    soslPrimarySearch(session.apiBase, session.sid, allQueries, ptPatterns),
    searchProductDocs(session.apiBase, session.sid, allQueries),
    kiPromise
  ]);

  if (kiData.items?.length) {
    send({ type: 'meta', knownIssues: kiData.items });
  } else if (kiData.error) {
    send({ type: 'meta', knownIssues: [], kiError: kiData.error });
  }

  const prodDocGapPromise = (productDocs.length && !stopped)
    ? assessProductDocGap(caseRecord, caseAbstract, productDocs, signal).then(gap => { if (gap) send({ type: 'meta', prodDocGap: gap }); return gap; }).catch(() => null)
    : Promise.resolve(null);

  send({ type: 'progress', step: 4, label: `Loading ${soslResults.length} article bodies` });
  const candidates = soslResults.slice(0, 15);

  // Fetch full bodies for candidates
  const candidateBodies = await fetchCandidateBodies(session.apiBase, session.sid, candidates);

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
  const aiScoringPrompt = {
    system: `You are assessing KB article relevance to a support case. Read the FULL content of each article (Title, Summary, Description, Resolution) carefully.

Score EACH article 0-100 for relevance. Scoring criteria:
- 80-100: Article directly addresses the SAME error, symptom, or exact scenario in the case
- 60-79: Article covers the same feature/component and a closely related problem
- 40-59: Article is in the same product area but addresses a different specific issue
- 20-39: Article is tangentially related or different product area
- 0-19: Not relevant at all

Key matching signals:
- Same error message, exception code, or error pattern
- Same component/feature name mentioned in both case and article
- Same workflow or user scenario described
- Resolution in article would directly help this case

Be STRICT. Do not inflate scores. An article about the same PRODUCT but a DIFFERENT issue should score 30-50, not 60+.

Return JSON: {"articles": [{"index": 0, "score": 85, "reason": "short reason", "notRelevant": false}, ...]}
Set "notRelevant": true for articles scoring below 30. Include ALL articles.`,
    messages: [{ role: 'user', content: `CASE:\nSubject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 1200)}\nPriority: ${caseRecord.Priority || ''}\nComments: ${comments.slice(0, 5).map(c => c.CommentBody?.slice(0, 200)).filter(Boolean).join('\n')}\n\nARTICLES:\n${articleDetailsForAI}` }],
    maxTokens: 1200,
    temperature: 0.1
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await callClaudeFast({ ...aiScoringPrompt, signal });
      const parsed = extractJson(extractText(resp));
      if (parsed?.articles?.length) {
        const scored = parsed.articles
          .filter(a => a.index >= 0 && a.index < candidates.length && !a.notRelevant && a.score > 30)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        if (scored.length) {
          topArticles = scored.map(s => ({
            ...candidates[s.index],
            _relevanceScore: s.score,
            _relevanceReason: s.reason
          }));
          break;
        }
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!topArticles?.length) {
    topArticles = candidates.slice(0, TOP_K).map((a, i) => ({
      ...a,
      _relevanceScore: Math.max(40, 70 - (i * 8)),
      _relevanceReason: 'Ranked by SOSL search relevance'
    }));
  }

  const scoredArticles = topArticles.map(a => ({
    id: a.Id, title: a.Title, articleNumber: a.ArticleNumber,
    score: a._relevanceScore != null ? a._relevanceScore : null,
    reason: a._relevanceReason || '',
    topicName: a.topicName || a.Product_And_Topic__r?.Name || '',
    publishStatus: a.publishStatus || a.PublishStatus || 'Online',
    validationStatus: a.validationStatus || a.ValidationStatus || '',
    url: `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${a.Id}/view`
  }));

  send({ type: 'meta', topArticles: scoredArticles, productDocs: productDocs || [] });

  if (stopped) { send({ type: 'stopped', partial: true }); return; }

  send({ type: 'progress', step: 5, label: 'Evaluating strategy…' });
  const kbScoredArticles = [...scoredArticles];

  if (!stopped) {
    batchScoreExistingArticles(scoredArticles, candidateBodies, candidates, kbScoredArticles, send, signal);
  }

  if (stopped) { send({ type: 'stopped', partial: true }); return; }

  const decision = await makeDecision(caseRecord, caseAbstract, topArticles, signal);

  if (stopped) { send({ type: 'stopped', partial: true }); return; }

  const action = decision.action;
  let structured;

  if (action === 'NO_ACTION') {
    const coveringIndices = decision.coveringArticles || [];
    const coveringArticles = coveringIndices
      .filter(i => i >= 0 && i < topArticles.length)
      .map(i => ({ id: topArticles[i].Id, title: topArticles[i].Title, articleNumber: topArticles[i].ArticleNumber }));
    structured = {
      action: 'NO_ACTION',
      confidence: decision.confidence,
      summary: decision.reason,
      coveringArticles: coveringArticles.length ? coveringArticles : scoredArticles.slice(0, 3)
    };
  } else if (action === 'UPDATE_EXISTING' || action === 'BOTH') {
    const suggestions = await generateFullRewrites(topArticles, candidateBodies, caseRecord, comments, caseAbstract, send, signal);
    structured = {
      action,
      confidence: decision.confidence,
      summary: `${decision.reason} ${action === 'BOTH' ? 'Showing existing article suggestions and a new article draft.' : 'Updating existing articles.'}`,
      suggestions,
      topologyAssessment: topArticles.map(a => ({ id: a.Id, title: a.Title, articleNumber: a.ArticleNumber }))
    };
  }

  if (action === 'CREATE_NEW' || action === 'BOTH') {
    const draft = await generateNewArticleStreaming(caseRecord, comments, caseAbstract, intentsResult, send, signal);
    if (structured && action === 'BOTH') {
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

  await caseSummaryPromise;
  const prodDocGap = await prodDocGapPromise;

  send({ type: 'result', success: true, caseId, caseNumber: caseRecord.CaseNumber, subject: caseRecord.Subject, caseAbstract, structured, prodDocGap });

  if (!stopped) autoScoreGeneratedArticles(structured, send, signal);
}


async function extractIntents(caseRecord, comments, signal) {
  const commentsText = comments.slice(0, 10).map((c, i) => `Comment ${i + 1}: ${c.CommentBody}`).join('\n');
  const resp = await callClaudeFast({
    system: `Extract search intents from this support case. Use Agentforce KB terminology for queries — be product-specific, use exact error text and feature names.

Return JSON: {"theme":"...","product":"...","intents":[{"intent":"...","queries":["..."]}]}`,
    messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 2000)}\nComments:\n${commentsText.slice(0, 3000)}` }],
    maxTokens: 800,
    temperature: 0.1,
    signal
  });
  const parsed = extractJson(extractText(resp));
  if (!parsed?.intents) return { theme: caseRecord.Subject, product: null, intents: [{ intent: caseRecord.Subject, queries: [caseRecord.Subject] }] };
  return { theme: parsed.theme || '', product: parsed.product || null, intents: parsed.intents };
}

async function extractAbstract(caseRecord, comments, signal) {
  const commentsText = comments.slice(0, 8).map((c, i) => `Comment ${i + 1}: ${c.CommentBody}`).join('\n');
  try {
    const resp = await callClaudeFast({
      system: 'Extract a problem signature from this case. Return JSON: {"product":"...","symptomClass":"...","errorSignature":"...or null","configurationTopology":"...","audienceHint":"..."}',
      messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 1500)}\nComments:\n${commentsText.slice(0, 2000)}` }],
      maxTokens: 500,
      temperature: 0.1,
      signal
    });
    return extractJson(extractText(resp)) || null;
  } catch { return null; }
}

async function streamCaseSummary(caseRecord, comments, gusData, send, signal) {
  const commentText = comments.slice(0, 6).map(c => c.CommentBody?.slice(0, 200)).filter(Boolean).join('\n');
  const gusContext = (gusData.items || []).slice(0, 3).map(g => `${g.name}: ${g.subject || ''} (${g.status || ''})`).join('\n');
  const gusFeedText = (gusData.feed || []).slice(0, 3).map(f => f.body?.slice(0, 200)).filter(Boolean).join('\n');

  try {
    const fullText = await streamClaude({
      system: `Summarize this support case as a bulleted list (use - for bullets). Each bullet should start with a bold label like **Issue:** or **Product:** followed by the detail. Cover: the issue, the affected product/feature, current status/impact, and any related engineering work. Be concise and specific.`,
      messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nStatus: ${caseRecord.Status}\nPriority: ${caseRecord.Priority || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 1000)}\nComments:\n${commentText}${gusContext ? '\n\nRelated GUS Work Items:\n' + gusContext : ''}${gusFeedText ? '\nGUS Feed:\n' + gusFeedText : ''}` }],
      maxTokens: 400,
      temperature: 0.1,
      signal,
      onDelta: (chunk) => { send({ type: 'summary-delta', chunk }); }
    });
    send({ type: 'meta', caseSummary: fullText });
    return fullText;
  } catch { return null; }
}


async function soslPrimarySearch(apiBase, sid, queries, ptPatterns) {
  const seen = new Set();
  const results = [];
  const uniqueQueries = [...new Set(
    queries.map(q => escapeSosl(q).replace(/\s+/g, ' ').trim()).filter(q => q.length > 2 && q.split(' ').length <= 10)
  )].slice(0, MAX_SOSL_QUERIES);

  let ptFilter = "(Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%')";
  if (ptPatterns.length && ptPatterns.length <= 5) {
    const ptClauses = ptPatterns.map(p => `Product_And_Topic__r.Name = '${p.replace(/'/g, "\\'")}'`);
    ptFilter = `(${ptClauses.join(' OR ')})`;
  }

  const addRecords = (records) => {
    for (const r of records) {
      if (!seen.has(r.Id)) {
        seen.add(r.Id);
        results.push({ ...r, topicName: r.Product_And_Topic__r?.Name || '' });
      }
    }
  };

  // Run SOSL queries concurrently (3 at a time)
  await mapWithConcurrency(uniqueQueries, 3, async (q) => {
    if (results.length >= 20) return;
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${q}} IN ALL FIELDS RETURNING Knowledge__kav(Id,KnowledgeArticleId,Title,Summary,ArticleNumber,UrlName,ValidationStatus,PublishStatus,Product_And_Topic__r.Name WHERE Language = 'en_US' AND ${ptFilter}) LIMIT ${SOSL_PER_QUERY}`
      );
      addRecords(records);
    } catch {}
  });

  // Broaden if too few results
  if (results.length < 5 && ptPatterns.length) {
    await mapWithConcurrency(uniqueQueries.slice(0, 3), 3, async (q) => {
      if (results.length >= 15) return;
      try {
        const records = await sfSearch(apiBase, sid,
          `FIND {${q}} IN ALL FIELDS RETURNING Knowledge__kav(Id,KnowledgeArticleId,Title,Summary,ArticleNumber,UrlName,ValidationStatus,PublishStatus,Product_And_Topic__r.Name WHERE Language = 'en_US' AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%')) LIMIT ${SOSL_PER_QUERY}`
        );
        addRecords(records);
      } catch {}
    });
  }

  return results;
}

async function fetchCandidateBodies(apiBase, sid, candidates) {
  const bodyMap = new Map();
  if (!candidates.length) return bodyMap;
  const ids = candidates.map(c => c.Id);
  const batches = [];
  for (let i = 0; i < ids.length; i += BODY_FETCH_BATCH_SIZE) batches.push(ids.slice(i, i + BODY_FETCH_BATCH_SIZE));

  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Title, Summary, Description__c, Resolution__c, Steps__c, ArticleNumber, Product_And_Topic__r.Name FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`;
      const result = await sfGet(`${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`, sid);
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
  return bodyMap;
}

async function assessProductDocGap(caseRecord, caseAbstract, productDocs, signal) {
  if (!productDocs.length) return null;
  const docsText = productDocs.slice(0, 5).map((d, i) => `${i+1}. "${d.title}" — ${(d.summary || '').slice(0, 100)}`).join('\n');
  try {
    const resp = await callClaudeFast({
      system: `You assess whether existing product documentation adequately covers a support case scenario.

IMPORTANT: Be CONSERVATIVE. Default to DOCS_SUFFICIENT unless there is a clear, systemic documentation gap.
- Most support cases involve customer-specific configurations, edge cases, or misunderstandings that product docs CANNOT reasonably cover. These are NOT documentation gaps.
- Only recommend DOCS_NEED_UPDATE when the case reveals a common, repeatable scenario that MANY customers would encounter and the docs clearly fail to address.
- Only recommend DOCS_MISSING when an entire product feature or workflow has ZERO documentation.
- Bugs, data issues, org-specific configs, and one-off errors are NOT documentation gaps.

Return JSON: {"hasGap": true/false, "assessment": "1-2 sentences", "recommendation": "DOCS_SUFFICIENT"|"DOCS_NEED_UPDATE"|"DOCS_MISSING", "relatedDocs": [indices of relevant docs]}`,
      messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${caseAbstract?.product || ''}\nSymptom: ${caseAbstract?.symptomClass || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 600)}\n\nProduct Documentation found:\n${docsText}` }],
      maxTokens: 200,
      temperature: 0.1,
      signal
    });
    return extractJson(extractText(resp)) || null;
  } catch { return null; }
}

async function searchProductDocs(apiBase, sid, queries) {
  const uniqueQueries = [...new Set(
    queries.map(q => escapeSosl(q).replace(/\s+/g, ' ').trim()).filter(q => q.length > 2)
  )].slice(0, 3);
  const seen = new Set();
  const results = [];

  await mapWithConcurrency(uniqueQueries, 3, async (q) => {
    if (results.length >= 5) return;
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${q}} IN ALL FIELDS RETURNING Knowledge__kav(Id,Title,Summary,UrlName,ArticleNumber WHERE RecordType.DeveloperName = 'Product_Documentation' AND PublishStatus = 'Online' AND Language = 'en_US') LIMIT 3`
      );
      for (const r of records) {
        if (!seen.has(r.Id)) {
          seen.add(r.Id);
          results.push({
            id: r.Id,
            title: r.Title,
            summary: r.Summary || '',
            articleNumber: r.ArticleNumber,
            url: `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${r.Id}/view`
          });
        }
      }
    } catch {}
  });
  return results.slice(0, 5);
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

async function scoreArticleForCaseScan(article, signal) {
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

${GUIDE_SCORING}

Score this article. Dynamic max points per criterion are provided. TOTAL MUST EQUAL 100.
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : ''}
SCORING: Be STRICT. Most articles score 55-75.
CRITERIA: title(max ${m.title}), summary(max ${m.summary}), headers(max ${m.headers}), content(max ${m.content}), scannability(max ${m.scannability}), media(max ${m.media}), code(max ${m.code}), tables(max ${m.tables}), links(max ${m.links}), taxonomy(max ${m.taxonomy}).
Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"...","score":<n>,"passed":["..."],"issues":["..."],"suggestions":["..."]},...]}`,
    messages: [{ role: 'user', content: `Title: ${article.title}\nArticle#: ${article.articleNumber}\nP&T: ${article.topicName || '(none)'}\nSUMMARY: ${article.summary || '(empty)'}\nDESCRIPTION (${descText.length} chars): ${descText || '(empty)'}\nRESOLUTION (${resText.length} chars): ${resText || '(empty)'}${stepsText ? '\nSTEPS: ' + stepsText : ''}` }],
    maxTokens: 2200,
    temperature: 0.1,
    model: 'claude-sonnet-4-6',
    signal
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

async function generateFullRewrites(articles, bodyMap, caseRecord, comments, abstract, send, signal) {
  const allSuggestions = [];
  const commentSnippets = comments.filter(c => c.CommentBody?.length > 30).slice(0, 3).map(c => c.CommentBody.slice(0, 300)).join('\n---\n');

  const tasks = articles.slice(0, 2).map(article => async () => {
    const body = bodyMap.get(article.Id) || {};
    const descText = stripHtml(body.description).slice(0, MAX_BODY_CHARS);
    const resText = stripHtml(body.resolution).slice(0, MAX_BODY_CHARS);
    const stepsText = stripHtml(body.steps || '').slice(0, 1500);

    try {
      const fullText = await streamClaude({
        system: `You are an expert KB editor. Given an existing article and a support case, produce a FULL REWRITTEN version of the article that incorporates learnings from the case.

AGENTFORCE WRITING GUIDE (follow strictly):
${GUIDE_GENERATION}

${GUIDE_STYLE}

KEY RULES:
- Title: product-specific, describes exact issue
- Summary: 2-4 sentences covering problem context and resolution approach
- Use H2/H3 headers for structure (used in chunking for Agentforce)
- Description: state problem, symptoms, context, and WHY
- Resolution: brief summary of what steps accomplish, then numbered steps
- Explain acronyms. Use present tense. Be specific about product + feature.
- After code blocks, add plain-text explanation
- Tables should use text, not visual indicators

Return the COMPLETE rewritten article as publication-ready content.
IMPORTANT: Use EXACTLY these 4 sections — Title, Summary, Description, Resolution. No other section headings.
JSON: {"title":"...","summary":"...","sections":[{"heading":"Description","body":"..."},{"heading":"Resolution","body":"..."}],"changesSummary":"brief description of what was changed and why"}`,
        messages: [{ role: 'user', content: `EXISTING ARTICLE: #${article.ArticleNumber} "${article.Title}"\nSUMMARY: ${body.summary || ''}\nDESCRIPTION:\n${descText.slice(0, 2500)}\nRESOLUTION:\n${resText.slice(0, 2500)}${stepsText ? '\nSTEPS:\n' + stepsText : ''}\n\nCASE CONTEXT:\nSubject: ${caseRecord.Subject}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 800)}\n${commentSnippets ? 'Comments:\n' + commentSnippets : ''}` }],
        maxTokens: 3000,
        temperature: 0.2,
        signal,
        onDelta: (chunk) => {
          send({ type: 'suggestion-delta', articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title, chunk });
        }
      });
      const parsed = extractJson(fullText);
      if (parsed) {
        const rewrite = {
          ...parsed,
          articleId: article.Id,
          articleNumber: article.ArticleNumber,
          articleTitle: article.Title,
          isFullRewrite: true
        };
        allSuggestions.push(rewrite);
        send({ type: 'suggestion-ready', articleId: article.Id, articleNumber: article.ArticleNumber, articleTitle: article.Title, suggestions: [rewrite] });
      }
    } catch (e) {
      send({ type: 'suggestion-error', articleId: article.Id, articleNumber: article.ArticleNumber, error: e?.message || 'Failed' });
    }
  });

  await Promise.all(tasks.map(fn => fn()));
  return allSuggestions;
}

async function makeDecision(caseRecord, abstract, topArticles, signal) {
  if (!topArticles.length) return { action: 'CREATE_NEW', confidence: 'HIGH', reason: 'No existing articles found.' };
  const articleList = topArticles.slice(0, 5).map((a, i) => `${i+1}. #${a.ArticleNumber} "${a.Title}" (relevance: ${a._relevanceScore || 'N/A'}) — ${(a.Summary || '').slice(0, 150)}`).join('\n');
  const resp = await callClaudeFast({
    system: `You decide the KB action for a support case given existing related articles.

${GUIDE_DECISION}

Choose ONE action:

NO_ACTION — Choose when:
- An existing article ALREADY fully covers the case's exact error, symptom, or scenario
- The resolution in the existing article would directly solve this case without any modification
- Only trivial cosmetic changes would improve the article (punctuation, minor wording)
- The case describes a well-known issue that is completely documented

UPDATE_EXISTING — Choose when:
- Articles cover the same product/feature area but miss this specific error or scenario
- The article could be meaningfully improved by adding resolution steps, error details, or context from this case
- Prefer this over CREATE_NEW when an article exists in the same domain

CREATE_NEW — Choose when:
- ZERO articles relate to the same product feature area or specific issue category
- This should be rare when relevant articles exist

BOTH — Choose when:
- Existing articles should be updated AND a distinctly different aspect needs a new article

Return JSON: {"action":"NO_ACTION"|"UPDATE_EXISTING"|"CREATE_NEW"|"BOTH","confidence":"HIGH"|"MEDIUM"|"LOW","reason":"one sentence explaining the decision","coveringArticles":[indices of articles that already cover this case, if NO_ACTION]}`,
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 1200)}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\n\nExisting articles (scored for relevance to this case):\n${articleList}` }],
    maxTokens: 250,
    temperature: 0.1,
    signal
  });
  const parsed = extractJson(extractText(resp));
  return parsed || { action: 'UPDATE_EXISTING', confidence: 'LOW', reason: 'Defaulting to update.' };
}

async function generateNewArticleStreaming(caseRecord, comments, abstract, intents, send, signal) {
  const commentText = comments.slice(0, 5).map(c => c.CommentBody?.slice(0, 400)).filter(Boolean).join('\n---\n');
  const fullText = await streamClaude({
    system: `You are drafting a new Salesforce KB article optimized for Agentforce consumption.

AGENTFORCE WRITING GUIDE (follow strictly):
${GUIDE_GENERATION}

${GUIDE_STYLE}

KEY RULES:
- TITLE: Must be specific to the product + exact issue. Include product name, error text, or scenario.
- SUMMARY: 2-4 sentences covering problem context and resolution approach.
- HEADERS: Use H2/H3 headers to break content into logical sections. Headers are used in chunking for Agentforce.
- DESCRIPTION: State the problem, symptoms, and context. Explain WHY this happens. Include product name with feature terms.
- RESOLUTION: Begin with a brief statement of what the steps accomplish, then provide numbered steps.
- Explain acronyms and abbreviations. Use simple present tense.
- Code blocks should be described succinctly in text.
- Tables should use text, not visual indicators.

ALSO: Identify any claims or assertions where you are NOT fully confident (e.g., inferred root cause, assumed configuration, unclear error conditions). These become "hypotheses" that need SME validation.

IMPORTANT: Use EXACTLY these 4 fields — title, summary, and two sections: Description and Resolution. No other section headings.
Return JSON: {"title":"...","summary":"...","sections":[{"heading":"Description","body":"..."},{"heading":"Resolution","body":"..."}],"hypotheses":[{"claim":"...","confidence":0.0-1.0,"source":"where this was inferred from","affectedSections":["Description"|"Resolution"]}]}`,
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${abstract?.product || intents.product || ''}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || ''}\nTopology: ${abstract?.configurationTopology || ''}\nDescription: ${(caseRecord.Description || '').slice(0, 1500)}\nComments:\n${commentText}` }],
    maxTokens: FINAL_MAX_TOKENS,
    temperature: 0.2,
    signal,
    onDelta: (chunk) => { send({ type: 'delta', chunk }); }
  });
  const parsed = extractJson(fullText) || { title: caseRecord.Subject, sections: [{ heading: 'Description', body: caseRecord.Description || '' }] };
  if (parsed.hypotheses?.length) {
    send({ type: 'meta', hypotheses: parsed.hypotheses.map((h, i) => ({ ...h, id: `h${i}`, status: 'pending' })) });
  }
  return parsed;
}

function computeCompleteness(caseRecord, comments) {
  let score = 0;
  const details = [];
  const desc = caseRecord.Description || '';
  const commentTexts = comments.map(c => c.CommentBody || '').filter(Boolean);

  if (desc.length > 200) { score += 15; details.push('detailed-description'); }
  else if (desc.length > 50) { score += 8; details.push('basic-description'); }

  if (commentTexts.length >= 3) { score += 15; details.push('multiple-comments'); }
  else if (commentTexts.length >= 1) { score += 8; details.push('has-comments'); }

  if (/\b(error|exception|stacktrace|FATAL|NullPointer|timeout|500|403|404)\b/i.test(desc)) { score += 15; details.push('error-signature'); }
  else if (/\b(fail|unable|cannot|does not work|broken)\b/i.test(desc)) { score += 8; details.push('symptom-keywords'); }

  const hasSteps = /\b(steps to reproduce|repro|STR|how to reproduce)\b/i.test(desc + commentTexts.join(' '));
  if (hasSteps) { score += 15; details.push('repro-steps'); }

  const hasConfig = /\b(org id|instance|version|release|sandbox|production|config)\b/i.test(desc + commentTexts.join(' '));
  if (hasConfig) { score += 10; details.push('environment-context'); }

  if (commentTexts.some(c => /W-\d{4,}/.test(c))) { score += 10; details.push('gus-refs'); }

  const hasResolution = commentTexts.some(c => /\b(workaround|fix|resolved|solution|root cause)\b/i.test(c));
  if (hasResolution) { score += 20; details.push('resolution-context'); }

  const label = score >= 65 ? 'Sufficient' : score >= 35 ? 'Partial' : 'Insufficient';
  return { score: Math.min(100, score), label, details };
}

async function batchScoreExistingArticles(scoredArticles, candidateBodies, candidates, kbScoredArticles, send, signal) {
  if (!scoredArticles.length) return;
  const articlesForScoring = scoredArticles.map((sa, idx) => {
    const body = candidateBodies.get(sa.id) || {};
    const candidate = candidates.find(c => c.Id === sa.id) || {};
    return {
      idx,
      title: sa.title || body.title || candidate.Title || '',
      summary: body.summary || candidate.Summary || '',
      description: stripHtml(body.description || '').slice(0, 2000),
      resolution: stripHtml(body.resolution || '').slice(0, 2000),
      articleNumber: sa.articleNumber || '',
      topicName: body.topicName || candidate.topicName || ''
    };
  });

  const articlesText = articlesForScoring.map((a, i) =>
    `[${i}] #${a.articleNumber} "${a.title}"\nSummary: ${(a.summary || '').slice(0, 200)}\nDescription: ${a.description.slice(0, 800)}\nResolution: ${a.resolution.slice(0, 800)}`
  ).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce readiness.

${GUIDE_SCORING}

Score EACH article 0-100 for overall KB quality. Be STRICT. Most articles score 55-75.
Consider: title specificity, summary quality, header structure, content completeness, scannability, taxonomy context.

Return JSON: {"scores": [{"index": 0, "overall": 72}, {"index": 1, "overall": 65}, ...]}
Include ALL articles.`,
      messages: [{ role: 'user', content: `Score these ${articlesForScoring.length} articles:\n\n${articlesText}` }],
      maxTokens: 400,
      temperature: 0.1,
      signal
    });
    const parsed = extractJson(extractText(resp));
    if (parsed?.scores?.length) {
      for (const s of parsed.scores) {
        if (s.index >= 0 && s.index < scoredArticles.length && s.overall != null) {
          kbScoredArticles[s.index] = { ...scoredArticles[s.index], kbScore: Math.round(s.overall) };
        }
      }
      send({ type: 'meta', topArticles: [...kbScoredArticles] });
    }
  } catch {}
}

async function autoScoreGeneratedArticles(structured, send, signal) {
  if (!structured) return;
  const draftsToScore = [];

  if (structured.newArticleDraft) {
    draftsToScore.push({ key: 'new-draft', article: structured.newArticleDraft });
  }
  if (structured.suggestions?.length) {
    for (const sug of structured.suggestions) {
      if (sug.isFullRewrite) {
        draftsToScore.push({ key: `rewrite-${sug.articleId}`, article: sug });
      }
    }
  }

  if (!draftsToScore.length) return;
  if (signal?.aborted) return;

  const articlesText = draftsToScore.map((d, i) => {
    const allSections = d.article.sections || [];
    const desc = allSections.find(s => /description/i.test(s.heading))?.body || allSections[0]?.body || '';
    const res = allSections.find(s => /resolution/i.test(s.heading))?.body || allSections[1]?.body || '';
    return `[${i}] "${d.article.title || d.article.articleTitle || ''}"\nSummary: ${(d.article.summary || '').slice(0, 200)}\nDescription: ${desc.slice(0, 1000)}\nResolution: ${res.slice(0, 1000)}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce readiness.

${GUIDE_SCORING}

Score EACH article 0-100 for overall KB quality. Be STRICT. Most articles score 55-75. These are AI-generated drafts so they should score higher than average (70-90) if well-structured.
Consider: title specificity, summary quality, header structure, content completeness, scannability, taxonomy context.

Return JSON: {"scores": [{"index": 0, "overall": 82, "criteria": [{"id": "title", "score": 10, "max": 12}, {"id": "summary", "score": 8, "max": 10}, {"id": "headers", "score": 9, "max": 10}, {"id": "content", "score": 16, "max": 18}, {"id": "scannability", "score": 9, "max": 10}, {"id": "taxonomy", "score": 7, "max": 8}]}, ...]}
Include ALL articles. Only include active criteria (skip media/code/tables if not applicable).`,
      messages: [{ role: 'user', content: `Score these ${draftsToScore.length} generated article drafts:\n\n${articlesText}` }],
      maxTokens: 800,
      temperature: 0.1,
      signal
    });
    const parsed = extractJson(extractText(resp));
    if (parsed?.scores?.length) {
      for (const s of parsed.scores) {
        if (s.index >= 0 && s.index < draftsToScore.length && s.overall != null) {
          const d = draftsToScore[s.index];
          send({ type: 'meta', draftScore: { key: d.key, score: { overall: Math.round(s.overall), criteria: s.criteria || [] } } });
        }
      }
    }
  } catch {}
}
