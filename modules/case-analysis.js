import { h, spinner, emptyState, toast, progressBar, chip, modal } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS, STREAM_RENDER_THROTTLE_MS } from '../shared/config.js';

let _container = null;
let _port = null;
let _unsubs = [];
let _collapsedSections = {};
let _streamThrottle = null;

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
  _unsubs.push(subscribe('case.suggestionDeltas', () => {
    if (getState('case.view') !== 'streaming') return;
    if (_streamThrottle) return;
    _streamThrottle = setTimeout(() => { _streamThrottle = null; renderStreaming(); }, STREAM_RENDER_THROTTLE_MS);
  }));

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
  if (_streamThrottle) { clearTimeout(_streamThrottle); _streamThrottle = null; }
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

let _typeaheadTimer = null;

function renderIdle() {
  if (!_container) return;
  _container.textContent = '';

  const searchWrap = h('div', { style: { position: 'relative' } },
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('input', { type: 'text', class: 'input', id: 'case-input', placeholder: 'Case number, ID, or URL…', autocomplete: 'off' }),
      h('button', { class: 'btn btn--primary', onClick: onAnalyzeClick, id: 'analyze-btn' }, 'Analyze')
    ),
    h('div', { id: 'case-typeahead', style: { display: 'none', position: 'absolute', top: '100%', left: '0', right: '0', marginTop: '4px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)', zIndex: '500', maxHeight: '220px', overflowY: 'auto' } })
  );
  const searchBar = h('div', { class: 'card', style: { padding: '12px' } }, searchWrap);
  _container.appendChild(searchBar);

  const caseInput = document.getElementById('case-input');
  caseInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { hideTypeahead(); onAnalyzeClick(); } });
  caseInput?.addEventListener('input', e => {
    const val = e.target.value.trim();
    if (_typeaheadTimer) clearTimeout(_typeaheadTimer);
    if (val.length < 3) { hideTypeahead(); return; }
    _typeaheadTimer = setTimeout(() => searchCases(val), 400);
  });
  caseInput?.addEventListener('blur', () => { setTimeout(hideTypeahead, 200); });

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

  const topArticles = getState('case.topArticles') || [];
  const suggestions = getState('case.suggestions') || [];
  const streamText = getState('case.streamText') || '';
  const suggestionDeltas = getState('case.suggestionDeltas') || {};

  let mainEl = _container.querySelector('#case-stream-main');
  if (!mainEl) {
    _container.textContent = '';
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: '16px', minHeight: '400px' } });
    const sidebar = h('div', { id: 'case-stream-sidebar', style: { borderRight: '1px solid var(--border)', paddingRight: '16px' } });
    sidebar.appendChild(renderSidebarArticles(topArticles));
    grid.appendChild(sidebar);
    mainEl = h('div', { id: 'case-stream-main', style: { flex: '1', overflow: 'auto' } });
    grid.appendChild(mainEl);
    _container.appendChild(grid);
  } else {
    const sidebar = _container.querySelector('#case-stream-sidebar');
    if (sidebar) { sidebar.textContent = ''; sidebar.appendChild(renderSidebarArticles(topArticles)); }
  }

  // Render completed suggestion cards
  if (suggestions.length) {
    const existingCards = mainEl.querySelectorAll('.sug-card-done');
    const grouped = groupByArticle(suggestions);
    const groupKeys = Object.keys(grouped);

    if (groupKeys.length > existingCards.length) {
      for (let i = existingCards.length; i < groupKeys.length; i++) {
        const key = groupKeys[i];
        // Remove any in-progress card for this article
        const inProgress = mainEl.querySelector(`#sug-progress-${key}`);
        if (inProgress) inProgress.remove();
        const card = renderArticleSuggestionCard(grouped[key]);
        card.classList.add('sug-card-done');
        card.style.animation = 'fadeIn 0.3s ease-in';
        const loadingEl = mainEl.querySelector('#stream-loading');
        if (loadingEl) mainEl.insertBefore(card, loadingEl);
        else mainEl.appendChild(card);
      }
    }
  }

  // Render in-progress streaming for articles being processed
  for (const [articleId, deltaText] of Object.entries(suggestionDeltas)) {
    if (!deltaText) continue;
    let progressCard = mainEl.querySelector(`#sug-progress-${articleId}`);
    if (!progressCard) {
      const topArticle = topArticles.find(a => a.id === articleId);
      const articleNum = topArticle?.articleNumber || '';
      const articleTitle = topArticle?.title || '';
      progressCard = h('div', { id: `sug-progress-${articleId}`, class: 'card', style: { marginBottom: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' } },
          spinner('sm'),
          h('a', { href: `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${articleId}/view`, target: '_blank', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' } }, `#${articleNum}`),
          h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)' } }, articleTitle)
        ),
        h('div', { class: 'sug-progress-content', style: { padding: '12px 14px', fontSize: '12px', lineHeight: '1.6', maxHeight: '250px', overflow: 'auto' } })
      );
      const loadingEl = mainEl.querySelector('#stream-loading');
      if (loadingEl) mainEl.insertBefore(progressCard, loadingEl);
      else mainEl.appendChild(progressCard);
    }
    const contentEl = progressCard.querySelector('.sug-progress-content');
    if (contentEl) {
      contentEl.textContent = '';
      renderStreamingSuggestion(deltaText, contentEl);
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  }

  // Render draft streaming (for CREATE_NEW)
  if (streamText) {
    let draftEl = mainEl.querySelector('#stream-draft');
    if (!draftEl) {
      draftEl = h('div', { id: 'stream-draft', class: 'card', style: { marginBottom: '12px', padding: '16px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' } },
          spinner('sm'),
          h('span', null, 'Drafting New Article…')
        ),
        h('div', { id: 'stream-draft-content', style: { fontSize: '12px', lineHeight: '1.6', color: 'var(--text-primary)' } })
      );
      const loadingEl = mainEl.querySelector('#stream-loading');
      if (loadingEl) mainEl.insertBefore(draftEl, loadingEl);
      else mainEl.appendChild(draftEl);
    }
    const contentEl = draftEl.querySelector('#stream-draft-content');
    if (contentEl) {
      contentEl.textContent = '';
      renderStreamingDraft(streamText, contentEl);
    }
  }

  // Show/hide loading indicator
  const hasActiveStreams = Object.keys(suggestionDeltas).length > 0 || streamText;
  let loadingEl = mainEl.querySelector('#stream-loading');
  if (hasActiveStreams && !loadingEl) {
    loadingEl = h('div', { id: 'stream-loading', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', justifyContent: 'center' } },
      spinner('sm'),
      h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, 'Generating…')
    );
    mainEl.appendChild(loadingEl);
  } else if (!hasActiveStreams && !suggestions.length && !streamText) {
    if (!loadingEl) {
      loadingEl = h('div', { id: 'stream-loading', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', justifyContent: 'center' } },
        spinner('sm'),
        h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, 'Generating recommendations…')
      );
      mainEl.appendChild(loadingEl);
    }
  } else if (!hasActiveStreams && loadingEl) {
    loadingEl.remove();
  }
}

function renderStreamingSuggestion(text, container) {
  const cleaned = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

  // Extract suggestion titles progressively
  const titleRegex = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const contentRegex = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const locationRegex = /"location"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  const impactRegex = /"impact"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

  const titles = [];
  let m;
  while ((m = titleRegex.exec(cleaned)) !== null) titles.push(m[1]);
  const contents = [];
  while ((m = contentRegex.exec(cleaned)) !== null) contents.push(m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  const locations = [];
  while ((m = locationRegex.exec(cleaned)) !== null) locations.push(m[1]);
  const impacts = [];
  while ((m = impactRegex.exec(cleaned)) !== null) impacts.push(m[1]);

  if (titles.length === 0) {
    container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px' } },
      spinner('sm'),
      h('span', null, 'Analyzing article…')
    ));
    return;
  }

  titles.forEach((title, i) => {
    const sugEl = h('div', { style: { marginBottom: '12px', paddingBottom: i < titles.length - 1 ? '12px' : '0', borderBottom: i < titles.length - 1 ? '1px solid var(--border)' : 'none' } });

    sugEl.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' } },
      impacts[i] ? h('span', { class: `pill pill--${impactColor(impacts[i])}`, style: { fontSize: '10px' } }, impacts[i]) : null,
      h('span', { style: { fontWeight: '600', fontSize: '12px', color: 'var(--text-primary)' } }, title)
    ));

    if (locations[i]) {
      sugEl.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' } }, `Section: ${locations[i]}`));
    }

    if (contents[i]) {
      const contentDiv = h('div', { style: { fontSize: '12px', lineHeight: '1.5', color: 'var(--text-secondary)', paddingLeft: '8px', borderLeft: '2px solid var(--primary-soft)' } });
      const lines = contents[i].split('\n').slice(0, 8);
      lines.forEach(line => {
        if (line.startsWith('## ')) contentDiv.appendChild(h('div', { style: { fontWeight: '600', marginTop: '4px' } }, line.slice(3)));
        else if (line.startsWith('- ')) contentDiv.appendChild(h('div', { style: { paddingLeft: '8px' } }, '• ' + line.slice(2)));
        else if (line.trim()) contentDiv.appendChild(h('div', null, line));
      });
      if (contents[i].split('\n').length > 8) {
        contentDiv.appendChild(h('div', { style: { color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '4px' } }, '…'));
      }
      sugEl.appendChild(contentDiv);
    } else {
      sugEl.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)', fontSize: '11px' } },
        spinner('sm'),
        h('span', null, 'Writing suggestion content…')
      ));
    }

    container.appendChild(sugEl);
  });

  // If we're still mid-stream (incomplete last suggestion)
  const lastContentComplete = contents.length >= titles.length;
  if (!lastContentComplete && titles.length > contents.length) {
    // Already shown the spinner above
  }
}

function renderStreamingDraft(text, container) {
  const cleaned = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  const titleMatch = cleaned.match(/"title"\s*:\s*"([^"]+)"/);
  if (titleMatch) {
    container.appendChild(h('div', { style: { fontSize: '15px', fontWeight: '700', marginBottom: '12px', color: 'var(--text-primary)' } }, titleMatch[1]));
  }

  const sectionRegex = /\{"heading"\s*:\s*"([^"]+)"\s*,\s*"body"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  let foundSections = false;
  while ((match = sectionRegex.exec(cleaned)) !== null) {
    foundSections = true;
    const heading = match[1];
    const body = match[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const section = h('div', { style: { marginBottom: '14px' } },
      h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--primary)', marginBottom: '6px', borderBottom: '1px solid var(--border)', paddingBottom: '4px' } }, heading)
    );
    const lines = body.split('\n');
    lines.forEach(line => {
      if (line.startsWith('## ')) section.appendChild(h('h3', { style: { fontSize: '12px', fontWeight: '600', marginTop: '8px' } }, line.slice(3)));
      else if (line.startsWith('- ')) section.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px' } }, '• ' + line.slice(2)));
      else if (/^\d+\.\s/.test(line)) section.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px' } }, line));
      else if (line.trim()) section.appendChild(h('p', { style: { margin: '3px 0', fontSize: '12px' } }, line));
    });
    container.appendChild(section);
  }

  if (!foundSections && !titleMatch) {
    container.appendChild(h('div', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', maxHeight: '300px', overflow: 'auto' } }, cleaned.slice(0, 2000)));
  }
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
  sidebar.appendChild(renderSidebarQuality(structured));
  sidebar.appendChild(renderSidebarArticles(topArticles));
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
      main.appendChild(renderArticleSuggestionCard(sugs));
    }
  }

  if (structured.newArticleDraft) {
    const draft = structured.newArticleDraft;
    const draftCollapsed = _collapsedSections['new-draft'] || false;
    const draftCard = h('div', { class: 'card', style: { marginBottom: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

    const draftHeader = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--primary-soft)', borderBottom: draftCollapsed ? 'none' : '1px solid var(--border)', cursor: 'pointer' }, onClick: () => { _collapsedSections['new-draft'] = !_collapsedSections['new-draft']; renderByView(); } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, draftCollapsed ? '▶' : '▼'),
        h('span', { class: 'pill pill--info', style: { fontSize: '10px' } }, 'NEW'),
        h('span', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--text-primary)' } }, draft.title || 'New Article Draft')
      ),
      h('div', { style: { display: 'flex', gap: '6px' }, onClick: (e) => e.stopPropagation() },
        h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, `${(draft.sections || []).length} sections`),
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyDraft(draft) }, 'Copy Draft')
      )
    );
    draftCard.appendChild(draftHeader);

    if (!draftCollapsed) {
      const draftBody = h('div', { style: { padding: '14px 16px' } });
      (draft.sections || []).forEach((sec, idx) => {
        draftBody.appendChild(renderEditableSection(sec, idx, 'draft'));
      });
      draftCard.appendChild(draftBody);
    }
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
        const relevancePill = h('span', { style: { fontSize: '10px', color: 'var(--primary)' } }, `Rel: ${a.score}`);
        const kbScoreText = a.kbScore != null ? `KB: ${a.kbScore}` : 'KB: …';
        const kbColor = a.kbScore != null ? (a.kbScore >= 80 ? 'var(--success)' : a.kbScore >= 60 ? 'var(--warning)' : 'var(--error)') : 'var(--text-muted)';
        const kbPill = h('span', { style: { fontSize: '10px', color: kbColor, cursor: 'pointer' } }, kbScoreText);
        kbPill.addEventListener('click', (e) => {
          e.stopPropagation();
          setState('app.activeTab', 'kb-articles');
          setState('kb.focusArticle', a.id);
        });
        body.appendChild(h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
          link,
          a.reason ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: '1.3' } }, a.reason) : null,
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '3px' } },
            h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' } }, `#${a.articleNumber || ''}`),
            relevancePill,
            kbPill
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

function renderArticleSuggestionCard(sugs) {
  const articleNumber = sugs[0].articleNumber;
  const articleTitle = sugs[0].articleTitle;
  const articleId = sugs[0].articleId;
  const articleUrl = `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${articleId}/view`;
  const collapseKey = `sug-${articleId}`;
  const isCollapsed = _collapsedSections[collapseKey] || false;

  const card = h('div', { class: 'card', style: { marginBottom: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  const collapseIcon = h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px' } }, isCollapsed ? '▶' : '▼');
  const cardHeader = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface-raised)', borderBottom: isCollapsed ? 'none' : '1px solid var(--border)', cursor: 'pointer' }, onClick: () => { _collapsedSections[collapseKey] = !_collapsedSections[collapseKey]; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      collapseIcon,
      h('a', { href: articleUrl, target: '_blank', rel: 'noopener', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' }, onClick: (e) => e.stopPropagation() }, `#${articleNumber}`),
      h('span', { style: { fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)' } }, articleTitle || 'Untitled')
    ),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onClick: (e) => e.stopPropagation() },
      h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, `${sugs.length} suggestion${sugs.length > 1 ? 's' : ''}`),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyAll(sugs) }, 'Copy All')
    )
  );
  card.appendChild(cardHeader);

  if (!isCollapsed) {
    const cardBody = h('div', { style: { padding: '0' } });
    sugs.forEach((sug, i) => {
      const id = `sug-${sug.articleId}-${i}`;
      const isLast = i === sugs.length - 1;

      const sugContainer = h('div', { style: { padding: '14px 16px', borderBottom: isLast ? 'none' : '1px solid var(--border)' } });

      const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
        h('span', { class: `pill pill--${impactColor(sug.impact)}`, style: { fontSize: '10px', padding: '2px 8px' } }, sug.impact || 'MEDIUM'),
        h('span', { style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)', flex: '1' } }, sug.title || `Suggestion ${i + 1}`),
        h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '11px' }, onClick: () => toggleEdit(id) }, 'Edit'),
        h('button', { class: 'btn btn--primary btn--sm', style: { fontSize: '11px' }, onClick: () => refineSection(sug) }, 'Refine')
      );
      sugContainer.appendChild(headerRow);

      if (sug.location) {
        sugContainer.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px' } },
          h('span', { style: { fontWeight: '500' } }, 'Section:'),
          h('span', null, sug.location)
        ));
      }

      const contentArea = h('div', { id, style: { color: 'var(--text-primary)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: 'var(--radius-sm)', fontSize: '12px', lineHeight: '1.6' } });
      contentArea.appendChild(renderMarkdown(sug.content));
      sugContainer.appendChild(contentArea);

      cardBody.appendChild(sugContainer);
    });
    card.appendChild(cardBody);
  }

  return card;
}

function renderEditableSection(sec, idx, prefix) {
  const id = `${prefix}-section-${idx}`;
  const container = h('div', { style: { marginBottom: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--primary)', flex: '1' } }, sec.heading || 'Section'),
    h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '11px' }, onClick: () => toggleEdit(id) }, 'Edit'),
    h('button', { class: 'btn btn--primary btn--sm', style: { fontSize: '11px' }, onClick: () => refineSection(sec) }, 'Refine')
  ));

  const contentArea = h('div', { id, style: { padding: '12px 14px', fontSize: '12px', lineHeight: '1.6' } });
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
  const content = section.content || section.body || '';
  const title = section.title || section.heading || '';
  if (!content) { toast('No content to refine.', 'error'); return; }

  const inputEl = h('input', { type: 'text', class: 'input', placeholder: 'Focus on… (e.g. "add steps", "simplify", "add examples")', style: { width: '100%', marginBottom: '12px' } });
  const bodyEl = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' } }, `Refining: ${title}`),
    inputEl,
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn--primary btn--sm', onClick: doRefine }, 'Refine')
    )
  );
  const { close } = modal('Refine Section', bodyEl);
  inputEl.focus();
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRefine(); });

  async function doRefine() {
    const focus = inputEl.value.trim();
    close();
    toast('Refining…', 'info');
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'REFINE_SECTION',
        content,
        title,
        focus
      });
      if (resp?.success && resp.refined) {
        if (section.content) section.content = resp.refined;
        else if (section.body) section.body = resp.refined;
        renderByView();
        toast('Section refined.', 'success');
      } else {
        toast(resp?.error || 'Refine failed.', 'error');
      }
    } catch (e) {
      toast('Refine error: ' + e.message, 'error');
    }
  }
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

function hideTypeahead() {
  const dropdown = document.getElementById('case-typeahead');
  if (dropdown) dropdown.style.display = 'none';
}

async function searchCases(query) {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'SEARCH_CASES', query });
    if (!resp?.cases?.length) { hideTypeahead(); return; }
    const dropdown = document.getElementById('case-typeahead');
    if (!dropdown) return;
    dropdown.textContent = '';
    resp.cases.forEach(c => {
      const item = h('div', { style: { padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', display: 'flex', gap: '10px', alignItems: 'center' } },
        h('span', { style: { fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--primary)', fontWeight: '500', flexShrink: '0' } }, c.CaseNumber),
        h('span', { style: { fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1' } }, c.Subject || '')
      );
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--primary-soft)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        hideTypeahead();
        startAnalysis(c.Id);
      });
      dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
  } catch { hideTypeahead(); }
}

async function onAnalyzeClick() {
  hideTypeahead();
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
  setState('case.suggestionDeltas', {});

  _port = chrome.runtime.connect({ name: 'kba-analyze' });
  _port.postMessage({ action: 'ANALYZE_CASE', caseId });
  _port.onMessage.addListener(onPortMessage);
  _port.onDisconnect.addListener(() => {
    _port = null;
    const view = getState('case.view');
    if (view === 'analyzing' || view === 'streaming') {
      const suggestions = getState('case.suggestions') || [];
      if (suggestions.length) {
        setState('case.result', { structured: { action: 'UPDATE_EXISTING', confidence: 'LOW', summary: 'Connection lost. Showing partial results.', suggestions }, caseNumber: getState('case.progress')?.caseNumber, subject: '' });
        setState('case.view', 'result');
      } else {
        toast('Connection lost. Try again.', 'error');
        setState('case.view', 'idle');
      }
    }
  });
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
      let hasNewScores = false;
      (msg.topArticles || []).forEach(a => {
        if (a.kbScore != null) {
          updated[a.id] = { overall: a.kbScore, criteria: a.kbCriteria || [], error: null, source: 'case-analysis' };
          hasNewScores = true;
        } else if (a.score != null && !updated[a.id]) {
          updated[a.id] = { overall: a.score, criteria: [], error: null, source: 'case-analysis-relevance' };
        }
      });
      setState('kb.scores', updated);
      if (hasNewScores) {
        localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: updated });
      }
      if (getState('case.view') === 'analyzing') setState('case.view', 'streaming');
      break;
    }
    case 'suggestion-delta': {
      const prevDeltas = getState('case.suggestionDeltas') || {};
      const key = msg.articleId;
      const updated = { ...prevDeltas, [key]: (prevDeltas[key] || '') + (msg.chunk || '') };
      setState('case.suggestionDeltas', updated);
      break;
    }
    case 'suggestion-ready': {
      const existing = getState('case.suggestions') || [];
      setState('case.suggestions', [...existing, ...msg.suggestions]);
      const deltas = getState('case.suggestionDeltas') || {};
      delete deltas[msg.articleId];
      setState('case.suggestionDeltas', { ...deltas });
      if (getState('case.view') === 'streaming') renderStreaming();
      break;
    }
    case 'suggestion-error': {
      const deltas = getState('case.suggestionDeltas') || {};
      delete deltas[msg.articleId];
      setState('case.suggestionDeltas', { ...deltas });
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
