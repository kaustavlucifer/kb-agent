import { h, spinner, emptyState, toast, progressBar, chip } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';

let _container = null;
let _port = null;
let _unsubs = [];
let _collapsedSections = {};

export function mount(container) {
  _container = container;
  if (!getState('case.view')) setState('case.view', 'idle');
  loadRecentCases();
  renderByView();
  _unsubs.push(subscribe('case.view', renderByView));
  _unsubs.push(subscribe('case.progress', () => { if (getState('case.view') === 'analyzing') renderByView(); }));
  _unsubs.push(subscribe('case.result', () => { if (getState('case.view') === 'result') renderByView(); }));
  _unsubs.push(subscribe('case.streamText', () => { if (getState('case.view') === 'streaming') renderStreaming(); }));
  _unsubs.push(subscribe('case.topArticles', () => { if (getState('case.view') === 'streaming') renderStreaming(); }));

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
  _collapsedSections = {};
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
  else if (view === 'streaming') renderStreaming();
  else if (view === 'result') renderResult();
}

function renderIdle() {
  if (!_container) return;
  _container.textContent = '';

  const searchBar = h('div', { class: 'card', style: { padding: '12px' } },
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('input', { type: 'text', class: 'input', id: 'case-input', placeholder: 'Case number, ID, or URL…', autocomplete: 'off' }),
      h('button', { class: 'btn btn--primary', onClick: onAnalyzeClick, id: 'analyze-btn' }, 'Analyze')
    )
  );
  _container.appendChild(searchBar);
  document.getElementById('case-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') onAnalyzeClick(); });

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

function renderStreaming() {
  if (!_container) return;
  _container.textContent = '';

  const topArticles = getState('case.topArticles') || [];
  const suggestions = getState('case.suggestions') || [];

  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: '16px', minHeight: '400px' } });

  const sidebar = h('div', { style: { borderRight: '1px solid var(--border)', paddingRight: '16px' } });
  sidebar.appendChild(renderSidebarArticles(topArticles));
  grid.appendChild(sidebar);

  const main = h('div', { style: { flex: '1', overflow: 'auto' } });

  if (suggestions.length) {
    const grouped = groupByArticle(suggestions);
    for (const [key, sugs] of Object.entries(grouped)) {
      const card = h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '8px' } }, `#${sugs[0].articleNumber} — ${sugs[0].articleTitle}`)
      );
      sugs.forEach((sug, i) => {
        card.appendChild(h('div', { style: { padding: '8px 0', borderBottom: i < sugs.length - 1 ? '1px solid var(--border)' : 'none' } },
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '4px' } },
            h('span', { class: `pill pill--${impactColor(sug.impact)}` }, sug.impact || 'MEDIUM'),
            h('span', { style: { fontWeight: '500', fontSize: '12px' } }, sug.title || '')
          ),
          sug.location ? h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } }, `Location: ${sug.location}`) : null,
          sug.content ? renderMarkdown(sug.content) : null
        ));
      });
      main.appendChild(card);
    }
  }

  main.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', justifyContent: 'center' } },
    spinner('sm'),
    h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, suggestions.length ? 'Generating more suggestions…' : 'Generating recommendations…')
  ));

  grid.appendChild(main);
  _container.appendChild(grid);
}

function renderResult() {
  if (!_container) return;
  _container.textContent = '';
  const result = getState('case.result');
  if (!result) return;

  const structured = result.structured || result;
  const topArticles = getState('case.topArticles') || [];
  const isCreate = structured.action === 'CREATE_NEW';
  const isBoth = structured.action === 'BOTH';

  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: '16px', minHeight: '400px' } });

  const sidebar = h('div', { style: { borderRight: '1px solid var(--border)', paddingRight: '16px' } });
  sidebar.appendChild(renderSidebarArticles(topArticles));
  sidebar.appendChild(renderSidebarQuality(structured));
  grid.appendChild(sidebar);

  const main = h('div', { style: { flex: '1', overflow: 'auto' } });

  const headerCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' } },
      h('div', null,
        h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `Case #${result.caseNumber || ''}`),
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginTop: '2px' } }, result.subject || '')
      ),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('span', { class: `pill pill--${isCreate ? 'info' : isBoth ? 'warning' : 'neutral'}` }, isCreate ? 'Create New' : isBoth ? 'Both' : 'Update Existing'),
        structured.confidence ? h('span', { class: `pill pill--${structured.confidence === 'HIGH' ? 'success' : structured.confidence === 'MEDIUM' ? 'warning' : 'error'}` }, structured.confidence) : null
      )
    ),
    structured.summary ? h('p', { style: { fontSize: '13px', lineHeight: '1.5', color: 'var(--text-secondary)' } }, structured.summary) : null,
    result.caseAbstract ? renderAbstractChips(result.caseAbstract) : null
  );
  main.appendChild(headerCard);

  if (structured.suggestions?.length) {
    const grouped = groupByArticle(structured.suggestions);
    for (const [articleKey, sugs] of Object.entries(grouped)) {
      const sugCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
          h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase' } }, `#${sugs[0].articleNumber} — ${sugs[0].articleTitle}`),
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyAll(sugs) }, 'Copy')
        )
      );
      sugs.forEach((sug, i) => {
        sugCard.appendChild(renderSuggestionItem(sug, i, sugs.length));
      });
      main.appendChild(sugCard);
    }
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
    (draft.sections || []).forEach((sec, idx) => {
      draftCard.appendChild(renderEditableSection(sec, idx, 'draft'));
    });
    main.appendChild(draftCard);
  }

  main.appendChild(h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', marginTop: '16px' } },
    h('button', { class: 'btn btn--secondary btn--sm', onClick: () => { setState('case.view', 'idle'); setState('case.result', null); setState('case.topArticles', null); setState('case.streamText', ''); } }, 'New Analysis')
  ));

  grid.appendChild(main);
  _container.appendChild(grid);
}

function renderSidebarArticles(articles) {
  const isCollapsed = _collapsedSections['articles'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['articles'] = !_collapsedSections['articles']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'Similar Articles'),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', null);
    if (!articles.length) {
      body.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', padding: '4px 0' } }, 'No articles found'));
    } else {
      articles.forEach(a => {
        const articleUrl = a.url || `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${a.id}/view`;
        const link = h('a', { href: articleUrl, target: '_blank', rel: 'noopener', style: { fontSize: '11px', fontWeight: '500', color: 'var(--text-primary)', lineHeight: '1.3', textDecoration: 'none' } }, a.title || 'Untitled');
        link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
        link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
        const scorePill = h('span', { style: { fontSize: '10px', color: 'var(--primary)', cursor: 'pointer' } }, `Score: ${a.score}`);
        scorePill.addEventListener('click', (e) => {
          e.stopPropagation();
          setState('app.activeTab', 'kb-articles');
          setState('kb.focusArticle', a.id);
        });
        body.appendChild(h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
          link,
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '3px' } },
            h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' } }, `#${a.articleNumber || ''}`),
            scorePill
          )
        ));
      });
    }
    section.appendChild(body);
  }
  return section;
}

function formatAction(action) {
  switch (action) {
    case 'CREATE_NEW': return 'Create New Article';
    case 'UPDATE_EXISTING': return 'Update Existing';
    case 'BOTH': return 'Update + Create New';
    default: return action || 'N/A';
  }
}

function renderSidebarQuality(structured) {
  const isCollapsed = _collapsedSections['quality'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['quality'] = !_collapsedSections['quality']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'Quality & Readiness'),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', { style: { fontSize: '11px' } });

    const items = [
      ['Action', formatAction(structured.action)],
      ['Confidence', structured.confidence || 'N/A'],
      ['Articles Found', String((getState('case.topArticles') || []).length)],
      ['Suggestions', String((structured.suggestions || []).length)]
    ];

    if (structured.newArticleDraft) {
      items.push(['Draft Sections', String((structured.newArticleDraft.sections || []).length)]);
    }

    items.push(['AGF Readiness', structured.confidence === 'HIGH' ? 'Ready for Agentforce' : 'Needs review']);

    items.forEach(([label, value]) => {
      body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' } },
        h('span', { style: { color: 'var(--text-muted)' } }, label),
        h('span', { style: { fontWeight: '500', color: label === 'Confidence' ? (value === 'HIGH' ? 'var(--success)' : value === 'MEDIUM' ? 'var(--warning)' : 'var(--error)') : 'var(--text-primary)' } }, value)
      ));
    });

    body.appendChild(h('div', { style: { marginTop: '8px', padding: '6px 8px', background: 'var(--surface-raised)', borderRadius: 'var(--radius-xs)', fontSize: '10px', color: 'var(--text-secondary)', lineHeight: '1.4' } },
      structured.confidence === 'HIGH'
        ? 'This recommendation is high-confidence and suitable for Agentforce consumption after review.'
        : 'Review the suggestions carefully before publishing. Some recommendations may need manual verification.'
    ));

    section.appendChild(body);
  }
  return section;
}


function renderMarkdown(text) {
  if (!text) return h('span', null, '');
  const lines = text.split('\n');
  const container = h('div', { style: { fontSize: '12px', lineHeight: '1.6' } });
  lines.forEach(line => {
    if (line.startsWith('## ')) container.appendChild(h('h3', { style: { fontSize: '13px', fontWeight: '600', marginTop: '8px', marginBottom: '4px' } }, line.slice(3)));
    else if (line.startsWith('# ')) container.appendChild(h('h2', { style: { fontSize: '14px', fontWeight: '700', marginTop: '10px', marginBottom: '4px' } }, line.slice(2)));
    else if (line.startsWith('- ')) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, h('span', null, '• ' + line.slice(2))));
    else if (/^\d+\.\s/.test(line)) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, line));
    else if (line.trim()) container.appendChild(h('p', { style: { margin: '4px 0' } }, line));
  });
  return container;
}

function renderSuggestionItem(sug, i, total) {
  const id = `sug-${sug.articleId}-${i}`;
  const container = h('div', { style: { padding: '10px 0', borderBottom: i < total - 1 ? '1px solid var(--border)' : 'none' } });

  container.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } },
    h('span', { class: `pill pill--${impactColor(sug.impact)}` }, sug.impact || 'MEDIUM'),
    h('span', { style: { fontWeight: '500', fontSize: '13px', flex: '1' } }, sug.title || `Suggestion ${i + 1}`),
    h('button', { class: 'btn btn--ghost btn--sm', onClick: () => toggleEdit(id) }, 'Edit'),
    h('button', { class: 'btn btn--ghost btn--sm', onClick: () => refineSection(sug) }, 'Refine')
  ));

  if (sug.location) {
    container.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } }, `Location: ${sug.location}`));
  }

  const contentArea = h('div', { id, style: { color: 'var(--text-primary)', background: 'var(--surface-raised)', padding: '8px', borderRadius: 'var(--radius-xs)' } });
  contentArea.appendChild(renderMarkdown(sug.content));
  container.appendChild(contentArea);

  return container;
}

function renderEditableSection(sec, idx, prefix) {
  const id = `${prefix}-section-${idx}`;
  const container = h('div', { style: { marginBottom: '12px' } });

  container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
    h('div', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--primary)', flex: '1' } }, sec.heading || 'Section'),
    h('button', { class: 'btn btn--ghost btn--sm', onClick: () => toggleEdit(id) }, 'Edit'),
    h('button', { class: 'btn btn--ghost btn--sm', onClick: () => refineSection(sec) }, 'Refine')
  ));

  const contentArea = h('div', { id, style: {} });
  contentArea.appendChild(renderMarkdown(sec.body));
  container.appendChild(contentArea);

  return container;
}

function toggleEdit(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (el.tagName === 'TEXTAREA') {
    const div = h('div', { id: elementId, style: { fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '1.5', background: 'var(--surface-raised)', padding: '8px', borderRadius: 'var(--radius-xs)' } }, el.value);
    el.replaceWith(div);
  } else {
    const textarea = h('textarea', { id: elementId, class: 'input', style: { width: '100%', minHeight: '120px', fontSize: '12px', lineHeight: '1.5', fontFamily: 'inherit' } });
    textarea.value = el.textContent;
    el.replaceWith(textarea);
  }
}

function refineSection(section) {
  if (!_port) { toast('No active connection.', 'error'); return; }
  _port.postMessage({ action: 'REFINE_SECTION', content: section.content || section.body || '', title: section.title || section.heading || '' });
  toast('Refining…', 'info');
}

function openArticle(article) {
  const url = article.url || `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${article.id}/view`;
  chrome.tabs.create({ url });
}

function groupByArticle(suggestions) {
  const groups = {};
  for (const sug of suggestions) {
    const key = sug.articleId || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(sug);
  }
  return groups;
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

async function onAnalyzeClick() {
  const input = document.getElementById('case-input');
  const value = (input?.value || '').trim();
  if (!value) { toast('Enter a Case number or ID.', 'error'); return; }

  let caseId = extractCaseId(value);
  if (!caseId) {
    if (/^[a-zA-Z0-9]{15,18}$/.test(value)) caseId = value;
    else if (/^\d{3,15}$/.test(value)) {
      const resp = await chrome.runtime.sendMessage({ action: 'RESOLVE_CASE_NUMBER', caseNumber: value });
      if (resp.success) caseId = resp.caseId;
      else { toast(resp.error || ('Case not found: ' + value), 'error'); return; }
    } else { toast('Invalid Case number or ID.', 'error'); return; }
  }
  startAnalysis(caseId);
}

function startAnalysis(caseId) {
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  setState('case.view', 'analyzing');
  setState('case.progress', { step: 0, label: 'Connecting…' });
  setState('case.result', null);
  setState('case.streamText', '');
  setState('case.topArticles', null);
  setState('case.suggestions', []);

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
    case 'meta': {
      setState('case.topArticles', msg.topArticles || []);
      const kbScores = getState('kb.scores') || {};
      const updated = { ...kbScores };
      (msg.topArticles || []).forEach(a => {
        if (a.score != null && !updated[a.id]) {
          updated[a.id] = { overall: a.score, criteria: [], error: null, source: 'case-analysis' };
        }
      });
      setState('kb.scores', updated);
      setState('case.view', 'streaming');
      break;
    }
    case 'suggestion-ready': {
      const existing = getState('case.suggestions') || [];
      setState('case.suggestions', [...existing, ...msg.suggestions]);
      if (getState('case.view') === 'streaming') renderStreaming();
      break;
    }
    case 'delta':
      setState('case.streamText', (getState('case.streamText') || '') + (msg.chunk || ''));
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
