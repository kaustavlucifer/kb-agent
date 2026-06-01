import { h, spinner, emptyState, toast, progressBar, chip } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession, findSid, isCaseAnalysisAllowed } from '../shared/auth.js';
import { sfGet, sfQuery, sfQueryAll, sfSearch, soqlIdList, sanitizeId, escapeSoql, mapWithConcurrency, stripHtml } from '../shared/api.js';
import { streamClaude, callClaude, callClaudeFast, extractText, extractJson, callWithRetry } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { TOP_K, FINAL_MAX_TOKENS, SOSL_PER_QUERY, MAX_SOSL_QUERIES, SF_API_VERSION, MAX_BODY_CHARS, BODY_FETCH_BATCH_SIZE, STREAM_RENDER_THROTTLE_MS } from '../shared/config.js';

let _container = null;
let _port = null;
let _unsubs = [];

export function mount(container) {
  _container = container;
  if (!getState('case.view')) setState('case.view', 'idle');
  loadRecentCases();
  renderByView();
  _unsubs.push(subscribe('case.view', renderByView));
  _unsubs.push(subscribe('case.progress', () => { if (getState('case.view') === 'analyzing') renderByView(); }));
  _unsubs.push(subscribe('case.result', () => { if (getState('case.view') === 'result') renderByView(); }));

  const pending = getState('case.pendingUrl');
  if (pending) {
    setState('case.pendingUrl', null);
    const id = extractCaseId(pending);
    if (id) startAnalysis(id);
  }
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  _container = null;
}

async function loadRecentCases() {
  const data = await localGet(['recentCases']);
  if (data.recentCases) setState('case.recent', data.recentCases);
}

function extractCaseId(url) {
  const m = url.match(/\/Case\/([a-zA-Z0-9]{15,18})/i)
    || url.match(/\/([a-zA-Z0-9]{15,18})\/view/i)
    || url.match(/caseId=([a-zA-Z0-9]{15,18})/i);
  return m ? m[1] : null;
}

function renderByView() {
  const view = getState('case.view');
  if (view === 'idle') renderIdle();
  else if (view === 'analyzing') renderAnalyzing();
  else if (view === 'result') renderResult();
}

function renderIdle() {
  if (!_container) return;
  _container.textContent = '';

  const searchBar = h('div', { class: 'card', style: { padding: '12px' } },
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('input', { type: 'text', class: 'input', id: 'case-input', placeholder: 'Case number, ID, or URL…', autocomplete: 'off' }),
      h('button', { class: 'btn btn--primary', onClick: handleAnalyze, id: 'analyze-btn' }, 'Analyze')
    )
  );
  _container.appendChild(searchBar);
  document.getElementById('case-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleAnalyze(); });

  const recent = getState('case.recent') || [];
  if (recent.length) {
    const recentCard = h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' } }, 'Recent Cases')
    );
    recent.slice(0, 8).forEach(c => {
      const row = h('div', { style: { display: 'flex', gap: '10px', padding: '6px 8px', cursor: 'pointer', borderRadius: 'var(--radius-xs)', transition: 'background 0.1s' }, onClick: () => startAnalysis(c.id) },
        h('span', { style: { fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--primary)', fontWeight: '500', flexShrink: '0' } }, c.number || c.id.slice(0, 8)),
        h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1' } }, c.subject || '')
      );
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--primary-soft)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      recentCard.appendChild(row);
    });
    _container.appendChild(recentCard);
  }

  _container.appendChild(h('div', { style: { marginTop: '24px' } },
    emptyState('🔍', 'Enter a Case number and click Analyze to get AI-powered KB recommendations.')
  ));
}

function renderAnalyzing() {
  if (!_container) return;
  _container.textContent = '';
  const progress = getState('case.progress') || { step: 0, label: 'Starting…' };
  const steps = ['Connecting', 'Fetching case + comments', 'Extracting intents', 'Searching knowledge base', 'Ranking + loading articles', 'Generating recommendation'];
  const pct = Math.max(5, Math.round(((progress.step + 1) / steps.length) * 100));

  const card = h('div', { class: 'card' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '12px' } },
      h('span', { style: { fontWeight: '600', fontSize: '14px' } }, progress.caseNumber ? `Analyzing Case #${progress.caseNumber}` : 'Analyzing…'),
      h('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, `${progress.step + 1} / ${steps.length}`)
    ),
    progressBar(pct, 'default'),
    h('div', { style: { marginTop: '16px' } },
      ...steps.map((s, i) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px', color: i < progress.step ? 'var(--success)' : i === progress.step ? 'var(--primary)' : 'var(--text-muted)' } },
        i < progress.step ? h('span', null, '✓')
          : i === progress.step ? spinner('sm')
          : h('span', null, '○'),
        h('span', null, i === progress.step ? (progress.label || s) : s)
      ))
    )
  );
  _container.appendChild(card);
}

function renderResult() {
  if (!_container) return;
  _container.textContent = '';
  const result = getState('case.result');
  if (!result) return;

  const structured = result.structured || result;
  const isCreate = structured.action === 'CREATE_NEW';

  const headerCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' } },
      h('div', null,
        h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `Case #${result.caseNumber || ''}`),
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginTop: '2px' } }, result.subject || '')
      ),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('span', { class: `pill pill--${isCreate ? 'info' : 'neutral'}` }, isCreate ? 'Create New' : 'Update Existing'),
        structured.confidence ? h('span', { class: `pill pill--${structured.confidence === 'HIGH' ? 'success' : structured.confidence === 'MEDIUM' ? 'warning' : 'error'}` }, structured.confidence) : null
      )
    ),
    structured.summary ? h('p', { style: { fontSize: '13px', lineHeight: '1.5', color: 'var(--text-secondary)' } }, structured.summary) : null,
    result.caseAbstract ? renderAbstractChips(result.caseAbstract) : null
  );
  _container.appendChild(headerCard);

  if (structured.suggestions?.length) {
    const sugCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' } }, `Suggestions (${structured.suggestions.length})`),
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyAll(structured.suggestions) }, 'Copy All')
      )
    );
    structured.suggestions.forEach((sug, i) => {
      sugCard.appendChild(h('div', { style: { padding: '10px 0', borderBottom: i < structured.suggestions.length - 1 ? '1px solid var(--border)' : 'none' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
          h('span', { class: `pill pill--${impactColor(sug.impact)}` }, sug.impact || 'MEDIUM'),
          h('span', { style: { fontWeight: '500', fontSize: '13px' } }, sug.title || `Suggestion ${i + 1}`)
        ),
        sug.location ? h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } }, `Location: ${sug.location}`) : null,
        sug.content ? h('div', { style: { fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: '1.5', background: 'var(--surface-raised)', padding: '8px', borderRadius: 'var(--radius-xs)' } }, sug.content) : null
      ));
    });
    _container.appendChild(sugCard);
  }

  if (structured.newArticleDraft) {
    const draft = structured.newArticleDraft;
    const draftCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' } }, 'New Article Draft'),
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyDraft(draft) }, 'Copy Draft')
      )
    );
    if (draft.title) draftCard.appendChild(h('div', { style: { fontSize: '14px', fontWeight: '600', marginBottom: '12px' } }, draft.title));
    (draft.sections || []).forEach(sec => {
      draftCard.appendChild(h('div', { style: { marginBottom: '12px' } },
        h('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, sec.heading || 'Section'),
        h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '1.5' } }, sec.body || '')
      ));
    });
    _container.appendChild(draftCard);
  }

  _container.appendChild(h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '16px' } },
    h('button', { class: 'btn btn--secondary btn--sm', onClick: () => { setState('case.view', 'idle'); setState('case.result', null); } }, 'New Analysis')
  ));
}

function renderAbstractChips(abs) {
  const items = [
    abs.product && ['Product', abs.product],
    abs.symptomClass && ['Symptom', abs.symptomClass],
    abs.errorSignature && ['Error', abs.errorSignature]
  ].filter(Boolean);
  if (!items.length) return null;
  return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } },
    ...items.map(([label, val]) => h('span', { class: 'pill pill--neutral', title: label, style: { fontSize: '11px' } }, val))
  );
}

function impactColor(impact) {
  switch ((impact || '').toUpperCase()) {
    case 'HIGH': case 'CRITICAL': return 'error';
    case 'MEDIUM': return 'warning';
    case 'LOW': return 'info';
    default: return 'neutral';
  }
}

function copyAll(suggestions) {
  const text = suggestions.map(s => `## ${s.title}\nLocation: ${s.location || 'N/A'}\n\n${s.content || ''}`).join('\n\n---\n\n');
  navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'));
}

function copyDraft(draft) {
  const text = `# ${draft.title || 'New Article'}\n\n` + (draft.sections || []).map(s => `## ${s.heading}\n${s.body}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'));
}

async function handleAnalyze() {
  const input = document.getElementById('case-input');
  const value = (input?.value || '').trim();
  if (!value) { toast('Enter a Case number or ID.', 'error'); return; }

  let caseId = extractCaseId(value);
  if (!caseId) {
    if (/^[a-zA-Z0-9]{15,18}$/.test(value)) caseId = value;
    else if (/^\d{3,15}$/.test(value)) {
      const resp = await chrome.runtime.sendMessage({ action: 'RESOLVE_CASE_NUMBER', caseNumber: value });
      if (resp.success) caseId = resp.caseId;
      else { toast('Case not found: ' + value, 'error'); return; }
    } else { toast('Invalid Case number or ID.', 'error'); return; }
  }
  startAnalysis(caseId);
}

function startAnalysis(caseId) {
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  setState('case.view', 'analyzing');
  setState('case.progress', { step: 0, label: 'Connecting…' });
  setState('case.result', null);

  _port = chrome.runtime.connect({ name: 'kba-analyze' });
  _port.postMessage({ action: 'ANALYZE_CASE', caseId });
  _port.onMessage.addListener(onPortMessage);
  _port.onDisconnect.addListener(() => { _port = null; });
}

function onPortMessage(msg) {
  switch (msg.type) {
    case 'progress':
      setState('case.progress', { ...getState('case.progress'), step: msg.step ?? 0, label: msg.label || '', caseNumber: msg.caseNumber || getState('case.progress')?.caseNumber });
      break;
    case 'result':
      if (msg.success === false) {
        toast(msg.error || 'Analysis failed.', 'error');
        setState('case.view', 'idle');
      } else {
        setState('case.result', msg);
        setState('case.view', 'result');
        saveRecentCase(msg);
      }
      break;
    case 'error':
      toast(msg.error || 'Analysis failed.', 'error');
      setState('case.view', 'idle');
      break;
  }
}

async function saveRecentCase(result) {
  const data = await localGet(['recentCases']);
  const recent = (data.recentCases || []).filter(c => c.id !== result.caseId);
  recent.unshift({ id: result.caseId, number: result.caseNumber, subject: result.subject, ts: Date.now() });
  const trimmed = recent.slice(0, 10);
  await localSet({ recentCases: trimmed });
  setState('case.recent', trimmed);
}

export async function handleAnalyze(port, msg) {
  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No Salesforce session. Log into OrgCS.' }); return; }

  const send = (data) => { try { port.postMessage(data); } catch {} };
  const caseId = sanitizeId(msg.caseId);

  send({ type: 'progress', step: 0, label: 'Connecting to Salesforce' });

  send({ type: 'progress', step: 1, label: 'Fetching case + comments' });
  const caseRecords = await sfQuery(session.apiBase, session.sid,
    `SELECT Id, CaseNumber, Subject, Description, Topic__c, Product_Tag__c, Status, Priority FROM Case WHERE Id = '${caseId}' LIMIT 1`
  );
  if (!caseRecords.length) { send({ type: 'error', error: 'Case not found.' }); return; }
  const caseRecord = caseRecords[0];
  send({ type: 'progress', step: 1, label: 'Fetching comments…', caseNumber: caseRecord.CaseNumber });

  const comments = await sfQuery(session.apiBase, session.sid,
    `SELECT CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${caseId}' ORDER BY CreatedDate DESC LIMIT 30`
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

async function extractIntents(caseRecord, comments) {
  const commentsText = comments.slice(0, 10).map((c, i) => `Comment ${i + 1}: ${c.CommentBody}`).join('\n');
  const resp = await callClaudeFast({
    system: 'Extract search intents from this support case. Return JSON: {"theme":"...","product":"...","intents":[{"intent":"...","queries":["..."]}]}',
    messages: [{ role: 'user', content: `Subject: ${caseRecord.Subject}\nDescription: ${(caseRecord.Description || '').slice(0, 2000)}\nComments:\n${commentsText.slice(0, 3000)}` }],
    maxTokens: 800,
    temperature: 0.1
  });
  const parsed = extractJson(extractText(resp));
  if (!parsed?.intents) return { theme: caseRecord.Subject, product: caseRecord.Product_Tag__c, intents: [{ intent: caseRecord.Subject, queries: [caseRecord.Subject] }] };
  return { theme: parsed.theme || '', product: parsed.product || caseRecord.Product_Tag__c, intents: parsed.intents };
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
    messages: [{ role: 'user', content: `Case: ${caseRecord.Subject}\nProduct: ${abstract?.product || caseRecord.Product_Tag__c || ''}\nSymptom: ${abstract?.symptomClass || ''}\nError: ${abstract?.errorSignature || 'none'}\nDescription: ${(caseRecord.Description || '').slice(0, 600)}\n\nExisting articles:\n${articleList}` }],
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

export { handleAnalyze as handleThemeVolume };
export { handleAnalyze as handleBroaden };
