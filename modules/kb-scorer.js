import { h, spinner, emptyState, toast, modal, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { sfQuery, mapWithConcurrency } from '../shared/api.js';
import { callClaudeFast, streamClaude, extractText } from '../shared/gateway.js';
import { localGet, localSet, cacheGet, cacheSet } from '../shared/storage.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, BODY_FETCH_BATCH_SIZE, MAX_BODY_CHARS, SCORING_MODEL, SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, STORAGE_KEYS } from '../shared/config.js';

let _container = null;
let _unsubs = [];

export function mount(container) {
  _container = container;
  if (!getState('kb.articles')) {
    setState('kb.articles', []);
    setState('kb.scores', {});
    setState('kb.loading', false);
    setState('kb.scoring', null);
    loadArticles();
  }
  renderArticlesView();
  _unsubs.push(subscribe('kb.articles', renderArticlesView));
  _unsubs.push(subscribe('kb.scores', renderArticlesView));
  _unsubs.push(subscribe('kb.loading', renderArticlesView));
  _unsubs.push(subscribe('kb.scoring', renderScoringStatus));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

function renderArticlesView() {
  if (!_container) return;
  _container.textContent = '';
  const loading = getState('kb.loading');
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};

  const toolbar = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } },
      loading ? 'Loading articles…' : `${articles.length} articles loaded`
    ),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'btn btn--secondary btn--sm', onClick: loadArticles, disabled: loading }, 'Refresh'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: scoreAll, disabled: loading || !articles.length }, 'Score All')
    )
  );
  _container.appendChild(toolbar);

  const statusEl = h('div', { id: 'scoring-status' });
  _container.appendChild(statusEl);
  renderScoringStatus();

  if (loading) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('lg')));
    return;
  }

  if (!articles.length) {
    _container.appendChild(emptyState('📄', 'No articles loaded. Click Refresh to fetch from Salesforce.'));
    return;
  }

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, '#'),
      h('th', { style: { width: '50%' } }, 'Title'),
      h('th', null, 'Score'),
      h('th', null, 'Actions')
    )),
    h('tbody', { id: 'articles-tbody' })
  );

  const tbody = table.querySelector('tbody');
  articles.forEach(a => {
    const score = scores[a.id];
    const scoreDisplay = score != null
      ? h('span', { class: `pill pill--${score >= SCORE_HIGH_THRESHOLD ? 'success' : score >= SCORE_MID_THRESHOLD ? 'warning' : 'error'}` }, String(score))
      : h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—');

    tbody.appendChild(h('tr', null,
      h('td', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px' } }, a.articleNumber || ''),
      h('td', null, h('span', { style: { fontSize: '12px' } }, a.title || a.Title || '')),
      h('td', null, scoreDisplay),
      h('td', null,
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => rewriteArticle(a) }, 'Rewrite')
      )
    ));
  });
  _container.appendChild(table);
}

function renderScoringStatus() {
  const el = document.getElementById('scoring-status');
  if (!el) return;
  el.textContent = '';
  const scoring = getState('kb.scoring');
  if (!scoring) return;
  el.appendChild(h('div', { style: { marginBottom: '8px' } },
    h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' } }, `Scoring: ${scoring.done}/${scoring.total}`),
    progressBar(Math.round((scoring.done / scoring.total) * 100), 'default')
  ));
}

async function loadArticles() {
  setState('kb.loading', true);
  try {
    const session = await detectSession();
    if (!session.sid) { toast('Not connected to Salesforce.', 'error'); return; }
    const records = await sfQuery(session.apiBase, session.sid,
      `SELECT Id, Title, ArticleNumber, Summary, UrlName, ValidationStatus FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language = 'en_US' ORDER BY LastModifiedDate DESC LIMIT 2000`
    );
    const articles = records.map(r => ({ id: r.Id, title: r.Title, articleNumber: r.ArticleNumber, summary: r.Summary, urlName: r.UrlName, validationStatus: r.ValidationStatus }));
    setState('kb.articles', articles);

    const cachedScores = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
    if (cachedScores[STORAGE_KEYS.ARTICLE_SCORES]) {
      setState('kb.scores', cachedScores[STORAGE_KEYS.ARTICLE_SCORES]);
    }
  } catch (e) {
    toast('Failed to load articles: ' + e.message, 'error');
  } finally {
    setState('kb.loading', false);
  }
}

async function scoreAll() {
  const articles = getState('kb.articles') || [];
  if (!articles.length) return;
  const scores = { ...(getState('kb.scores') || {}) };
  const toScore = articles.filter(a => scores[a.id] == null);
  if (!toScore.length) { toast('All articles already scored.', 'info'); return; }

  setState('kb.scoring', { done: 0, total: toScore.length });
  let done = 0;

  await mapWithConcurrency(toScore, SCORE_CONCURRENCY, async (article) => {
    try {
      const score = await scoreArticle(article);
      scores[article.id] = score;
      done++;
      setState('kb.scoring', { done, total: toScore.length });
      setState('kb.scores', { ...scores });
    } catch {
      done++;
      setState('kb.scoring', { done, total: toScore.length });
    }
  });

  await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
  setState('kb.scoring', null);
  toast(`Scored ${done} articles.`, 'success');
}

async function scoreArticle(article) {
  const prompt = buildScoringPrompt(article);
  const resp = await callClaudeFast({
    system: 'You are a KB quality scorer. Score this article 0-100 based on the Agentforce Writing Guide. Return ONLY a JSON object: {"score": <number>, "criteria": [{"name": "...", "score": <number>, "note": "..."}]}',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 800,
    temperature: 0.1
  });
  const text = extractText(resp);
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return parsed.score || 0;
  } catch {
    return 0;
  }
}

function buildScoringPrompt(article) {
  return `Article #${article.articleNumber}: ${article.title}\n\nSummary: ${article.summary || 'None'}\n\nScore against: title specificity, product naming, header structure, description+resolution pairing, acronym expansion, additional resources, generalization, editorial style.`;
}

async function rewriteArticle(article) {
  const body = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } }, `Rewriting: ${article.title}`),
    h('div', { id: 'rewrite-stream', style: { whiteSpace: 'pre-wrap', fontSize: '13px', maxHeight: '400px', overflowY: 'auto' } }, spinner('md'))
  );

  const m = modal('Article Rewrite', body, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      const text = document.getElementById('rewrite-stream')?.textContent || '';
      navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'));
    }}
  });

  try {
    await streamClaude({
      system: 'Rewrite this Salesforce KB article following the Agentforce Writing Guide. Improve clarity, structure, and completeness.',
      messages: [{ role: 'user', content: `Title: ${article.title}\nSummary: ${article.summary || ''}` }],
      maxTokens: 4000,
      onDelta: (chunk, full) => {
        const el = document.getElementById('rewrite-stream');
        if (el) el.textContent = full;
      }
    });
  } catch (e) {
    const el = document.getElementById('rewrite-stream');
    if (el) el.textContent = 'Error: ' + e.message;
  }
}

export async function handleScoreBatch(port, msg) {
  const articles = msg.articles || [];
  if (!articles.length) { port.postMessage({ type: 'done', scored: [] }); return; }

  const results = [];
  let done = 0;
  await mapWithConcurrency(articles, SCORE_CONCURRENCY, async (article) => {
    try {
      const score = await scoreArticle(article);
      results.push({ id: article.id, overall: score });
    } catch (e) {
      results.push({ id: article.id, overall: null, error: e.message });
    }
    done++;
    if (done % 5 === 0) port.postMessage({ type: 'progress', batchResults: results.slice(-5), done, total: articles.length });
  });
  port.postMessage({ type: 'done', scored: results });
}

export async function handleRewrite(port, msg) {
  const article = msg.article;
  if (!article) { port.postMessage({ type: 'error', error: 'No article provided' }); return; }
  try {
    await streamClaude({
      system: 'Rewrite this Salesforce KB article following the Agentforce Writing Guide.',
      messages: [{ role: 'user', content: `Title: ${article.title}\nBody: ${(article.body || article.summary || '').slice(0, MAX_BODY_CHARS)}` }],
      maxTokens: 4000,
      onDelta: (chunk) => port.postMessage({ type: 'delta', chunk }),
      onDone: (full) => port.postMessage({ type: 'done', text: full })
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}
