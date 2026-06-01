import { h, spinner, emptyState, toast, modal, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { sfGet, sfQueryAll, soqlIdList, mapWithConcurrency, stripHtml, hasCodeBlocks, hasHeaders, hasTables, hasAltText } from '../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { SF_API_VERSION, SCORE_CONCURRENCY, BODY_FETCH_BATCH_SIZE, MAX_BODY_CHARS, SCORING_MODEL, SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, STORAGE_KEYS } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _filterText = '';
let _filterPt = [];
let _filterScore = [];
let _filterValidation = [];

const SCORE_META_FIELDS = [
  'Id', 'KnowledgeArticleId', 'ArticleNumber', 'Title', 'Summary', 'UrlName',
  'PublishStatus', 'ValidationStatus', 'LastPublishedDate', 'LastModifiedDate',
  'Contains_Image__c', 'Contains_Video__c', 'Article_Length__c',
  'ArticleTotalViewCount', 'ArticleCaseAttachCount',
  'Product_And_Topic__r.Name'
].join(', ');

const SCORE_BODY_FIELDS = 'Id, Description__c, Resolution__c, Steps__c, additional_resources__c';

const CRITERIA = [
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

function multiSelect(id, label, options, selected, onChange) {
  const wrap = h('div', { class: 'multi-select', id });
  wrap.style.position = 'relative';
  const btn = h('button', { class: 'btn btn--secondary btn--sm' },
    `${label}${selected.length ? ` (${selected.length})` : ''}`
  );
  btn.addEventListener('click', toggleDropdown);
  wrap.appendChild(btn);

  const dropdown = h('div', { class: 'multi-select__dropdown', style: { display: 'none', position: 'absolute', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px', maxHeight: '200px', overflowY: 'auto', zIndex: '500', minWidth: '180px', boxShadow: 'var(--shadow-md)' } });

  options.forEach(opt => {
    const checked = selected.includes(opt.value);
    const checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('change', (e) => {
      const val = opt.value;
      const newSel = e.target.checked ? [...selected, val] : selected.filter(v => v !== val);
      onChange(newSel);
    });
    const item = h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' } },
      checkbox,
      h('span', null, opt.label)
    );
    dropdown.appendChild(item);
  });
  wrap.appendChild(dropdown);

  function toggleDropdown(e) {
    e.stopPropagation();
    const visible = dropdown.style.display !== 'none';
    dropdown.style.display = visible ? 'none' : 'block';
    if (!visible) {
      const dismiss = (ev) => { if (!wrap.contains(ev.target)) { dropdown.style.display = 'none'; document.removeEventListener('click', dismiss); } };
      setTimeout(() => document.addEventListener('click', dismiss), 0);
    }
  }

  return wrap;
}

export function mount(container) {
  _container = container;
  if (!getState('kb.articles')) {
    setState('kb.articles', []);
    setState('kb.scores', {});
    setState('kb.loading', false);
    setState('kb.scoring', null);
    loadArticles();
  }
  render();
  _unsubs.push(subscribe('kb.articles', render));
  _unsubs.push(subscribe('kb.scores', render));
  _unsubs.push(subscribe('kb.loading', render));
  _unsubs.push(subscribe('kb.scoring', render));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

function render() {
  if (!_container) return;
  _container.textContent = '';
  const loading = getState('kb.loading');
  const articles = getState('kb.articles') || [];
  const scores = getState('kb.scores') || {};
  const scoring = getState('kb.scoring');

  const ptOptions = [...new Set(articles.map(a => a.topicName).filter(Boolean))].sort();
  const scored = articles.filter(a => scores[a.id]?.overall != null);
  const avgScore = scored.length ? Math.round(scored.reduce((s, a) => s + scores[a.id].overall, 0) / scored.length) : null;

  const statsBar = h('div', { class: 'card', style: { padding: '12px', marginBottom: '12px' } },
    h('div', { style: { display: 'flex', gap: '24px', fontSize: '12px' } },
      h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700' } }, String(articles.length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Articles')
      ),
      h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: 'var(--primary)' } }, `${scored.length}/${articles.length}`),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Scored')
      ),
      avgScore != null ? h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: avgScore >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : avgScore >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)' } }, String(avgScore)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Avg Score')
      ) : null,
      scored.length ? h('div', null,
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: 'var(--error)' } }, String(scored.filter(a => scores[a.id].overall < SCORE_MID_THRESHOLD).length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Below 60')
      ) : null
    )
  );
  _container.appendChild(statsBar);

  const validationOptions = [...new Set(articles.map(a => a.validationStatus).filter(Boolean))].sort();

  const searchInput = h('input', { type: 'text', class: 'input', style: { flex: '1', minWidth: '160px', maxWidth: '240px' }, placeholder: 'Search title / article #…', id: 'kb-filter', value: _filterText });
  searchInput.addEventListener('input', e => { _filterText = e.target.value; render(); });

  const ptMulti = multiSelect('kb-pt-filter', 'P&T',
    ptOptions.map(pt => ({ value: pt, label: pt.replace(/^(Industry|Revenue)\s*[-–]\s*/i, '') })),
    _filterPt,
    (sel) => { _filterPt = sel; render(); }
  );

  const scoreMulti = multiSelect('kb-score-filter', 'Score',
    [
      { value: 'high', label: '≥ 80 (Good)' },
      { value: 'mid', label: '60-79 (OK)' },
      { value: 'low', label: '< 60 (Poor)' },
      { value: 'unscored', label: 'Unscored' }
    ],
    _filterScore,
    (sel) => { _filterScore = sel; render(); }
  );

  const valMulti = multiSelect('kb-val-filter', 'Validation',
    validationOptions.map(v => ({ value: v, label: v })),
    _filterValidation,
    (sel) => { _filterValidation = sel; render(); }
  );

  const refreshBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: loading }, 'Refresh');
  refreshBtn.addEventListener('click', loadArticles);
  const scoreBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: loading || !articles.length || !!scoring }, scoring ? 'Scoring…' : 'Score All');
  scoreBtn.addEventListener('click', scoreAll);

  const filtersRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } },
    searchInput,
    ptMulti,
    scoreMulti,
    valMulti,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
      refreshBtn,
      scoreBtn
    )
  );
  _container.appendChild(filtersRow);

  if (scoring) {
    const pct = scoring.total > 0 ? Math.round((scoring.done / scoring.total) * 100) : 0;
    _container.appendChild(h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', null, `Scoring: ${scoring.done} / ${scoring.total}`),
        h('span', null, `${pct}%`)
      ),
      progressBar(pct, 'default')
    ));
  }

  if (loading) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '48px' } }, spinner('lg')));
    return;
  }

  if (!articles.length) {
    _container.appendChild(emptyState('📄', 'No articles loaded. Click Refresh to fetch from Salesforce.'));
    return;
  }

  let filtered = articles;
  if (_filterText) {
    const term = _filterText.toLowerCase();
    filtered = filtered.filter(a => `${a.title || ''} ${a.articleNumber || ''} ${a.topicName || ''} ${a.summary || ''} ${a.knowledgeArticleId || ''}`.toLowerCase().includes(term));
  }
  if (_filterPt.length) filtered = filtered.filter(a => _filterPt.includes(a.topicName));
  if (_filterValidation.length) filtered = filtered.filter(a => _filterValidation.includes(a.validationStatus));
  if (_filterScore.length) filtered = filtered.filter(a => {
    const s = scores[a.id]?.overall;
    return _filterScore.some(range => {
      if (range === 'high') return (s ?? -1) >= SCORE_HIGH_THRESHOLD;
      if (range === 'mid') return s != null && s >= SCORE_MID_THRESHOLD && s < SCORE_HIGH_THRESHOLD;
      if (range === 'low') return s != null && s < SCORE_MID_THRESHOLD;
      if (range === 'unscored') return s == null;
      return false;
    });
  });

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', { style: { width: '70px' } }, '#'),
      h('th', null, 'Title'),
      h('th', { style: { width: '140px' } }, 'P&T'),
      h('th', { style: { width: '60px' } }, 'Score'),
      h('th', { style: { width: '120px' } }, 'Actions')
    )),
    h('tbody', null)
  );

  const tbody = table.querySelector('tbody');
  const pageSize = 100;
  filtered.slice(0, pageSize).forEach(a => {
    const scoreData = scores[a.id];
    const overall = scoreData?.overall;
    const scoreEl = overall != null
      ? h('span', { class: `pill pill--${overall >= SCORE_HIGH_THRESHOLD ? 'success' : overall >= SCORE_MID_THRESHOLD ? 'warning' : 'error'}`, style: { cursor: 'pointer' }, onClick: () => showScoreDetail(a, scoreData) }, String(overall))
      : h('span', { style: { color: 'var(--text-muted)', fontSize: '11px' } }, '—');

    tbody.appendChild(h('tr', null,
      h('td', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)' } }, a.articleNumber || ''),
      h('td', null,
        h('div', { style: { fontSize: '12px', fontWeight: '500' } }, a.title || ''),
        a.validationStatus ? h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, a.validationStatus) : null
      ),
      h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, (a.topicName || '').replace(/^(Industry|Revenue)\s*[-–]\s*/i, '')),
      h('td', null, scoreEl),
      h('td', null,
        h('div', { style: { display: 'flex', gap: '4px' } },
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => scoreOne(a) }, 'Score'),
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => rewriteArticle(a) }, 'Rewrite')
        )
      )
    ));
  });

  if (filtered.length > pageSize) {
    tbody.appendChild(h('tr', null,
      h('td', { colspan: '5', style: { textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '12px' } },
        `Showing ${pageSize} of ${filtered.length}. Use filters to narrow.`
      )
    ));
  }

  _container.appendChild(table);
}

function showScoreDetail(article, scoreData) {
  if (!scoreData?.criteria) return;
  const body = h('div', null,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '16px' } },
      h('div', null,
        h('div', { style: { fontSize: '14px', fontWeight: '600' } }, article.title),
        h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, `#${article.articleNumber}`)
      ),
      h('div', { style: { fontSize: '24px', fontWeight: '700', color: scoreData.overall >= SCORE_HIGH_THRESHOLD ? 'var(--success)' : scoreData.overall >= SCORE_MID_THRESHOLD ? 'var(--warning)' : 'var(--error)' } }, String(scoreData.overall))
    )
  );

  const criteriaTable = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Criterion'),
      h('th', { style: { width: '70px' } }, 'Score'),
      h('th', null, 'Issues'),
      h('th', null, 'Suggestions')
    )),
    h('tbody', null)
  );
  const ctbody = criteriaTable.querySelector('tbody');
  scoreData.criteria.forEach(c => {
    if (c.na) return;
    ctbody.appendChild(h('tr', null,
      h('td', { style: { fontWeight: '500', fontSize: '12px' } }, c.label || c.id),
      h('td', null, h('span', { class: `pill pill--${c.score >= c.max * 0.8 ? 'success' : c.score >= c.max * 0.5 ? 'warning' : 'error'}` }, `${c.score}/${c.max}`)),
      h('td', { style: { fontSize: '11px' } }, (c.issues || []).join('; ') || '—'),
      h('td', { style: { fontSize: '11px' } }, (c.suggestions || []).join('; ') || '—')
    ));
  });
  body.appendChild(criteriaTable);

  modal(`Score: ${article.articleNumber}`, body, { wide: true });
}

async function loadArticles() {
  setState('kb.loading', true);
  try {
    const cachedData = await localGet([STORAGE_KEYS.ALL_ARTICLES, STORAGE_KEYS.ALL_ARTICLES_AT]);
    const cachedArticles = cachedData[STORAGE_KEYS.ALL_ARTICLES];
    const cachedAt = cachedData[STORAGE_KEYS.ALL_ARTICLES_AT];
    if (cachedArticles?.length && cachedAt && (Date.now() - cachedAt < 30 * 60 * 1000)) {
      setState('kb.articles', cachedArticles);
      const cachedScores = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
      if (cachedScores[STORAGE_KEYS.ARTICLE_SCORES]) {
        setState('kb.scores', cachedScores[STORAGE_KEYS.ARTICLE_SCORES]);
      }
      toast(`Loaded ${cachedArticles.length} articles (cached).`, 'success');
      setState('kb.loading', false);
      return;
    }

    const session = await detectSession();
    if (!session.sid) { toast('Not connected to Salesforce.', 'error'); setState('kb.loading', false); return; }

    const records = await sfQueryAll(session.apiBase, session.sid,
      `SELECT ${SCORE_META_FIELDS} FROM Knowledge__kav WHERE PublishStatus = 'Online' AND Language IN ('en_US','en_GB') AND ValidationStatus = 'Validated External' AND (Product_And_Topic__r.Name LIKE 'Industry%' OR Product_And_Topic__r.Name LIKE 'Revenue%') ORDER BY Product_And_Topic__r.Name, LastPublishedDate DESC`,
      (loaded, total) => setState('kb.loading', { loaded, total })
    );

    const articles = records.map(r => ({
      id: r.Id,
      knowledgeArticleId: r.KnowledgeArticleId,
      articleNumber: r.ArticleNumber,
      title: r.Title,
      summary: r.Summary,
      urlName: r.UrlName,
      validationStatus: r.ValidationStatus,
      topicName: r.Product_And_Topic__r?.Name || '',
      containsImage: !!r.Contains_Image__c,
      containsVideo: !!r.Contains_Video__c,
      articleLength: r.Article_Length__c || 0,
      viewCount: r.ArticleTotalViewCount || 0,
      caseAttachCount: r.ArticleCaseAttachCount || 0,
      lastPublished: r.LastPublishedDate
    }));

    setState('kb.articles', articles);
    await localSet({ [STORAGE_KEYS.ALL_ARTICLES]: articles, [STORAGE_KEYS.ALL_ARTICLES_AT]: Date.now() });

    const cached = await localGet([STORAGE_KEYS.ARTICLE_SCORES]);
    if (cached[STORAGE_KEYS.ARTICLE_SCORES]) {
      setState('kb.scores', cached[STORAGE_KEYS.ARTICLE_SCORES]);
    }
    toast(`Loaded ${articles.length} articles.`, 'success');
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  } finally {
    setState('kb.loading', false);
  }
}

async function fetchBodies(articleIds, session) {
  const bodyMap = new Map();
  const batches = [];
  for (let i = 0; i < articleIds.length; i += BODY_FETCH_BATCH_SIZE) {
    batches.push(articleIds.slice(i, i + BODY_FETCH_BATCH_SIZE));
  }
  for (const batch of batches) {
    const soql = `SELECT ${SCORE_BODY_FIELDS} FROM Knowledge__kav WHERE PublishStatus IN ('Online','Draft','Archived') AND Id IN (${soqlIdList(batch)})`;
    const url = `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    try {
      const result = await sfGet(url, session.sid);
      for (const r of (result.records || [])) {
        bodyMap.set(r.Id, {
          description: r.Description__c || '',
          resolution: r.Resolution__c || '',
          steps: r.Steps__c || '',
          additionalResources: r.additional_resources__c || ''
        });
      }
    } catch {}
  }
  return bodyMap;
}

async function scoreAll() {
  const articles = getState('kb.articles') || [];
  const existingScores = getState('kb.scores') || {};
  const toScore = articles.filter(a => !existingScores[a.id]?.overall);
  if (!toScore.length) { toast('All articles already scored.', 'info'); return; }

  setState('kb.scoring', { done: 0, total: toScore.length });
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); setState('kb.scoring', null); return; }

  const bodyMap = await fetchBodies(toScore.map(a => a.id), session);
  const scores = { ...existingScores };
  let done = 0;

  await mapWithConcurrency(toScore, SCORE_CONCURRENCY, async (article) => {
    const body = bodyMap.get(article.id) || {};
    const enriched = { ...article, ...body };
    try {
      const result = await scoreArticle(enriched);
      scores[article.id] = result;
    } catch (e) {
      scores[article.id] = { overall: null, criteria: [], error: e.message };
    }
    done++;
    setState('kb.scores', { ...scores });
    setState('kb.scoring', { done, total: toScore.length });
  });

  await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
  setState('kb.scoring', null);
  toast(`Scored ${done} articles.`, 'success');
}

async function scoreOne(article) {
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); return; }
  toast('Scoring…', 'info');
  const bodyMap = await fetchBodies([article.id], session);
  const body = bodyMap.get(article.id) || {};
  const enriched = { ...article, ...body };
  try {
    const result = await scoreArticle(enriched);
    const scores = { ...(getState('kb.scores') || {}), [article.id]: result };
    setState('kb.scores', scores);
    await localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: scores });
    toast(`Score: ${result.overall}/100`, result.overall >= SCORE_HIGH_THRESHOLD ? 'success' : 'warning');
    showScoreDetail(article, result);
  } catch (e) {
    toast('Scoring failed: ' + e.message, 'error');
  }
}

function computeDynamicMaxes(flags) {
  const naSet = new Set();
  if (!flags.includes('HAS_IMAGES') && !flags.includes('HAS_VIDEO')) naSet.add('media');
  if (!flags.includes('HAS_CODE_BLOCKS')) naSet.add('code');
  if (!flags.includes('HAS_TABLES')) naSet.add('tables');

  const freedPoints = CRITERIA.filter(c => naSet.has(c.id)).reduce((sum, c) => sum + c.baseMax, 0);
  if (freedPoints === 0) return { maxes: Object.fromEntries(CRITERIA.map(c => [c.id, c.baseMax])), naSet };

  const activeIds = CRITERIA.filter(c => !naSet.has(c.id)).map(c => c.id);
  const redistribution = {};
  let distributed = 0;
  const contentBonus = Math.round(freedPoints * 0.45);
  redistribution['content'] = contentBonus;
  distributed += contentBonus;

  const secondaryIds = activeIds.filter(id => id !== 'content' && id !== 'title' && id !== 'summary');
  const secondaryBase = secondaryIds.reduce((s, id) => s + CRITERIA.find(c => c.id === id).baseMax, 0);
  const remaining = freedPoints - distributed;
  for (const id of secondaryIds) {
    const base = CRITERIA.find(c => c.id === id).baseMax;
    redistribution[id] = Math.round(remaining * (base / secondaryBase));
  }

  const diff = freedPoints - Object.values(redistribution).reduce((a, b) => a + b, 0);
  if (diff !== 0 && redistribution['headers'] != null) redistribution['headers'] += diff;

  const maxes = {};
  for (const c of CRITERIA) {
    if (naSet.has(c.id)) maxes[c.id] = 0;
    else maxes[c.id] = c.baseMax + (redistribution[c.id] || 0);
  }
  const total = Object.values(maxes).reduce((a, b) => a + b, 0);
  if (total !== 100) maxes['content'] += (100 - total);

  return { maxes, naSet };
}

function buildScoringPrompt(article) {
  const descRaw = article.description || '';
  const resRaw = article.resolution || '';
  const descText = stripHtml(descRaw).slice(0, MAX_BODY_CHARS);
  const resText = stripHtml(resRaw).slice(0, MAX_BODY_CHARS);
  const stepsText = stripHtml(article.steps || '').slice(0, 1500);

  const flags = [];
  if (article.containsImage) flags.push('HAS_IMAGES');
  if (article.containsVideo) flags.push('HAS_VIDEO');
  if (hasCodeBlocks(descRaw) || hasCodeBlocks(resRaw)) flags.push('HAS_CODE_BLOCKS');
  if (hasTables(descRaw) || hasTables(resRaw)) flags.push('HAS_TABLES');
  if (!hasHeaders(descRaw) && !hasHeaders(resRaw)) flags.push('NO_HTML_HEADERS');
  if (article.containsImage && !hasAltText(descRaw) && !hasAltText(resRaw)) flags.push('IMAGES_MISSING_ALT');
  if (/orgcs\.lightning\.force\.com|orgcs\.my\.salesforce\.com/i.test(descRaw + resRaw)) flags.push('HAS_INTERNAL_URLS');
  if ((article.additionalResources || '').trim().length > 20) flags.push('HAS_ADDITIONAL_RESOURCES');

  const { maxes, naSet } = computeDynamicMaxes(flags);
  const m = maxes;

  const linkAnchors = (descRaw + resRaw).match(/<a\s[^>]*href\s*=\s*["'][^"']+["'][^>]*>[^<]+<\/a>/gi) || [];
  const rawUrls = ((descRaw + resRaw).match(/(?<!['"=])https?:\/\/[^\s"'<>]{10,}/gi) || [])
    .filter(u => !(descRaw + resRaw).includes('href="' + u));
  const internalUrls = (descRaw + resRaw).match(/https?:\/\/(orgcs|org62)[^\s"'<>]*/gi) || [];

  const system = `You are a strict expert reviewer of Salesforce Knowledge Articles for Agentforce readiness.
Score this article. Dynamic max points per criterion are provided. TOTAL MUST EQUAL 100.
${naSet.size ? `N/A CRITERIA (score 0, set "na": true): ${[...naSet].join(', ')}` : ''}

SCORING: Be STRICT. Most articles score 55-75. Score 90+ should be genuinely rare.
Every criterion MUST include "passed" (what you verified passes) and "issues" (specific problems).

CRITERIA: title(max ${m.title}), summary(max ${m.summary}), headers(max ${m.headers}), content(max ${m.content}), scannability(max ${m.scannability}), media(max ${m.media}), code(max ${m.code}), tables(max ${m.tables}), links(max ${m.links}), taxonomy(max ${m.taxonomy}).

Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"...","score":<n>,"passed":["..."],"issues":["..."],"suggestions":["..."]},...]}`;

  const user = `ARTICLE:
Title: ${article.title}
Article#: ${article.articleNumber}
P&T: ${article.topicName || '(none)'}
Validation: ${article.validationStatus || 'Not Validated'}
Flags: ${flags.join(', ') || 'none'}
Links: RAW_URLs=${rawUrls.length}, ANCHORED=${linkAnchors.length}, INTERNAL=${internalUrls.length}
Dynamic Maxes: ${Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ')}

SUMMARY (${(article.summary || '').length} chars):
${article.summary || '(empty)'}

DESCRIPTION (${descText.length} chars):
${descText || '(empty)'}

RESOLUTION (${resText.length} chars):
${resText || '(empty)'}
${stepsText ? `\nSTEPS:\n${stepsText}` : ''}

Score now. Return only JSON. overall must equal sum of all scores.`;

  return { system, user, maxes };
}

async function scoreArticle(article) {
  const { system, user, maxes } = buildScoringPrompt(article);
  const resp = await callClaudeFast({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 2200,
    temperature: 0.1,
    model: SCORING_MODEL
  });
  const text = extractText(resp);
  return parseScoreResponse(text, maxes);
}

function parseScoreResponse(text, dynamicMaxes) {
  const obj = extractJson(text);
  if (!obj) return { overall: null, criteria: [], error: 'No JSON in response' };

  const criteria = CRITERIA.map(c => {
    const found = (obj.criteria || []).find(x => x.id === c.id) || {};
    const effectiveMax = dynamicMaxes?.[c.id] ?? c.baseMax;
    const isNa = found.na === true || effectiveMax === 0;
    const score = isNa ? 0 : Math.min(effectiveMax, Math.max(0, Math.round(Number(found.score) || 0)));
    return {
      id: c.id,
      label: c.label,
      score,
      max: effectiveMax,
      na: isNa,
      passed: Array.isArray(found.passed) ? found.passed.filter(Boolean) : [],
      issues: Array.isArray(found.issues) ? found.issues.filter(Boolean) : [],
      suggestions: Array.isArray(found.suggestions) ? found.suggestions.filter(Boolean) : []
    };
  });
  const overall = Math.min(100, criteria.reduce((s, c) => s + c.score, 0));
  return { overall, criteria, error: null };
}

async function rewriteArticle(article) {
  const session = await detectSession();
  if (!session.sid) { toast('No SF session.', 'error'); return; }

  const bodyMap = await fetchBodies([article.id], session);
  const body = bodyMap.get(article.id) || {};
  const desc = stripHtml(body.description || '').slice(0, MAX_BODY_CHARS);
  const res = stripHtml(body.resolution || '').slice(0, MAX_BODY_CHARS);
  const steps = stripHtml(body.steps || '').slice(0, 1500);

  const streamEl = h('div', { id: 'rewrite-stream', style: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } }, spinner('md'));
  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } }, `#${article.articleNumber} — ${article.title}`),
    streamEl
  );

  modal('Rewrite Article', content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(document.getElementById('rewrite-stream')?.textContent || '').then(() => toast('Copied.', 'success'));
    }}
  });

  const system = `You are an expert technical writer improving Salesforce Knowledge Articles for Agentforce readiness.
Apply these rules:
- TITLE: Specific to product + exact issue. Include product name, error text, or scenario.
- SUMMARY: 2-4 sentences covering problem context and resolution.
- HEADERS: Use ## headers to break content. Never bold text as substitute.
- DESCRIPTION: State problem, symptoms, context. Explain the "why".
- RESOLUTION: Brief statement of what steps accomplish, then numbered steps. After code blocks, add plain-text explanation.

Output exactly: ## TITLE, ## SUMMARY, ## DESCRIPTION, ## RESOLUTION. No other commentary.`;

  const user = `Rewrite this article:
Title: ${article.title}
P&T: ${article.topicName || ''}

CURRENT SUMMARY: ${article.summary || '(empty)'}
CURRENT DESCRIPTION: ${desc || '(empty)'}
CURRENT RESOLUTION: ${res || '(empty)'}
${steps ? `CURRENT STEPS: ${steps}` : ''}`;

  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
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

