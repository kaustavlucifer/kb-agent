import { h, spinner, emptyState, toast, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession, findSid, isCaseAnalysisAllowed, verifyGuardRailFields } from '../shared/auth.js';
import { sfQuery, sfSearch, sanitizeId, escapeSoql, mapWithConcurrency } from '../shared/api.js';
import { streamClaude, callClaude, callClaudeFast, extractText, extractJson, callWithRetry } from '../shared/gateway.js';
import { localGet } from '../shared/storage.js';
import { TOP_K, FINAL_MAX_TOKENS, SOSL_PER_QUERY, MAX_SOSL_QUERIES, SF_API_VERSION, BROADEN_CYCLE_CAP, STREAM_RENDER_THROTTLE_MS } from '../shared/config.js';

let _container = null;
let _port = null;
let _unsubs = [];

export function mount(container) {
  _container = container;
  setState('case.view', 'idle');
  renderIdle();

  _unsubs.push(subscribe('case.view', (view) => {
    if (view === 'idle') renderIdle();
    else if (view === 'analyzing') renderAnalyzing();
    else if (view === 'result') renderResult();
  }));

  const pending = getState('case.pendingUrl');
  if (pending) {
    setState('case.pendingUrl', null);
    const caseId = extractCaseId(pending);
    if (caseId) startAnalysis(caseId);
  }
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  _container = null;
}

function extractCaseId(url) {
  const match = url.match(/\/Case\/([a-zA-Z0-9]{15,18})/i)
    || url.match(/\/([a-zA-Z0-9]{15,18})\/view/i)
    || url.match(/caseId=([a-zA-Z0-9]{15,18})/i);
  return match ? match[1] : null;
}

function renderIdle() {
  if (!_container) return;
  _container.textContent = '';

  const card = h('div', { class: 'card' },
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      h('input', { type: 'text', class: 'input', id: 'case-input', placeholder: 'Case number or ID…', autocomplete: 'off' }),
      h('button', { class: 'btn btn--primary', onClick: handleAnalyze }, 'Analyze')
    )
  );
  _container.appendChild(card);

  const caseInput = document.getElementById('case-input');
  caseInput?.addEventListener('keydown', e => { if (e.key === 'Enter') handleAnalyze(); });

  const recentCases = getState('case.recent') || [];
  if (recentCases.length) {
    const recentCard = h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' } }, 'Recent Cases')
    );
    recentCases.slice(0, 5).forEach(c => {
      const row = h('div', { style: { display: 'flex', gap: '8px', padding: '6px 8px', cursor: 'pointer', borderRadius: '4px' }, onClick: () => { document.getElementById('case-input').value = c.number || c.id; startAnalysis(c.id); } },
        h('span', { style: { fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--primary)' } }, c.number || c.id),
        h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1' } }, c.subject || '')
      );
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--primary-soft)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      recentCard.appendChild(row);
    });
    _container.appendChild(recentCard);
  }

  _container.appendChild(emptyState('🔍', 'Enter a Case number and click Analyze to get AI-powered KB recommendations.'));
}

function renderAnalyzing() {
  if (!_container) return;
  _container.textContent = '';
  const progress = getState('case.progress') || { step: 0, label: 'Starting…' };
  const steps = ['Connecting', 'Fetching case', 'Extracting intents', 'Searching KB', 'Ranking articles', 'Generating recommendation'];
  const pct = Math.round(((progress.step + 1) / steps.length) * 100);

  const card = h('div', { class: 'card' },
    h('div', { style: { fontWeight: '600', marginBottom: '12px' } }, 'Analyzing Case…'),
    progressBar(pct, 'default'),
    h('div', { style: { marginTop: '16px' } },
      ...steps.map((s, i) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px', color: i < progress.step ? 'var(--success)' : i === progress.step ? 'var(--primary)' : 'var(--text-muted)' } },
        i < progress.step ? h('span', null, '✓')
          : i === progress.step ? spinner('sm')
          : h('span', { style: { color: 'var(--text-muted)' } }, '○'),
        h('span', null, i === progress.step ? (progress.label || s) : s)
      ))
    )
  );
  _container.appendChild(card);

  _unsubs.push(subscribe('case.progress', () => renderAnalyzing()));
}

function renderResult() {
  if (!_container) return;
  _container.textContent = '';
  const result = getState('case.result');
  if (!result) return;

  const structured = result.structured || result;

  if (structured.summary) {
    _container.appendChild(h('div', { class: 'card' },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' } }, 'Summary'),
      h('p', { style: { fontSize: '13px', lineHeight: '1.5' } }, structured.summary)
    ));
  }

  if (structured.suggestions?.length) {
    const sugCard = h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' } }, `Suggestions (${structured.suggestions.length})`)
    );
    structured.suggestions.forEach(sug => {
      sugCard.appendChild(h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span', { class: `pill pill--${impactColor(sug.impact)}` }, sug.impact || 'MEDIUM'),
          h('span', { style: { fontWeight: '500', fontSize: '13px' } }, sug.title || 'Suggestion')
        ),
        sug.content ? h('div', { style: { marginTop: '4px', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' } }, sug.content) : null
      ));
    });
    _container.appendChild(sugCard);
  }

  if (structured.newArticleDraft?.sections?.length) {
    const draftCard = h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' } }, 'New Article Draft')
    );
    structured.newArticleDraft.sections.forEach(sec => {
      draftCard.appendChild(h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { fontWeight: '500', fontSize: '13px' } }, sec.heading || 'Section'),
        h('div', { style: { marginTop: '4px', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' } }, sec.body || '')
      ));
    });
    _container.appendChild(draftCard);
  }
}

function impactColor(impact) {
  switch ((impact || '').toUpperCase()) {
    case 'HIGH': case 'CRITICAL': return 'error';
    case 'MEDIUM': return 'warning';
    case 'LOW': return 'info';
    default: return 'neutral';
  }
}

async function handleAnalyze() {
  const input = document.getElementById('case-input');
  const value = (input?.value || '').trim();
  if (!value) { toast('Enter a Case number or ID.', 'error'); return; }

  let caseId = extractCaseId(value);
  if (!caseId) {
    if (/^[a-zA-Z0-9]{15,18}$/.test(value)) {
      caseId = value;
    } else if (/^\d{3,15}$/.test(value)) {
      const resp = await chrome.runtime.sendMessage({ action: 'RESOLVE_CASE_NUMBER', caseNumber: value });
      if (resp.success) caseId = resp.caseId;
      else { toast('Case not found: ' + value, 'error'); return; }
    } else {
      toast('Invalid Case number or ID.', 'error');
      return;
    }
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
  _port.onMessage.addListener(msg => onPortMessage(msg));
  _port.onDisconnect.addListener(() => { _port = null; });
}

function onPortMessage(msg) {
  switch (msg.type) {
    case 'progress':
      setState('case.progress', { step: msg.step || 0, label: msg.label || '' });
      break;
    case 'delta':
      break;
    case 'result':
      if (msg.success === false) {
        toast(msg.error || 'Analysis failed', 'error');
        setState('case.view', 'idle');
      } else {
        setState('case.result', msg);
        setState('case.view', 'result');
        saveRecentCase(msg);
      }
      break;
    case 'error':
      toast(msg.error || 'Analysis failed', 'error');
      setState('case.view', 'idle');
      break;
  }
}

async function saveRecentCase(result) {
  const stored = await localGet(['recentCases']);
  const recent = (stored.recentCases || []).filter(c => c.id !== result.caseId);
  recent.unshift({ id: result.caseId, number: result.caseNumber, subject: result.subject, ts: Date.now() });
  const trimmed = recent.slice(0, 10);
  await chrome.storage.local.set({ recentCases: trimmed });
  setState('case.recent', trimmed);
}

export async function handleAnalyze_bg(port, msg) {
  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No Salesforce session. Log into OrgCS.' }); return; }

  const send = (type, data) => { try { port.postMessage({ type, ...data }); } catch {} };
  send('progress', { step: 0, label: 'Connecting to Salesforce' });

  const caseId = sanitizeId(msg.caseId);
  const apiBase = session.apiBase;
  const sid = session.sid;

  send('progress', { step: 1, label: 'Fetching case + comments' });
  const caseRecords = await sfQuery(apiBase, sid, `SELECT Id, CaseNumber, Subject, Description, Topic__c, Product_Tag__c FROM Case WHERE Id = '${caseId}' LIMIT 1`);
  if (!caseRecords.length) { send('error', { error: 'Case not found' }); return; }
  const caseRecord = caseRecords[0];

  const comments = await sfQuery(apiBase, sid, `SELECT CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${caseId}' ORDER BY CreatedDate DESC LIMIT 30`);

  send('progress', { step: 2, label: 'Extracting intents' });
  const caseContext = buildCaseContext(caseRecord, comments);
  const intents = await extractIntents(caseContext);

  send('progress', { step: 3, label: 'Searching the knowledge base' });
  const searchResults = await searchKnowledgeBase(apiBase, sid, intents);

  send('progress', { step: 4, label: 'Ranking articles' });
  const rankedArticles = rankArticles(searchResults, intents);
  const topArticles = rankedArticles.slice(0, TOP_K);

  send('progress', { step: 5, label: 'Generating recommendation' });
  const recommendation = await generateRecommendation(caseContext, topArticles, intents);

  send('result', {
    success: true,
    caseId,
    caseNumber: caseRecord.CaseNumber,
    subject: caseRecord.Subject,
    structured: recommendation
  });
}

function buildCaseContext(caseRecord, comments) {
  const commentText = comments.map(c => `[${c.CreatedBy?.Name || 'Unknown'}] ${c.CommentBody || ''}`).join('\n---\n');
  return {
    subject: caseRecord.Subject || '',
    description: caseRecord.Description || '',
    topic: caseRecord.Topic__c || '',
    product: caseRecord.Product_Tag__c || '',
    comments: commentText
  };
}

async function extractIntents(context) {
  const resp = await callClaudeFast({
    system: 'Extract the core technical intents from this support case. Return a JSON array of 2-5 search queries that would find relevant KB articles.',
    messages: [{ role: 'user', content: `Subject: ${context.subject}\nDescription: ${context.description}\nComments (recent):\n${context.comments.slice(0, 3000)}` }],
    maxTokens: 500,
    temperature: 0.1
  });
  const text = extractText(resp);
  try {
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [context.subject];
  } catch {
    return [context.subject];
  }
}

async function searchKnowledgeBase(apiBase, sid, intents) {
  const results = [];
  for (const query of intents.slice(0, MAX_SOSL_QUERIES)) {
    const escapedQuery = query.replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, '\\$&');
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${escapedQuery}} IN ALL FIELDS RETURNING Knowledge__kav(Id, Title, ArticleNumber, Summary, UrlName, PublishStatus WHERE PublishStatus = 'Online') LIMIT ${SOSL_PER_QUERY}`
      );
      results.push(...records);
    } catch {}
  }
  const seen = new Set();
  return results.filter(r => { if (seen.has(r.Id)) return false; seen.add(r.Id); return true; });
}

function rankArticles(articles, intents) {
  const queryTerms = intents.join(' ').toLowerCase().split(/\s+/);
  return articles.map(a => {
    const text = `${a.Title || ''} ${a.Summary || ''}`.toLowerCase();
    const score = queryTerms.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
    return { ...a, _score: score };
  }).sort((a, b) => b._score - a._score);
}

async function generateRecommendation(context, topArticles, intents) {
  const articleSummary = topArticles.map((a, i) => `${i + 1}. [${a.ArticleNumber}] ${a.Title}\n   ${a.Summary || 'No summary'}`).join('\n');
  const resp = await callClaude({
    system: `You are a KB recommendation engine. Given a support case and existing KB articles, determine whether to UPDATE an existing article or CREATE a new one. Return structured JSON with: { "action": "UPDATE_EXISTING"|"CREATE_NEW", "confidence": "HIGH"|"MEDIUM"|"LOW", "summary": "...", "targetArticle": {...} or null, "suggestions": [...], "newArticleDraft": {...} or null }`,
    messages: [{ role: 'user', content: `Case: ${context.subject}\n\n${context.description}\n\nExisting KB Articles:\n${articleSummary}\n\nIntents: ${intents.join(', ')}` }],
    maxTokens: FINAL_MAX_TOKENS,
    temperature: 0.2
  });
  const text = extractText(resp);
  return extractJson(text) || { action: 'CREATE_NEW', summary: text, suggestions: [] };
}

export { handleAnalyze_bg as handleAnalyze };
export { handleAnalyze_bg as handleThemeVolume };
export { handleAnalyze_bg as handleBroaden };
