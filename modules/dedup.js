import { h, spinner, emptyState, toast, modal, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { detectSession } from '../shared/auth.js';
import { sfGet, soqlIdList, mapWithConcurrency, stripHtml } from '../shared/api.js';
import { callClaudeFast, streamClaude, extractText, extractJson } from '../shared/gateway.js';
import { localGet, localSet } from '../shared/storage.js';
import { DEDUP_BATCH_SIZE, DEDUP_CONCURRENCY, MAX_BODY_CHARS, SCORING_MODEL, SF_API_VERSION, BODY_FETCH_BATCH_SIZE, STORAGE_KEYS } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _filterPt = [];

const DEDUP_SYSTEM = `You are a Salesforce Knowledge article deduplication analyst. Find articles that are NEAR-IDENTICAL — not merely related.

STRICT DEFINITIONS:
- DUPLICATE: Description AND Resolution are essentially the same — same root cause, same fix steps.
- SUPERSEDED: One article directly replaces another — same problem, newer article fully covers older.

DO NOT FLAG:
- Same product but different error messages or symptoms
- Different root causes even if both mention performance
- Different audiences or setup scenarios
- Broader vs. more specific articles (these should cross-link, not merge)

Return JSON only:
{"pairs":[{"articleA":"<number>","articleB":"<number>","relationship":"DUPLICATE"|"SUPERSEDED","keepArticle":"<number to keep>","confidence":0.85-1.0,"reason":"<what content is identical>"}]}

Rules:
- Only flag pairs with confidence >= 0.85
- Reason must state specific identical content
- If uncertain, do NOT flag — false negatives acceptable, false positives waste time
- NEVER flag an article as a duplicate of ITSELF. articleA and articleB must be DIFFERENT article numbers.
- If no duplicates: return {"pairs":[]}`;

function multiSelect(id, label, options, selected, onChange) {
  const wrap = h('div', { class: 'multi-select', id });
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';

  const trigger = h('div', {
    style: {
      padding: '6px 12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      fontSize: '12px',
      cursor: 'pointer',
      background: 'var(--surface)',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: '140px',
      justifyContent: 'space-between'
    }
  },
    h('span', { style: { color: selected.length ? 'var(--text-primary)' : 'var(--text-muted)' } },
      selected.length ? `${label} (${selected.length})` : label
    ),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, '▼')
  );
  trigger.addEventListener('click', toggleDropdown);
  wrap.appendChild(trigger);

  const dropdown = h('div', { style: { display: 'none', position: 'absolute', top: '100%', left: '0', marginTop: '4px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px', maxHeight: '240px', overflowY: 'auto', zIndex: '500', minWidth: '200px', boxShadow: 'var(--shadow-md)' } });

  if (selected.length) {
    const clearBtn = h('div', { style: { padding: '4px 8px', fontSize: '11px', color: 'var(--primary)', cursor: 'pointer', borderBottom: '1px solid var(--border)', marginBottom: '4px' } }, 'Clear all');
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); onChange([]); });
    dropdown.appendChild(clearBtn);
  }

  options.forEach(opt => {
    const checked = selected.includes(opt.value);
    const checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('change', (e) => {
      const val = opt.value;
      const newSel = e.target.checked ? [...selected, val] : selected.filter(v => v !== val);
      onChange(newSel);
    });
    const item = h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: 'var(--radius-xs)' } },
      checkbox,
      h('span', null, opt.label)
    );
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface-raised)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
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
  if (!getState('dedup.pairs')) {
    setState('dedup.pairs', []);
    setState('dedup.running', null);
    loadCachedResults();
  }
  render();
  _unsubs.push(subscribe('dedup.pairs', render));
  _unsubs.push(subscribe('dedup.running', render));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

async function loadCachedResults() {
  const data = await localGet([STORAGE_KEYS.DEDUP_RESULTS, STORAGE_KEYS.DEDUP_AT]);
  if (data[STORAGE_KEYS.DEDUP_RESULTS]?.length) {
    setState('dedup.pairs', data[STORAGE_KEYS.DEDUP_RESULTS]);
  }
}

function render() {
  if (!_container) return;
  _container.textContent = '';
  const pairs = getState('dedup.pairs') || [];
  const running = getState('dedup.running');
  const articles = getState('kb.articles') || [];

  const ptOptions = [...new Set(articles.map(a => a.topicName).filter(Boolean))].sort();

  const ptMulti = multiSelect('dedup-pt-filter', 'P&T',
    ptOptions.map(pt => ({ value: pt, label: pt.replace(/^(Industry|Revenue)\s*[-–]\s*/i, '') })),
    _filterPt,
    (sel) => { _filterPt = sel; render(); }
  );

  const clearBtn = h('button', { class: 'btn btn--secondary btn--sm', disabled: !pairs.length || !!running }, 'Clear');
  clearBtn.addEventListener('click', clearResults);
  const detectBtn = h('button', { class: 'btn btn--primary btn--sm', disabled: !!running || !articles.length },
    running ? 'Scanning…' : 'Detect Duplicates'
  );
  detectBtn.addEventListener('click', detectDuplicates);

  const scopedArticles = _filterPt.length ? articles.filter(a => _filterPt.includes(a.topicName)) : articles;
  const batchCount = Math.ceil(scopedArticles.length / DEDUP_BATCH_SIZE);
  const scopeInfo = _filterPt.length
    ? `Filtered: ${scopedArticles.length} articles in ${_filterPt.length} P&Ts, ${batchCount} batches`
    : `All P&Ts: ${scopedArticles.length} articles, ${batchCount} batches`;

  const toolbar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } },
    ptMulti,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, scopeInfo),
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginRight: 'auto' } },
      running ? `Scanning… ${running.done}/${running.total} batches` : `${pairs.length} potential duplicate pairs`
    ),
    clearBtn,
    detectBtn
  );
  _container.appendChild(toolbar);

  if (running) {
    const pct = running.total > 0 ? Math.round((running.done / running.total) * 100) : 0;
    _container.appendChild(h('div', { class: 'card', style: { padding: '12px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' } },
        h('span', null, running.ptName ? `P&T: ${running.ptName}` : 'Preparing…'),
        h('span', null, `${pct}%`)
      ),
      progressBar(pct, 'default')
    ));
  }

  if (!articles.length && !pairs.length) {
    _container.appendChild(emptyState('🔗', 'Load articles in the KB Articles tab first, then detect duplicates.'));
    return;
  }

  if (!pairs.length && !running) {
    _container.appendChild(emptyState('✓', 'No duplicates found. Click "Detect Duplicates" to scan articles grouped by Product & Topic.'));
    return;
  }

  const displayPairs = _filterPt.length ? pairs.filter(p => _filterPt.includes(p.ptName) || _filterPt.some(pt => p.titleA?.includes(pt) || p.titleB?.includes(pt))) : pairs;
  if (displayPairs.length) {
    const table = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Article A'),
        h('th', null, 'Article B'),
        h('th', { style: { width: '80px' } }, 'Type'),
        h('th', { style: { width: '70px' } }, 'Conf.'),
        h('th', null, 'Reason'),
        h('th', { style: { width: '100px' } }, 'Actions')
      )),
      h('tbody', null)
    );
    const tbody = table.querySelector('tbody');
    displayPairs.forEach(pair => {
      const confPct = Math.round((pair.confidence || 0) * 100);
      tbody.appendChild(h('tr', null,
        h('td', { style: { fontSize: '12px' } },
          h('div', { style: { fontWeight: '500' } }, `#${pair.articleA}`),
          h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, pair.titleA || '')
        ),
        h('td', { style: { fontSize: '12px' } },
          h('div', { style: { fontWeight: '500' } }, `#${pair.articleB}`),
          h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, pair.titleB || '')
        ),
        h('td', null, h('span', { class: `pill pill--${pair.relationship === 'DUPLICATE' ? 'error' : 'warning'}` }, pair.relationship || 'DUP')),
        h('td', null, h('span', { class: `pill pill--${confPct >= 95 ? 'error' : 'warning'}` }, `${confPct}%`)),
        h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)', maxWidth: '200px' } }, pair.reason || ''),
        h('td', null,
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => showMerge(pair) }, 'Merge')
        )
      ));
    });
    _container.appendChild(table);
  }
}

async function clearResults() {
  setState('dedup.pairs', []);
  await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: [], [STORAGE_KEYS.DEDUP_AT]: null });
}

async function detectDuplicates() {
  try {
    let articles = getState('kb.articles') || [];
    if (_filterPt.length) articles = articles.filter(a => _filterPt.includes(a.topicName));
    if (articles.length < 2) { toast('Need at least 2 articles in selected P&T.', 'error'); return; }

    const session = await detectSession();
    if (!session.sid) { toast('No SF session.', 'error'); return; }

    const ptGroups = new Map();
    for (const a of articles) {
      const pt = a.topicName || '__other__';
      if (!ptGroups.has(pt)) ptGroups.set(pt, []);
      ptGroups.get(pt).push(a);
    }

    const workQueue = [];
    for (const [ptName, ptArticles] of ptGroups) {
      if (ptArticles.length < 2) continue;
      for (let i = 0; i < ptArticles.length; i += DEDUP_BATCH_SIZE) {
        workQueue.push({ ptName, batch: ptArticles.slice(i, i + DEDUP_BATCH_SIZE) });
      }
    }

    if (!workQueue.length) { toast('Not enough articles per P&T to compare.', 'info'); return; }

    setState('dedup.running', { done: 0, total: workQueue.length, ptName: '' });

    const bodyIds = articles.map(a => a.id);
    const bodyMap = await fetchBodiesForDedup(session, bodyIds);

    const allPairs = [];
    let done = 0;

    await mapWithConcurrency(workQueue, DEDUP_CONCURRENCY, async (item) => {
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
      const enriched = item.batch.map(a => ({
        ...a,
        description: bodyMap.get(a.id)?.description || '',
        resolution: bodyMap.get(a.id)?.resolution || ''
      }));
      const pairs = await runDedupBatch(enriched);
      allPairs.push(...pairs);
      done++;
      setState('dedup.running', { done, total: workQueue.length, ptName: item.ptName });
    });

    console.log('[KB-Agent] Dedup: found', allPairs.length, 'raw pairs from', workQueue.length, 'batches');

    const articleMap = new Map();
    articles.forEach(a => {
      articleMap.set(a.articleNumber, a);
      articleMap.set(String(a.articleNumber), a);
    });

    const enrichedPairs = allPairs
      .filter(p => p.confidence >= 0.85)
      .map(p => ({
        ...p,
        ptName: articleMap.get(String(p.articleA))?.topicName || '',
        titleA: articleMap.get(String(p.articleA))?.title || '',
        titleB: articleMap.get(String(p.articleB))?.title || ''
      }))
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 30);

    console.log('[KB-Agent] Dedup: enriched', enrichedPairs.length, 'pairs after filtering');

    setState('dedup.pairs', enrichedPairs);
    setState('dedup.running', null);
    await localSet({ [STORAGE_KEYS.DEDUP_RESULTS]: enrichedPairs, [STORAGE_KEYS.DEDUP_AT]: Date.now() });
    toast(`Found ${enrichedPairs.length} duplicate pairs.`, enrichedPairs.length ? 'warning' : 'success');
  } catch (e) {
    console.error('[KB-Agent] Dedup detection failed:', e);
    toast('Detection failed: ' + e.message, 'error');
    setState('dedup.running', null);
  }
}

async function fetchBodiesForDedup(session, ids) {
  const bodyMap = new Map();
  const batches = [];
  for (let i = 0; i < ids.length; i += BODY_FETCH_BATCH_SIZE) batches.push(ids.slice(i, i + BODY_FETCH_BATCH_SIZE));
  for (const batch of batches) {
    try {
      const soql = `SELECT Id, Description__c, Resolution__c FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`;
      const url = `${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      const result = await sfGet(url, session.sid);
      for (const r of (result.records || [])) {
        bodyMap.set(r.Id, { description: r.Description__c || '', resolution: r.Resolution__c || '' });
      }
    } catch {}
  }
  return bodyMap;
}

async function runDedupBatch(articles) {
  if (articles.length < 2) return [];
  const snippets = articles.map(a => {
    const desc = stripHtml(a.description || '').slice(0, 800);
    const res = stripHtml(a.resolution || '').slice(0, 800);
    return `--- ARTICLE ${a.articleNumber} ---\nTitle: ${a.title}\nSummary: ${(a.summary || '').slice(0, 200)}\n${desc ? `Description: ${desc}\n` : ''}${res ? `Resolution: ${res}` : ''}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: DEDUP_SYSTEM,
      messages: [{ role: 'user', content: `Analyze these ${articles.length} articles for the same Product-Topic. Find near-identical duplicates.\n\n${snippets}` }],
      maxTokens: 2000,
      temperature: 0.1,
      model: SCORING_MODEL
    });
    const parsed = extractJson(extractText(resp));
    const pairs = (parsed?.pairs || []).filter(p => p.articleA && p.articleB && p.articleA !== p.articleB && p.confidence >= 0.85);
    if (pairs.length) console.log('[KB-Agent] Dedup batch returned', pairs.length, 'pairs');
    return pairs;
  } catch (e) {
    console.error('[KB-Agent] Dedup batch error:', e);
    return [];
  }
}

async function showMerge(pair) {
  const articles = getState('kb.articles') || [];
  const artA = articles.find(a => a.articleNumber === pair.articleA);
  const artB = articles.find(a => a.articleNumber === pair.articleB);

  const streamEl = h('div', { id: 'merge-stream', style: { whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: '1.6', maxHeight: '500px', overflowY: 'auto' } }, spinner('md'));
  const content = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' } },
      h('div', null, h('strong', null, 'A: '), `#${pair.articleA} — ${pair.titleA}`),
      h('div', null, h('strong', null, 'B: '), `#${pair.articleB} — ${pair.titleB}`),
      h('div', { style: { marginTop: '4px', fontStyle: 'italic' } }, `Keep: #${pair.keepArticle} | ${pair.reason}`)
    ),
    streamEl
  );

  modal('Merge Suggestion', content, {
    wide: true,
    primaryAction: { label: 'Copy', handler: () => {
      navigator.clipboard.writeText(document.getElementById('merge-stream')?.textContent || '').then(() => toast('Copied.', 'success'));
    }}
  });

  const session = await detectSession();
  let descA = '', resA = '', descB = '', resB = '';
  if (session.sid && artA && artB) {
    const bodyMap = await fetchBodiesForDedup(session, [artA.id, artB.id]);
    descA = stripHtml(bodyMap.get(artA.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resA = stripHtml(bodyMap.get(artA.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
    descB = stripHtml(bodyMap.get(artB.id)?.description || '').slice(0, MAX_BODY_CHARS);
    resB = stripHtml(bodyMap.get(artB.id)?.resolution || '').slice(0, MAX_BODY_CHARS);
  }

  const system = `You are an expert Salesforce Knowledge editor. Merge two duplicate articles into one optimal article following the Agentforce Writing Guide. Output:
## TITLE
[merged title]
## SUMMARY
[2-4 sentences]
## DESCRIPTION
[merged description]
## RESOLUTION
[merged resolution with numbered steps]`;

  const user = `Merge these duplicates into one article.

ARTICLE A (#${pair.articleA}):
Title: ${pair.titleA || artA?.title || ''}
Summary: ${artA?.summary || ''}
Description: ${descA}
Resolution: ${resA}

ARTICLE B (#${pair.articleB}):
Title: ${pair.titleB || artB?.title || ''}
Summary: ${artB?.summary || ''}
Description: ${descB}
Resolution: ${resB}

Keep best content from both. Prefer most complete and recent steps.`;

  try {
    await streamClaude({
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 4000,
      onDelta: (chunk, full) => {
        const el = document.getElementById('merge-stream');
        if (el) el.textContent = full;
      }
    });
  } catch (e) {
    const el = document.getElementById('merge-stream');
    if (el) el.textContent = 'Error: ' + e.message;
  }
}

