import { h, spinner, emptyState, toast, progressBar, chip, modal } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS, STREAM_RENDER_THROTTLE_MS } from '../shared/config.js';

let _container = null;
let _port = null;
let _unsubs = [];
let _collapsedSections = {};
let _streamThrottle = null;
let _editingSections = new Set();

export function mount(container) {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = container;
  if (!getState('case.view')) setState('case.view', 'idle');

  const view = getState('case.view');
  if ((view === 'analyzing' || view === 'streaming') && !_port) {
    const suggestions = getState('case.suggestions') || [];
    if (suggestions.length || getState('case.result')) {
      setState('case.view', 'result');
    } else {
      setState('case.view', 'idle');
    }
  }

  loadRecentCases();
  renderByView();
  _unsubs.push(subscribe('case.view', () => { if (_container) renderByView(); }));
  _unsubs.push(subscribe('case.progress', () => { if (_container) { const v = getState('case.view'); if (v === 'analyzing' || v === 'progressive') renderByView(); } }));
  _unsubs.push(subscribe('case.result', () => { if (_container && getState('case.view') === 'result') renderByView(); }));
  _unsubs.push(subscribe('case.streamText', () => { if (_container && getState('case.view') === 'streaming') renderStreaming(); }));
  _unsubs.push(subscribe('case.caseRecord', () => { if (_container && getState('case.view') === 'progressive') renderByView(); }));
  _unsubs.push(subscribe('case.caseSummary', () => { if (_container) { const v = getState('case.view'); if (v === 'progressive' || v === 'streaming') renderByView(); } }));
  _unsubs.push(subscribe('case.caseCompleteness', () => { if (_container && getState('case.view') === 'progressive') renderByView(); }));
  _unsubs.push(subscribe('case.detectedPts', () => { if (_container && getState('case.view') === 'progressive') renderByView(); }));
  _unsubs.push(subscribe('case.prodDocGap', () => { if (_container) { const v = getState('case.view'); if (v === 'progressive' || v === 'result') renderByView(); } }));
  _unsubs.push(subscribe('case.knownIssues', () => { if (_container) { const v = getState('case.view'); if (v === 'progressive' || v === 'streaming' || v === 'result') renderByView(); } }));
  _unsubs.push(subscribe('case.topArticles', () => {
    if (!_container) return;
    const view = getState('case.view');
    if (view === 'streaming') renderStreaming();
    else if (view === 'result' || view === 'progressive') renderByView();
  }));
  _unsubs.push(subscribe('case.suggestionDeltas', () => {
    if (!_container || getState('case.view') !== 'streaming') return;
    if (_streamThrottle) return;
    _streamThrottle = setTimeout(() => { _streamThrottle = null; if (_container) renderStreaming(); }, STREAM_RENDER_THROTTLE_MS);
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
  if (_typeaheadTimer) { clearTimeout(_typeaheadTimer); _typeaheadTimer = null; }
  _container = null;
  _collapsedSections = {};
  _editingSections.clear();
}

async function loadRecentCases() {
  const data = await localGet(['recentCases', 'sidebarWidth']);
  if (data.recentCases) setState('case.recent', data.recentCases);
  if (data.sidebarWidth) _sidebarWidth = Math.max(220, Math.min(500, data.sidebarWidth));
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
  else if (view === 'progressive') renderProgressive();
  else if (view === 'streaming') renderStreaming();
  else if (view === 'result') renderResult();
}

function buildInlineSearch() {
  const input = h('input', { type: 'text', class: 'input', style: { flex: '1', maxWidth: '320px', fontSize: '12px', padding: '5px 10px' }, placeholder: 'New case #, ID, or URL…', id: 'case-inline-search' });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submitInlineSearch(); });
  const btn = h('button', { class: 'btn btn--primary btn--sm', onClick: () => submitInlineSearch() }, 'Analyze');
  const bar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
    input, btn,
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' } }, 'Enter a case to start new analysis')
  );
  return bar;
}

async function submitInlineSearch() {
  const input = document.getElementById('case-inline-search');
  const val = (input?.value || '').trim().replace(/^#/, '');
  if (!val) return;

  let caseId = extractCaseId(val);
  if (!caseId) {
    if (/^[a-zA-Z0-9]{15,18}$/.test(val)) {
      caseId = val;
    } else if (/^\d{3,15}$/.test(val)) {
      const resp = await chrome.runtime.sendMessage({ action: 'RESOLVE_CASE_NUMBER', caseNumber: val });
      if (resp?.success) caseId = resp.caseId;
      else { toast(resp?.error || 'Case not found', 'error'); return; }
    } else {
      toast('Invalid input. Use a case number, ID, or URL.', 'error');
      return;
    }
  }
  startAnalysis(caseId);
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
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, `${progress.step + 1} / ${steps.length}`),
        h('button', { class: 'btn btn--ghost btn--sm', style: { color: 'var(--error)', fontSize: '11px' }, onClick: stopProcessing }, 'Stop')
      )
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

function renderProgressive() {
  if (!_container) return;
  _container.textContent = '';

  const caseRecord = getState('case.caseRecord');
  const caseSummary = getState('case.caseSummary');
  const completeness = getState('case.caseCompleteness');
  const detectedPts = getState('case.detectedPts') || [];
  const caseAbstract = getState('case.caseAbstract');
  const topArticles = getState('case.topArticles') || [];
  const prodDocGap = getState('case.prodDocGap');
  const knownIssues = getState('case.knownIssues') || [];
  const progress = getState('case.progress') || { step: 0, label: 'Starting…' };

  const grid = buildResizableGrid();
  const sidebar = grid.querySelector('[data-role="sidebar"]');
  const main = grid.querySelector('[data-role="main"]');

  if (topArticles.length) sidebar.appendChild(renderSidebarArticles(topArticles));
  else sidebar.appendChild(h('div', { class: 'skeleton', style: { height: '60px', marginBottom: '12px' } }));
  if (knownIssues.length) sidebar.appendChild(renderSidebarKnownIssues(knownIssues));

  if (caseRecord) {
    main.appendChild(renderCaseDetailsCard(caseRecord, completeness, detectedPts, caseAbstract));
  }

  if (caseSummary) {
    const summaryContent = renderMarkdown(caseSummary);
    const summaryCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px 16px', borderLeft: '3px solid var(--primary)', animation: 'fadeIn 0.3s ease-in' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '6px' } }, 'Case Summary'),
      summaryContent
    );
    const gusItems = getState('case.gusItems') || [];
    if (gusItems.length) {
      summaryCard.appendChild(h('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border)' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px' } }, 'Related GUS Work'),
        ...gusItems.slice(0, 3).map(g =>
          h('div', { style: { fontSize: '11px', padding: '2px 0', display: 'flex', gap: '6px' } },
            h('span', { style: { fontFamily: 'var(--font-mono)', color: 'var(--primary)', fontWeight: '500' } }, g.name),
            h('span', { style: { color: 'var(--text-secondary)', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.subject || ''),
            h('span', { class: 'pill pill--neutral', style: { fontSize: '9px' } }, g.status || '')
          )
        )
      ));
    }
    main.appendChild(summaryCard);
  } else {
    main.appendChild(h('div', { class: 'skeleton', style: { height: '80px', marginBottom: '12px' } }));
  }

  if (prodDocGap && prodDocGap.hasGap) {
    main.appendChild(renderProductDocGapCard(prodDocGap));
  }

  const progressCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px 16px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      spinner('sm'),
      h('span', { style: { fontSize: '12px', color: 'var(--primary)', fontWeight: '500' } }, progress.label || 'Processing…'),
      h('button', { class: 'btn btn--ghost btn--sm', style: { marginLeft: 'auto', color: 'var(--error)' }, onClick: stopProcessing }, 'Stop')
    )
  );
  main.appendChild(progressCard);

  _container.appendChild(grid);
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
    const grid = buildResizableGrid();
    const sidebar = grid.querySelector('[data-role="sidebar"]');
    sidebar.id = 'case-stream-sidebar';
    sidebar.appendChild(renderSidebarArticles(topArticles));
    const knownIssues = getState('case.knownIssues') || [];
    if (knownIssues.length) sidebar.appendChild(renderSidebarKnownIssues(knownIssues));
    mainEl = grid.querySelector('[data-role="main"]');
    mainEl.id = 'case-stream-main';

    const caseSummary = getState('case.caseSummary');
    if (caseSummary) {
      mainEl.appendChild(h('div', { class: 'card', style: { marginBottom: '12px', padding: '10px 14px', borderLeft: '3px solid var(--primary)' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '4px' } }, 'Case Summary'),
        renderMarkdown(caseSummary)
      ));
    }

    _container.appendChild(grid);
  } else {
    const sidebar = _container.querySelector('#case-stream-sidebar');
    if (sidebar) {
      sidebar.textContent = '';
      sidebar.appendChild(renderSidebarArticles(topArticles));
      const ki = getState('case.knownIssues') || [];
      if (ki.length) sidebar.appendChild(renderSidebarKnownIssues(ki));
    }
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
  _container.appendChild(buildInlineSearch());

  const result = getState('case.result');
  if (!result) return;

  const structured = result.structured || result;
  const topArticles = getState('case.topArticles') || [];
  const isCreate = structured.action === 'CREATE_NEW';
  const isBoth = structured.action === 'BOTH';
  const isNoAction = structured.action === 'NO_ACTION';

  const grid = buildResizableGrid();
  const sidebar = grid.querySelector('[data-role="sidebar"]');
  const main = grid.querySelector('[data-role="main"]');

  sidebar.appendChild(renderSidebarQuality(structured));
  const hypotheses = getState('case.hypotheses') || [];
  if (hypotheses.length) sidebar.appendChild(renderSidebarHypotheses(hypotheses));
  sidebar.appendChild(renderSidebarArticles(topArticles));
  const knownIssues = getState('case.knownIssues') || [];
  if (knownIssues.length) sidebar.appendChild(renderSidebarKnownIssues(knownIssues));
  const productDocs = getState('case.productDocs') || [];
  if (productDocs.length) sidebar.appendChild(renderSidebarProductDocs(productDocs));

  const caseRecord = getState('case.caseRecord');
  const completeness = getState('case.caseCompleteness');
  const detectedPts = getState('case.detectedPts') || [];
  const caseAbstract = getState('case.caseAbstract');

  if (caseRecord) {
    main.appendChild(renderCaseDetailsCard(caseRecord, completeness, detectedPts, caseAbstract));
  } else {
    const headerCard = h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' } },
        h('div', null,
          h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `Case #${result.caseNumber || ''}`),
          h('div', { style: { fontSize: '14px', fontWeight: '600', marginTop: '2px' } }, result.subject || '')
        ),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('span', { class: `pill pill--${isNoAction ? 'success' : isCreate ? 'info' : isBoth ? 'warning' : 'neutral'}` }, isNoAction ? 'No Action Needed' : isCreate ? 'Create New' : isBoth ? 'Both' : 'Update Existing'),
          structured.confidence ? h('span', { class: `pill pill--${structured.confidence === 'HIGH' ? 'success' : structured.confidence === 'MEDIUM' ? 'warning' : 'error'}` }, structured.confidence) : null
        )
      ),
      structured.summary ? h('p', { style: { fontSize: '13px', lineHeight: '1.5', color: 'var(--text-secondary)' } }, structured.summary) : null
    );
    main.appendChild(headerCard);
  }

  const actionPill = h('div', { style: { display: 'flex', gap: '6px', marginBottom: '12px' } },
    h('span', { class: `pill pill--${isNoAction ? 'success' : isCreate ? 'info' : isBoth ? 'warning' : 'neutral'}` }, isNoAction ? 'No Action Needed' : isCreate ? 'Create New' : isBoth ? 'Both' : 'Update Existing'),
    structured.confidence ? h('span', { class: `pill pill--${structured.confidence === 'HIGH' ? 'success' : structured.confidence === 'MEDIUM' ? 'warning' : 'error'}` }, structured.confidence) : null,
    structured.summary ? h('span', { style: { fontSize: '12px', color: 'var(--text-secondary)', alignSelf: 'center' } }, structured.summary) : null
  );
  main.appendChild(actionPill);

  // AI Case Summary
  const caseSummary = getState('case.caseSummary');
  if (caseSummary) {
    const summaryContent = renderMarkdown(caseSummary);
    const summaryCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px 16px', borderLeft: '3px solid var(--primary)' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '6px' } }, 'Case Summary'),
      summaryContent
    );
    const gusItems = getState('case.gusItems') || [];
    if (gusItems.length) {
      summaryCard.appendChild(h('div', { style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--border)' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '4px' } }, 'Related GUS Work'),
        ...gusItems.slice(0, 3).map(g =>
          h('div', { style: { fontSize: '11px', padding: '2px 0', display: 'flex', gap: '6px' } },
            h('span', { style: { fontFamily: 'var(--font-mono)', color: 'var(--primary)', fontWeight: '500' } }, g.name),
            h('span', { style: { color: 'var(--text-secondary)', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.subject || ''),
            h('span', { class: 'pill pill--neutral', style: { fontSize: '9px' } }, g.status || '')
          )
        )
      ));
    }
    main.appendChild(summaryCard);
  }

  if (isNoAction) {
    const noActionCard = h('div', { class: 'card', style: { marginBottom: '12px', border: '2px solid var(--success)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } },
      h('div', { style: { padding: '16px', background: 'color-mix(in srgb, var(--success) 8%, transparent)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
          h('span', { style: { fontSize: '18px' } }, '✓'),
          h('span', { style: { fontSize: '14px', fontWeight: '600', color: 'var(--success)' } }, 'Existing Coverage is Adequate')
        ),
        h('p', { style: { fontSize: '13px', lineHeight: '1.5', color: 'var(--text-secondary)', margin: '0 0 12px 0' } }, structured.summary || 'The existing articles already cover this case adequately.'),
        (structured.coveringArticles || []).length ? h('div', { style: { marginBottom: '12px' } },
          h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' } }, 'Covering Articles'),
          ...structured.coveringArticles.map(a =>
            h('div', { style: { padding: '4px 0', fontSize: '12px' } },
              h('a', { href: `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${a.id}/view`, target: '_blank', style: { color: 'var(--primary)', textDecoration: 'none' } }, `#${a.articleNumber} — ${a.title}`)
            )
          )
        ) : null,
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => overrideDecision('CREATE_NEW') }, 'Create New Anyway'),
          h('button', { class: 'btn btn--ghost btn--sm', onClick: () => overrideDecision('UPDATE_EXISTING') }, 'Suggest Updates Anyway')
        )
      )
    );
    main.appendChild(noActionCard);
  }

  const prodDocGap = getState('case.prodDocGap') || result.prodDocGap;
  if (prodDocGap && prodDocGap.hasGap) {
    main.appendChild(renderProductDocGapCard(prodDocGap));
  }

  if (structured.suggestions?.length) {
    for (const sug of structured.suggestions) {
      if (sug.isFullRewrite) {
        main.appendChild(renderFullRewriteCard(sug));
      } else {
        const grouped = groupByArticle([sug]);
        for (const [, sugs] of Object.entries(grouped)) {
          main.appendChild(renderArticleSuggestionCard(sugs));
        }
      }
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
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyDraft(draft) }, 'Copy'),
        h('button', { class: 'btn btn--primary btn--sm', onClick: () => publishArticle(draft, result) }, 'Create in ORGCS')
      )
    );
    draftCard.appendChild(draftHeader);

    if (!draftCollapsed) {
      const draftBody = h('div', { style: { padding: '14px 16px' } });
      draftBody.appendChild(renderEditableSection({ heading: 'Title', body: draft.title || 'Untitled' }, 0, 'draft'));
      const summaryText = draft.summary || (draft.sections || []).find(s => /summary/i.test(s.heading))?.body || '';
      draftBody.appendChild(renderEditableSection({ heading: 'Summary', body: summaryText || '(No summary generated — add a 2-4 sentence overview)' }, 1, 'draft'));
      const contentSections = (draft.sections || []).filter(s => !/summary/i.test(s.heading));
      const descSection = contentSections.find(s => /description|problem|overview/i.test(s.heading)) || contentSections[0];
      const resSection = contentSections.find(s => /resolution|solution|fix|steps|workaround/i.test(s.heading)) || contentSections[1];
      if (descSection) draftBody.appendChild(renderEditableSection({ heading: 'Description', body: descSection.body }, 2, 'draft'));
      if (resSection && resSection !== descSection) draftBody.appendChild(renderEditableSection({ heading: 'Resolution', body: resSection.body }, 3, 'draft'));
      if (!descSection && !resSection) {
        contentSections.forEach((sec, idx) => draftBody.appendChild(renderEditableSection(sec, idx + 2, 'draft')));
      }
      draftCard.appendChild(draftBody);
    }
    main.appendChild(draftCard);
  }

  if (!structured.newArticleDraft && !isNoAction) {
    const createBtn = h('div', { style: { padding: '12px', textAlign: 'center', borderTop: '1px solid var(--border)', marginTop: '8px' } },
      h('button', { class: 'btn btn--primary', onClick: () => { overrideDecision('CREATE_NEW'); toast('Re-analyze the case to generate a new article draft.', 'info'); } }, '+ Create New Article Instead')
    );
    main.appendChild(createBtn);
  }

  const publishedUrl = getState('case.publishedUrl');
  if (publishedUrl) {
    main.appendChild(h('div', { style: { padding: '12px', textAlign: 'center', marginTop: '8px', background: 'color-mix(in srgb, var(--success) 8%, transparent)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--success)' } },
      h('button', { class: 'btn btn--primary', onClick: () => chrome.tabs.create({ url: publishedUrl }) }, 'View Article in ORGCS →')
    ));
  }

  _container.appendChild(grid);
}

let _sidebarWidth = 320;

function buildResizableGrid() {
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: `${_sidebarWidth}px 4px 1fr`, gap: '0', minHeight: '400px' } });
  const sidebar = h('div', { 'data-role': 'sidebar', style: { borderRight: '1px solid var(--border)', paddingRight: '12px', overflow: 'auto' } });
  const handle = h('div', { class: 'resize-handle', style: { width: '4px', cursor: 'col-resize', background: 'transparent', transition: 'background 0.15s' } });
  handle.addEventListener('mouseenter', () => { handle.style.background = 'var(--primary-soft)'; });
  handle.addEventListener('mouseleave', () => { handle.style.background = 'transparent'; });
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = _sidebarWidth;
    const onMove = (ev) => {
      const delta = ev.clientX - startX;
      _sidebarWidth = Math.max(220, Math.min(500, startWidth + delta));
      grid.style.gridTemplateColumns = `${_sidebarWidth}px 4px 1fr`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.style.background = 'transparent';
      localSet({ sidebarWidth: _sidebarWidth });
    };
    handle.style.background = 'var(--primary)';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  const main = h('div', { 'data-role': 'main', style: { paddingLeft: '12px', overflow: 'auto' } });
  grid.appendChild(sidebar);
  grid.appendChild(handle);
  grid.appendChild(main);
  return grid;
}

function renderCaseDetailsCard(caseRecord, completeness, detectedPts, caseAbstract) {
  const completenessPill = completeness
    ? h('span', { class: `pill pill--${completeness.label === 'Sufficient' ? 'success' : completeness.label === 'Partial' ? 'warning' : 'error'}`, style: { fontSize: '10px' } }, `${completeness.label} (${completeness.score}%)`)
    : null;

  const metaItems = [];
  if (caseRecord.priority) metaItems.push(['Priority', caseRecord.priority]);
  if (caseRecord.status) metaItems.push(['Status', caseRecord.status]);
  if (caseAbstract?.product) metaItems.push(['Product', caseAbstract.product]);

  const card = h('div', { class: 'card', style: { marginBottom: '12px', animation: 'fadeIn 0.3s ease-in' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' } },
      h('div', null,
        h('div', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `Case #${caseRecord.caseNumber || ''}`),
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginTop: '2px' } }, caseRecord.subject || '')
      ),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, completenessPill)
    ),
    metaItems.length ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
      ...metaItems.map(([label, val]) => h('span', { style: { fontSize: '10px', color: 'var(--text-secondary)', background: 'var(--surface-raised)', padding: '2px 6px', borderRadius: 'var(--radius-xs)' } }, `${label}: ${val}`))
    ) : null,
    detectedPts.length ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', marginRight: '4px' } }, 'P&T:'),
      ...detectedPts.slice(0, 5).map(pt => h('span', { class: 'pill pill--info', style: { fontSize: '9px' } }, pt))
    ) : null
  );
  return card;
}

function renderProductDocGapCard(prodDocGap) {
  const recColors = { DOCS_SUFFICIENT: 'var(--success)', DOCS_NEED_UPDATE: 'var(--warning)', DOCS_MISSING: 'var(--error)' };
  const recLabels = { DOCS_SUFFICIENT: 'Docs Cover This', DOCS_NEED_UPDATE: 'Docs Need Update', DOCS_MISSING: 'Docs Missing' };
  const recColor = recColors[prodDocGap.recommendation] || 'var(--text-muted)';
  const recLabel = recLabels[prodDocGap.recommendation] || prodDocGap.recommendation;

  return h('div', { class: 'card', style: { marginBottom: '12px', border: `1px solid ${recColor}`, borderRadius: 'var(--radius-sm)', overflow: 'hidden', animation: 'fadeIn 0.3s ease-in' } },
    h('div', { style: { padding: '12px 16px', background: `color-mix(in srgb, ${recColor} 6%, transparent)` } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        h('span', { style: { fontSize: '12px', fontWeight: '600', color: recColor } }, 'Product Documentation Assessment'),
        h('span', { class: `pill pill--${prodDocGap.recommendation === 'DOCS_SUFFICIENT' ? 'success' : prodDocGap.recommendation === 'DOCS_NEED_UPDATE' ? 'warning' : 'error'}`, style: { fontSize: '10px' } }, recLabel)
      ),
      h('p', { style: { fontSize: '12px', lineHeight: '1.5', color: 'var(--text-secondary)', margin: '0' } }, prodDocGap.assessment || '')
    )
  );
}

function renderSidebarKnownIssues(kiItems) {
  const isCollapsed = _collapsedSections['known-issues'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['known-issues'] = !_collapsedSections['known-issues']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, `Known Issues (${kiItems.length})`),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', null);
    kiItems.forEach(ki => {
      const kiUrl = `https://known-issues-prd1.lightning.force.com/lightning/r/Known_Issue__c/${ki.id}/view`;
      const statusColor = ki.status === 'Fixed' ? 'success' : ki.status === 'Solution in Progress' ? 'warning' : 'info';
      body.appendChild(h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
          h('a', { href: kiUrl, target: '_blank', rel: 'noopener', style: { fontSize: '11px', fontWeight: '500', color: 'var(--text-primary)', textDecoration: 'none', lineHeight: '1.3', flex: '1' } }, ki.subject || ki.name),
          h('span', { class: `pill pill--${statusColor}`, style: { fontSize: '9px', flexShrink: '0' } }, ki.status || 'Open')
        ),
        h('div', { style: { display: 'flex', gap: '4px', marginTop: '3px' } },
          h('span', { style: { fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' } }, ki.name || ''),
          ki.cloud ? h('span', { class: 'pill pill--neutral', style: { fontSize: '9px' } }, ki.cloud) : null
        )
      ));
    });
    section.appendChild(body);
  }
  return section;
}

function stopProcessing() {
  if (_port) {
    try { _port.postMessage({ action: 'STOP' }); } catch {}
  }
}

function renderSidebarArticles(articles) {
  const isCollapsed = _collapsedSections['articles'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['articles'] = !_collapsedSections['articles']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, `Similar Articles (${articles.length})`),
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
        const link = h('a', { href: articleUrl, target: '_blank', rel: 'noopener', style: { fontSize: '11px', fontWeight: '500', color: 'var(--text-primary)', lineHeight: '1.3', textDecoration: 'none', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.title || 'Untitled');
        link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
        link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });

        const previewBtn = h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '11px', padding: '1px 4px', flexShrink: '0' }, title: 'Preview article', onClick: (e) => { e.stopPropagation(); showArticlePreview(a); } }, '👁');
        const updateBtn = h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '9px', padding: '1px 5px', flexShrink: '0' }, onClick: (e) => { e.stopPropagation(); triggerUpdateForArticle(a); } }, 'Update');

        const relText = a.score != null ? `Rel: ${a.score}` : 'Rel: —';
        const relColor = a.score != null ? (a.score >= 70 ? 'var(--success)' : a.score >= 50 ? 'var(--primary)' : 'var(--warning)') : 'var(--text-muted)';
        const relevancePill = h('span', { class: 'tooltip-wrap', style: { fontSize: '10px', color: relColor, cursor: 'default', position: 'relative' } }, relText);
        if (a.reason) relevancePill.setAttribute('data-tooltip', a.reason);

        const kbScoreText = a.kbScore != null ? `KB: ${a.kbScore}` : a.kbScoreError ? 'KB: err' : 'KB: …';
        const kbColor = a.kbScore != null ? (a.kbScore >= 80 ? 'var(--success)' : a.kbScore >= 60 ? 'var(--warning)' : 'var(--error)') : 'var(--text-muted)';
        const kbPill = h('span', { style: { fontSize: '10px', color: kbColor, cursor: 'pointer' } }, kbScoreText);
        kbPill.addEventListener('click', (e) => {
          e.stopPropagation();
          setState('app.activeTab', 'kb-articles');
          setState('kb.focusArticle', a.id);
        });

        let statusBadge = null;
        if (a.publishStatus && a.publishStatus !== 'Online') {
          statusBadge = h('span', { class: 'pill pill--neutral', style: { fontSize: '9px' } }, 'Unpublished');
        } else if (a.validationStatus && a.validationStatus !== 'Validated External') {
          statusBadge = h('span', { class: 'pill pill--warning', style: { fontSize: '9px' } }, 'Not Validated');
        }

        body.appendChild(h('div', { 'data-article-id': a.id, style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            link,
            previewBtn,
            statusBadge,
            updateBtn
          ),
          statusBadge && a.publishStatus !== 'Online' ? h('div', { style: { fontSize: '10px', color: 'var(--warning)', marginTop: '2px', fontStyle: 'italic' } }, 'Internal/unpublished — could be published with changes') : null,
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '3px', alignItems: 'center' } },
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

async function showArticlePreview(article) {
  toast('Loading preview…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'FETCH_ARTICLE_PREVIEW', articleId: article.id });
    if (!resp?.success) { toast(resp?.error || 'Failed to load preview.', 'error'); return; }
    const data = resp.article;
    const body = h('div', null,
      h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' } }, `#${data.articleNumber || article.articleNumber || ''}`),
      data.summary ? h('div', { style: { marginBottom: '12px', padding: '8px 12px', background: 'var(--surface-raised)', borderRadius: 'var(--radius-xs)', fontSize: '12px', lineHeight: '1.5' } }, data.summary) : null,
      data.description ? h('div', { style: { marginBottom: '12px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, 'Description'),
        renderMarkdown(data.description.slice(0, 2000))
      ) : null,
      data.resolution ? h('div', { style: { marginBottom: '12px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, 'Resolution'),
        renderMarkdown(data.resolution.slice(0, 2000))
      ) : null
    );
    modal(data.title || article.title || 'Article Preview', body, { wide: true });
  } catch (e) {
    toast('Preview failed: ' + e.message, 'error');
  }
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

  // Calculate AFG readiness score (0-100)
  const topArticles = getState('case.topArticles') || [];
  const articlesWithKbScore = topArticles.filter(a => a.kbScore != null);
  const avgKbScore = articlesWithKbScore.length
    ? Math.round(articlesWithKbScore.reduce((s, a) => s + a.kbScore, 0) / articlesWithKbScore.length)
    : null;
  const confidenceScore = structured.confidence === 'HIGH' ? 90 : structured.confidence === 'MEDIUM' ? 60 : 30;
  const actionScore = structured.action === 'NO_ACTION' ? 95 : structured.action === 'UPDATE_EXISTING' ? 70 : structured.action === 'CREATE_NEW' ? 40 : 55;
  const readinessScore = avgKbScore != null
    ? Math.round((avgKbScore * 0.4) + (confidenceScore * 0.3) + (actionScore * 0.3))
    : Math.round((confidenceScore * 0.5) + (actionScore * 0.5));
  const scoreColor = readinessScore >= 75 ? 'var(--success)' : readinessScore >= 50 ? 'var(--warning)' : 'var(--error)';
  const scoreLabel = readinessScore >= 75 ? 'AGF Ready' : readinessScore >= 50 ? 'Needs Work' : 'Not Ready';

  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['quality'] = !_collapsedSections['quality']; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'AF Readiness'),
      h('span', { style: { fontSize: '14px', fontWeight: '700', color: scoreColor } }, `${readinessScore}`)
    ),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', { style: { fontSize: '11px' } });

    // Score bar
    const barOuter = h('div', { style: { width: '100%', height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden', marginBottom: '10px' } });
    barOuter.appendChild(h('div', { style: { width: `${readinessScore}%`, height: '100%', background: scoreColor, borderRadius: '3px', transition: 'width 0.3s' } }));
    body.appendChild(barOuter);
    body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' } },
      h('span', { style: { color: scoreColor, fontWeight: '600' } }, scoreLabel),
      h('span', { style: { color: 'var(--text-muted)' } }, `${readinessScore}/100`)
    ));

    const items = [
      ['Action', formatAction(structured.action)],
      ['Confidence', structured.confidence || 'N/A'],
      ['Articles Found', String(topArticles.length)],
      ['Avg KB Score', avgKbScore != null ? String(avgKbScore) : '…']
    ];

    if (structured.suggestions?.length) items.push(['Rewrites', String(structured.suggestions.length)]);
    if (structured.newArticleDraft) items.push(['New Draft', 'Yes']);

    items.forEach(([label, value]) => {
      const valueColor = label === 'Confidence' ? (value === 'HIGH' ? 'var(--success)' : value === 'MEDIUM' ? 'var(--warning)' : 'var(--error)') : 'var(--text-primary)';
      body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)' } },
        h('span', { style: { color: 'var(--text-muted)' } }, label),
        h('span', { style: { fontWeight: '500', color: valueColor } }, value)
      ));
    });

    section.appendChild(body);
  }
  return section;
}


function renderSidebarHypotheses(hypotheses) {
  const isCollapsed = _collapsedSections['hypotheses'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const pendingCount = hypotheses.filter(hyp => hyp.status === 'pending').length;
  const headerLabel = _hypothesisRefining ? 'Refining…' : `Hypotheses (${pendingCount} pending)`;
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['hypotheses'] = !_collapsedSections['hypotheses']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: _hypothesisRefining ? 'var(--primary)' : 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' } }, _hypothesisRefining ? spinner('sm') : null, headerLabel),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', null);
    if (_hypothesisRefining) {
      body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', fontSize: '12px', color: 'var(--primary)' } },
        spinner('sm'),
        h('span', null, 'AI is refining content based on your decisions…')
      ));
    }
    body.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' } }, pendingCount > 0 ? 'Accept or reject ALL claims to trigger AI refinement' : 'All decided — refinement applied'));
    hypotheses.forEach((hyp, idx) => {
      const confidencePct = Math.round((hyp.confidence || 0) * 100);
      const statusColor = hyp.status === 'accepted' ? 'var(--success)' : hyp.status === 'rejected' ? 'var(--error)' : 'var(--warning)';
      const item = h('div', { style: { padding: '8px', marginBottom: '6px', background: 'var(--surface)', borderRadius: 'var(--radius-xs)', borderLeft: `3px solid ${statusColor}` } },
        h('div', { style: { fontSize: '11px', lineHeight: '1.4', color: 'var(--text-primary)', marginBottom: '4px' } }, hyp.claim),
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '10px', color: 'var(--text-muted)' } },
          h('span', null, `${confidencePct}% confidence`),
          hyp.source ? h('span', null, ` · ${hyp.source}`) : null
        )
      );
      if (hyp.status === 'pending') {
        item.appendChild(h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px' } },
          h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '10px', color: 'var(--success)', border: '1px solid var(--success)', padding: '1px 6px' }, onClick: () => handleHypothesis(idx, 'accepted') }, '✓ Accept'),
          h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '10px', color: 'var(--error)', border: '1px solid var(--error)', padding: '1px 6px' }, onClick: () => handleHypothesis(idx, 'rejected') }, '✗ Reject')
        ));
      } else {
        item.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '500', color: statusColor, marginTop: '4px' } }, hyp.status === 'accepted' ? '✓ Accepted' : '✗ Rejected'));
      }
      body.appendChild(item);
    });
    section.appendChild(body);
  }
  return section;
}

let _hypothesisRefining = false;

async function handleHypothesis(index, status) {
  const hypotheses = getState('case.hypotheses') || [];
  if (index < 0 || index >= hypotheses.length) return;

  const updated = hypotheses.map((hyp, i) => i === index ? { ...hyp, status } : hyp);
  setState('case.hypotheses', updated);

  const allDecided = updated.every(hyp => hyp.status !== 'pending');
  if (!allDecided) {
    renderByView();
    return;
  }

  // All hypotheses decided — trigger refinement
  _hypothesisRefining = true;
  renderByView();

  try {
    const result = getState('case.result');
    const resp = await chrome.runtime.sendMessage({
      action: 'REFINE_WITH_HYPOTHESES',
      hypotheses: updated,
      structured: result?.structured || null,
      caseAbstract: result?.caseAbstract || null
    });
    _hypothesisRefining = false;
    if (resp?.success && resp.refined) {
      const currentResult = getState('case.result');
      if (currentResult?.structured) {
        currentResult.structured = { ...currentResult.structured, ...resp.refined };
        setState('case.result', { ...currentResult });
      }
      toast('Content refined based on hypothesis decisions.', 'success');
    } else {
      toast(resp?.error || 'Refinement returned no changes.', 'error');
    }
    renderByView();
  } catch (e) {
    _hypothesisRefining = false;
    toast('Refinement failed: ' + e.message, 'error');
    renderByView();
  }
}

function renderSidebarProductDocs(docs) {
  const isCollapsed = _collapsedSections['product-docs'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['product-docs'] = !_collapsedSections['product-docs']; renderByView(); } },
    h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'Product Docs'),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', null);
    body.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', fontStyle: 'italic' } }, 'Official product documentation that may cover this issue'));
    docs.forEach(d => {
      const link = h('a', { href: d.url, target: '_blank', rel: 'noopener', style: { fontSize: '11px', fontWeight: '500', color: 'var(--text-primary)', lineHeight: '1.3', textDecoration: 'none' } }, d.title || 'Untitled');
      link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
      link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
      body.appendChild(h('div', { style: { padding: '5px 0', borderBottom: '1px solid var(--border)' } },
        link,
        d.summary ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: '1.3' } }, d.summary.slice(0, 120)) : null,
        h('span', { class: 'pill pill--info', style: { fontSize: '9px', marginTop: '2px' } }, 'Product Doc')
      ));
    });
    section.appendChild(body);
  }
  return section;
}

function renderMarkdown(text) {
  if (!text) return h('span', null, '');
  const lines = text.split('\n');
  const container = h('div', { style: { fontSize: '12px', lineHeight: '1.6' } });
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = '';

  for (const line of lines) {
    if (!inCodeBlock && /^```(\w*)/.test(line)) {
      inCodeBlock = true;
      codeLang = line.match(/^```(\w*)/)[1] || '';
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      if (line.startsWith('```')) {
        const pre = h('pre', { style: { background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', fontSize: '11px', fontFamily: 'var(--font-mono)', overflowX: 'auto', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
        if (codeLang) {
          pre.appendChild(h('div', { style: { fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px', fontWeight: '600' } }, codeLang));
        }
        pre.appendChild(h('code', null, codeLines.join('\n')));
        container.appendChild(pre);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (line.startsWith('### ')) container.appendChild(h('h4', { style: { fontSize: '12px', fontWeight: '600', marginTop: '6px', marginBottom: '3px' } }, line.slice(4)));
    else if (line.startsWith('## ')) container.appendChild(h('h3', { style: { fontSize: '13px', fontWeight: '600', marginTop: '8px', marginBottom: '4px' } }, line.slice(3)));
    else if (line.startsWith('# ')) container.appendChild(h('h2', { style: { fontSize: '14px', fontWeight: '700', marginTop: '10px', marginBottom: '4px' } }, line.slice(2)));
    else if (line.startsWith('- ')) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, h('span', null, '• ' + line.slice(2))));
    else if (/^\d+\.\s/.test(line)) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, line));
    else if (line.trim()) container.appendChild(h('p', { style: { margin: '4px 0' } }, line));
  }

  if (inCodeBlock && codeLines.length) {
    const pre = h('pre', { style: { background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', fontSize: '11px', fontFamily: 'var(--font-mono)', overflowX: 'auto', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
    pre.appendChild(h('code', null, codeLines.join('\n')));
    container.appendChild(pre);
  }

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

      const isEditing = _editingSections.has(id);
      const editBtn = h('button', { class: `btn ${isEditing ? 'btn--error' : 'btn--ghost'} btn--sm`, style: { fontSize: '11px', minWidth: '28px' }, onClick: () => toggleEdit(id, sug) }, isEditing ? '×' : 'Edit');
      const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
        h('span', { class: `pill pill--${impactColor(sug.impact)}`, style: { fontSize: '10px', padding: '2px 8px' } }, sug.impact || 'MEDIUM'),
        h('span', { style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary)', flex: '1' } }, sug.title || `Suggestion ${i + 1}`),
        editBtn,
        h('button', { class: 'btn btn--primary btn--sm', style: { fontSize: '11px' }, onClick: () => refineSection(sug) }, 'Refine')
      );
      sugContainer.appendChild(headerRow);

      if (sug.location) {
        sugContainer.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px' } },
          h('span', { style: { fontWeight: '500' } }, 'Section:'),
          h('span', null, sug.location)
        ));
      }

      if (isEditing) {
        const textarea = h('textarea', { id, class: 'input', style: { width: '100%', minHeight: '150px', fontSize: '12px', lineHeight: '1.5', fontFamily: 'inherit', border: '2px solid var(--primary)', borderRadius: 'var(--radius-sm)', padding: '12px' } });
        textarea.value = sug.content || '';
        textarea.addEventListener('input', () => { sug.content = textarea.value; });
        sugContainer.appendChild(textarea);
      } else {
        const contentArea = h('div', { id, style: { color: 'var(--text-primary)', background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px', borderRadius: 'var(--radius-sm)', fontSize: '12px', lineHeight: '1.6' } });
        contentArea.appendChild(renderMarkdown(sug.content));
        sugContainer.appendChild(contentArea);
      }

      cardBody.appendChild(sugContainer);
    });
    card.appendChild(cardBody);
  }

  return card;
}

function renderFullRewriteCard(rewrite) {
  const articleUrl = `https://orgcs.lightning.force.com/lightning/r/Knowledge__kav/${rewrite.articleId}/view`;
  const collapseKey = `rewrite-${rewrite.articleId}`;
  const isCollapsed = _collapsedSections[collapseKey] || false;

  const card = h('div', { class: 'card', style: { marginBottom: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  const cardHeader = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface-raised)', borderBottom: isCollapsed ? 'none' : '1px solid var(--border)', cursor: 'pointer' }, onClick: () => { _collapsedSections[collapseKey] = !_collapsedSections[collapseKey]; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼'),
      h('span', { class: 'pill pill--warning', style: { fontSize: '10px' } }, 'REWRITE'),
      h('a', { href: articleUrl, target: '_blank', rel: 'noopener', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' }, onClick: (e) => e.stopPropagation() }, `#${rewrite.articleNumber}`),
      h('span', { style: { fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)' } }, rewrite.title || rewrite.articleTitle)
    ),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onClick: (e) => e.stopPropagation() },
      h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, `${(rewrite.sections || []).length} sections`),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => copyRewrite(rewrite) }, 'Copy'),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => refineSection(rewrite) }, 'Refine'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: () => publishUpdate(rewrite, getState('case.result')) }, 'Update in ORGCS')
    )
  );
  card.appendChild(cardHeader);

  if (!isCollapsed) {
    if (rewrite.changesSummary) {
      card.appendChild(h('div', { style: { padding: '10px 16px', background: 'color-mix(in srgb, var(--warning) 6%, transparent)', borderBottom: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('span', null, h('strong', null, 'Changes: '), rewrite.changesSummary),
        h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '10px', whiteSpace: 'nowrap' }, onClick: () => publishArticle(rewrite, getState('case.result')) }, 'Create as New Instead')
      ));
    }
    const body = h('div', { style: { padding: '14px 16px' } });
    const prefix = `rewrite-${rewrite.articleId}`;
    body.appendChild(renderEditableSection({ heading: 'Title', body: rewrite.title || rewrite.articleTitle || 'Untitled' }, 0, prefix));
    const summaryText = rewrite.summary || (rewrite.sections || []).find(s => /summary/i.test(s.heading))?.body || '';
    body.appendChild(renderEditableSection({ heading: 'Summary', body: summaryText || '(No summary — add overview)' }, 1, prefix));
    const contentSections = (rewrite.sections || []).filter(s => !/summary/i.test(s.heading));
    const descSection = contentSections.find(s => /description|problem|overview/i.test(s.heading)) || contentSections[0];
    const resSection = contentSections.find(s => /resolution|solution|fix|steps|workaround/i.test(s.heading)) || contentSections[1];
    if (descSection) body.appendChild(renderEditableSection({ heading: 'Description', body: descSection.body }, 2, prefix));
    if (resSection && resSection !== descSection) body.appendChild(renderEditableSection({ heading: 'Resolution', body: resSection.body }, 3, prefix));
    if (!descSection && !resSection) {
      contentSections.forEach((sec, idx) => body.appendChild(renderEditableSection(sec, idx + 2, prefix)));
    }
    card.appendChild(body);
  }

  return card;
}

function copyRewrite(rewrite) {
  const text = `# ${rewrite.title || 'Rewritten Article'}\n\n**Summary:** ${rewrite.summary || ''}\n\n` +
    (rewrite.sections || []).map(s => `## ${s.heading}\n${s.body}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => toast('Copied.', 'success'));
}

async function publishArticle(draft, result) {
  toast('Creating article in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_NEW_ARTICLE',
      payload: {
        title: draft.title,
        summary: draft.summary || (draft.sections?.[0]?.body || '').slice(0, 300),
        sections: draft.sections || [],
        caseNumber: result?.caseNumber,
        taxonomyName: result?.caseAbstract?.product || null
      }
    });
    if (resp?.success) {
      toast('Article created!', 'success');
      if (resp.url) {
        setState('case.publishedUrl', resp.url);
        renderByView();
      }
    } else {
      toast(resp?.error || 'Failed to create article.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function publishUpdate(rewrite, result) {
  toast('Creating draft update in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_UPDATE_DRAFT',
      payload: {
        existingArticleId: rewrite.articleId,
        title: rewrite.title,
        summary: rewrite.summary,
        sections: rewrite.sections || [],
        caseNumber: result?.caseNumber,
        taxonomyName: result?.caseAbstract?.product || null
      }
    });
    if (resp?.success) {
      toast('Draft version created!', 'success');
      if (resp.url) {
        setState('case.publishedUrl', resp.url);
        renderByView();
      }
    } else {
      toast(resp?.error || 'Failed to create draft.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function renderEditableSection(sec, idx, prefix) {
  const id = `${prefix}-section-${idx}`;
  const isEditing = _editingSections.has(id);
  const container = h('div', { style: { marginBottom: '16px', border: `1px solid ${isEditing ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  const editBtn = h('button', { class: `btn ${isEditing ? 'btn--error' : 'btn--ghost'} btn--sm`, style: { fontSize: '11px', minWidth: '28px' }, onClick: () => toggleEdit(id, sec) }, isEditing ? '×' : 'Edit');
  container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' } },
    h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--primary)', flex: '1' } }, sec.heading || 'Section'),
    editBtn,
    h('button', { class: 'btn btn--primary btn--sm', style: { fontSize: '11px' }, onClick: () => refineSection(sec) }, 'Refine')
  ));

  if (isEditing) {
    const textarea = h('textarea', { id, class: 'input', style: { width: '100%', minHeight: '150px', fontSize: '12px', lineHeight: '1.5', fontFamily: 'inherit', border: 'none', borderTop: '2px solid var(--primary)', padding: '12px 14px', resize: 'vertical' } });
    textarea.value = sec.body || '';
    textarea.addEventListener('input', () => { sec.body = textarea.value; });
    container.appendChild(textarea);
  } else {
    const contentArea = h('div', { id, style: { padding: '12px 14px', fontSize: '12px', lineHeight: '1.6' } });
    contentArea.appendChild(renderMarkdown(sec.body));
    container.appendChild(contentArea);
  }

  return container;
}

function toggleEdit(elementId, sectionData) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (_editingSections.has(elementId)) {
    _editingSections.delete(elementId);
    const newContent = el.tagName === 'TEXTAREA' ? el.value : el.textContent;
    if (sectionData) {
      if (sectionData.content !== undefined) sectionData.content = newContent;
      else if (sectionData.body !== undefined) sectionData.body = newContent;
    }
    renderByView();
  } else {
    _editingSections.add(elementId);
    renderByView();
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
        if ('content' in section) section.content = resp.refined;
        else if ('body' in section) section.body = resp.refined;
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

async function triggerUpdateForArticle(article) {
  const result = getState('case.result');
  if (!result) { toast('No analysis result available.', 'error'); return; }

  const existingSuggestions = result.structured?.suggestions || [];
  const alreadyHasRewrite = existingSuggestions.some(s => s.articleId === article.id);
  if (alreadyHasRewrite) {
    toast('A rewrite for this article already exists below.', 'info');
    return;
  }

  toast('Generating rewrite (streaming)…', 'info');
  // Use the streaming suggestion-delta pattern
  setState('case.view', 'streaming');
  setState('case.suggestionDeltas', { [article.id]: '' });

  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'GENERATE_ARTICLE_UPDATE',
      articleId: article.id,
      articleTitle: article.title,
      articleNumber: article.articleNumber,
      caseId: result.caseId,
      caseSubject: result.subject,
      caseAbstract: result.caseAbstract
    });
    if (resp?.success && resp.rewrite) {
      const newSuggestion = {
        ...resp.rewrite,
        articleId: article.id,
        articleNumber: article.articleNumber,
        articleTitle: article.title,
        isFullRewrite: true,
        changesSummary: 'Manual update triggered from sidebar'
      };
      const newStructured = {
        ...(result.structured || {}),
        suggestions: [...(result.structured?.suggestions || []), newSuggestion]
      };
      setState('case.result', { ...result, structured: newStructured });
      toast('Rewrite generated.', 'success');
    } else {
      toast(resp?.error || 'Generation failed.', 'error');
    }
  } catch (e) {
    toast('Failed: ' + e.message, 'error');
  }
  setState('case.suggestionDeltas', {});
  setState('case.view', 'result');
}

function overrideDecision(newAction) {
  const result = getState('case.result');
  if (!result) return;
  const newStructured = {
    ...(result.structured || {}),
    action: newAction,
    summary: `User override: ${newAction === 'CREATE_NEW' ? 'Creating new article.' : 'Suggesting updates.'}`
  };
  setState('case.result', { ...result, structured: newStructured });
  toast(`Switched to ${newAction === 'CREATE_NEW' ? 'Create New' : 'Update Existing'} mode. Re-analyze to generate content.`, 'info');
  renderByView();
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
  const value = (input?.value || '').trim().replace(/^#/, '');
  if (!value) { toast('Enter a Case number or ID.', 'error'); return; }

  let caseId = extractCaseId(value);
  if (!caseId) {
    if (/^[a-zA-Z0-9]{15,18}$/.test(value)) caseId = value;
    else if (/^\d{3,15}$/.test(value)) {
      toast('Resolving case number…', 'info');
      const resp = await chrome.runtime.sendMessage({ action: 'RESOLVE_CASE_NUMBER', caseNumber: value });
      if (resp?.success) caseId = resp.caseId;
      else { toast(resp?.error || ('Case not found: ' + value), 'error'); return; }
    } else { toast('Invalid input. Enter a case number (digits), Salesforce ID (15-18 chars), or case URL.', 'error'); return; }
  }
  startAnalysis(caseId);
}

let _analysisGen = 0;

function startAnalysis(caseId) {
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  const gen = ++_analysisGen;
  setState('case.view', 'analyzing');
  setState('case.progress', { step: 0, label: 'Connecting…' });
  setState('case.result', null);
  setState('case.streamText', '');
  setState('case.topArticles', null);
  setState('case.suggestions', []);
  setState('case.suggestionDeltas', {});
  setState('case.caseSummary', null);
  setState('case.gusItems', null);
  setState('case.productDocs', null);
  setState('case.hypotheses', null);
  setState('case.prodDocGap', null);
  setState('case.caseRecord', null);
  setState('case.caseCompleteness', null);
  setState('case.detectedPts', null);
  setState('case.caseAbstract', null);
  setState('case.knownIssues', null);
  setState('case.publishedUrl', null);

  _port = chrome.runtime.connect({ name: 'kba-analyze' });
  _port.postMessage({ action: 'ANALYZE_CASE', caseId });
  _port.onMessage.addListener(onPortMessage);
  _port.onDisconnect.addListener(() => {
    if (gen !== _analysisGen) return;
    _port = null;
    const view = getState('case.view');
    if (view === 'analyzing' || view === 'progressive' || view === 'streaming') {
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
    case 'stopped':
      setState('case.view', 'result');
      toast('Processing stopped. Showing partial results.', 'info');
      break;
    case 'meta': {
      if (msg.caseRecord) {
        setState('case.caseRecord', msg.caseRecord);
        if (getState('case.view') === 'analyzing') setState('case.view', 'progressive');
      }
      if (msg.caseCompleteness) setState('case.caseCompleteness', msg.caseCompleteness);
      if (msg.detectedPts) setState('case.detectedPts', msg.detectedPts);
      if (msg.caseAbstract) setState('case.caseAbstract', msg.caseAbstract);
      if (msg.caseSummary) setState('case.caseSummary', msg.caseSummary);
      if (msg.gusItems) setState('case.gusItems', msg.gusItems);
      if (msg.productDocs) setState('case.productDocs', msg.productDocs);
      if (msg.hypotheses) setState('case.hypotheses', msg.hypotheses);
      if (msg.prodDocGap) setState('case.prodDocGap', msg.prodDocGap);
      if (msg.knownIssues) setState('case.knownIssues', msg.knownIssues);
      if (msg.topArticles) {
        const currentView = getState('case.view');
        if (currentView === 'analyzing' || currentView === 'progressive') setState('case.view', 'streaming');
        setState('case.topArticles', msg.topArticles);
        const kbScores = getState('kb.scores') || {};
        const updated = { ...kbScores };
        let hasNewScores = false;
        msg.topArticles.forEach(a => {
          if (a.kbScore != null) {
            updated[a.id] = { overall: a.kbScore, criteria: a.kbCriteria || [], error: null, source: 'case-analysis' };
            hasNewScores = true;
          } else if (a.score != null && !updated[a.id]) {
            updated[a.id] = { overall: a.score, criteria: [], error: null, source: 'case-analysis-relevance' };
          }
        });
        setState('kb.scores', updated);
        if (hasNewScores) localSet({ [STORAGE_KEYS.ARTICLE_SCORES]: updated });
      }
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
      const { [msg.articleId]: _ready, ...restReady } = getState('case.suggestionDeltas') || {};
      setState('case.suggestionDeltas', restReady);
      if (getState('case.view') === 'streaming') renderStreaming();
      break;
    }
    case 'suggestion-error': {
      const { [msg.articleId]: _err, ...restErr } = getState('case.suggestionDeltas') || {};
      setState('case.suggestionDeltas', restErr);
      if (getState('case.view') === 'streaming') renderStreaming();
      break;
    }
    case 'summary-delta':
      setState('case.caseSummary', (getState('case.caseSummary') || '') + (msg.chunk || ''));
      break;
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
