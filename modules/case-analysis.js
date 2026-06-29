import { h, spinner, streamingDots, emptyState, toast, progressBar, modal, renderMarkdown } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS, STREAM_RENDER_THROTTLE_MS, articleUrl } from '../shared/config.js';

let _container = null;
let _port = null;
let _unsubs = [];
let _collapsedSections = {};
let _streamThrottle = null;
let _streamPending = false;
let _editingSections = new Set();
let _sidebarOnly = false;
let _renderRaf = null;

function extractStreamingField(cleaned, fieldName) {
  const completeRe = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, '');
  const cm = cleaned.match(completeRe);
  if (cm) return { value: cm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'), complete: true };
  const partialRe = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`, '');
  const pm = cleaned.match(partialRe);
  if (pm) return { value: pm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'), complete: false };
  return null;
}

function extractStreamingSectionBody(cleaned, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const completeRe = new RegExp(`"heading"\\s*:\\s*"${esc}"\\s*,\\s*"body"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, '');
  const cm = cleaned.match(completeRe);
  if (cm) return { value: cm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'), complete: true };
  const partialRe = new RegExp(`"heading"\\s*:\\s*"${esc}"\\s*,\\s*"body"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`, '');
  const pm = cleaned.match(partialRe);
  if (pm) return { value: pm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'), complete: false };
  return null;
}

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
  _unsubs.push(subscribe('case.progress', () => { if (_container) { const v = getState('case.view'); if (v === 'analyzing') renderByView(); else if (v === 'progressive') scheduleRender(); } }));
  _unsubs.push(subscribe('case.result', () => { if (_container && getState('case.view') === 'result') renderByView(); }));
  _unsubs.push(subscribe('case.streamText', () => {
    if (!_container || getState('case.view') !== 'streaming') return;
    if (_streamThrottle) { _streamPending = true; return; }
    renderStreaming();
    _streamThrottle = setTimeout(() => {
      _streamThrottle = null;
      if (_streamPending) { _streamPending = false; if (_container && getState('case.view') === 'streaming') renderStreaming(); }
    }, STREAM_RENDER_THROTTLE_MS);
  }));
  _unsubs.push(subscribe('case.caseRecord', () => { if (_container && getState('case.view') === 'progressive') scheduleRender(); }));
  _unsubs.push(subscribe('case.caseSummary', () => {
    if (!_container) return;
    const v = getState('case.view');
    if (v === 'progressive') updateProgressiveSummary();
    else if (v === 'streaming') updateStreamingSummary();
  }));
  _unsubs.push(subscribe('case.caseCompleteness', () => { if (_container && getState('case.view') === 'progressive') scheduleRender(); }));
  _unsubs.push(subscribe('case.detectedPts', () => { if (_container && getState('case.view') === 'progressive') scheduleRender(); }));
  _unsubs.push(subscribe('case.prodDocGap', () => { if (_container) { const v = getState('case.view'); if (v === 'progressive') scheduleRender(); else if (v === 'result') renderByView(); } }));
  _unsubs.push(subscribe('case.knownIssues', () => { if (_container) { const v = getState('case.view'); if (v === 'progressive') scheduleRender(); else if (v === 'streaming' || v === 'result') renderByView(); } }));
  _unsubs.push(subscribe('case.topArticles', () => {
    if (!_container) return;
    const view = getState('case.view');
    if (view === 'streaming') renderStreaming();
    else if (view === 'result' || view === 'progressive') renderByView();
  }));
  _unsubs.push(subscribe('case.suggestionDeltas', () => {
    if (!_container || getState('case.view') !== 'streaming') return;
    if (_streamThrottle) { _streamPending = true; return; }
    renderStreaming();
    _streamThrottle = setTimeout(() => {
      _streamThrottle = null;
      if (_streamPending) {
        _streamPending = false;
        if (_container && getState('case.view') === 'streaming') renderStreaming();
      }
    }, STREAM_RENDER_THROTTLE_MS);
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
  if (_renderRaf) { cancelAnimationFrame(_renderRaf); _renderRaf = null; }
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

function scheduleRender() {
  if (_renderRaf) return;
  _renderRaf = requestAnimationFrame(() => { _renderRaf = null; if (_container) renderByView(); });
}

function buildInlineSearch() {
  const input = h('input', { type: 'text', class: 'input', style: { flex: '1', fontSize: '12px', padding: '6px 12px' }, placeholder: 'New case #, ID, or URL…', id: 'case-inline-search' });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submitInlineSearch(); });
  const btn = h('button', { class: 'btn btn--primary btn--sm', onClick: () => submitInlineSearch() }, 'Analyze');
  const bar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flex: '1' } },
    input, btn
  );
  return bar;
}

function buildStopButton() {
  return h('button', { class: 'btn btn--ghost btn--sm', style: { width: '32px', height: '32px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '50%', border: '2px solid var(--error)', flexShrink: '0' }, title: 'Stop processing', onClick: stopProcessing },
    h('div', { style: { width: '10px', height: '10px', background: 'var(--error)', borderRadius: '2px' } })
  );
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

  _container.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 0 12px' } },
    buildInlineSearch(),
    buildStopButton()
  ));

  const progress = getState('case.progress') || { step: 0, label: 'Starting…' };
  const steps = ['Connecting', 'Fetching case + comments', 'Extracting intents', 'Searching knowledge base', 'Ranking + loading articles', 'Generating recommendation'];
  const pct = Math.max(5, Math.round(((progress.step + 1) / steps.length) * 100));

  const card = h('div', { class: 'card' },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '12px' } },
      h('span', { style: { fontWeight: '600', fontSize: '14px' } }, progress.caseNumber ? `Analyzing Case #${progress.caseNumber}` : 'Analyzing…'),
      h('span', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, `${progress.step + 1} / ${steps.length}`)
    ),
    progressBar(pct, 'default', true),
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

  _container.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 0 12px' } },
    buildInlineSearch(),
    buildStopButton()
  ));

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

  const summaryCard = h('div', { id: 'progressive-summary', class: 'card', style: { marginBottom: '12px', padding: '12px 16px', borderLeft: '3px solid var(--primary)' } },
    h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '6px' } }, 'Case Summary'),
    h('div', { class: 'summary-content' }, caseSummary ? renderMarkdown(caseSummary) : h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, streamingDots(), h('span', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Generating summary')))
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

  if (prodDocGap && prodDocGap.hasGap) {
    main.appendChild(renderProductDocGapCard(prodDocGap));
  }

  const progressCard = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px 16px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
      spinner('sm'),
      h('span', { style: { fontSize: '12px', color: 'var(--primary)', fontWeight: '500' } }, progress.label || 'Processing…')
    )
  );
  main.appendChild(progressCard);

  _container.appendChild(grid);
}

function updateProgressiveSummary() {
  const summaryEl = _container?.querySelector('#progressive-summary');
  const caseSummary = getState('case.caseSummary') || '';
  if (!summaryEl) {
    if (caseSummary) renderByView();
    return;
  }
  const contentEl = summaryEl.querySelector('.summary-content');
  if (contentEl) {
    contentEl.textContent = '';
    contentEl.appendChild(renderMarkdown(caseSummary));
  }
}

function updateStreamingSummary() {
  const summaryEl = _container?.querySelector('#streaming-summary');
  const caseSummary = getState('case.caseSummary') || '';
  if (!summaryEl) return;
  const contentEl = summaryEl.querySelector('.summary-content');
  if (contentEl) {
    contentEl.textContent = '';
    contentEl.appendChild(renderMarkdown(caseSummary));
  }
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
    const streamCaseStatus = getState('case.caseRecord')?.status;
    if (streamCaseStatus && !['Closed', 'Closed - Duplicate'].includes(streamCaseStatus)) {
      _container.appendChild(h('div', { style: { padding: '10px 14px', marginTop: '8px', marginBottom: '12px', background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '14px' } }, '⚠'),
        h('span', null, 'This case is still open. Root cause and resolution may change — treat generated content as preliminary.')
      ));
    }
    _container.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
      buildInlineSearch(),
      buildStopButton()
    ));
    const grid = buildResizableGrid();
    const sidebar = grid.querySelector('[data-role="sidebar"]');
    sidebar.id = 'case-stream-sidebar';
    const result = getState('case.result');
    if (result?.structured) {
      sidebar.appendChild(renderSidebarQuality(result.structured));
    } else {
      sidebar.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', fontSize: '12px', color: 'var(--primary)' } }, streamingDots(), h('span', null, 'Evaluating')));
    }
    sidebar.appendChild(renderSidebarArticles(topArticles));
    const knownIssues = getState('case.knownIssues') || [];
    if (knownIssues.length) sidebar.appendChild(renderSidebarKnownIssues(knownIssues));
    const productDocs = getState('case.productDocs') || [];
    if (productDocs.length) sidebar.appendChild(renderSidebarProductDocs(productDocs));
    mainEl = grid.querySelector('[data-role="main"]');
    mainEl.id = 'case-stream-main';

    const caseRecord = getState('case.caseRecord');
    if (caseRecord) {
      const completeness = getState('case.caseCompleteness');
      const detectedPts = getState('case.detectedPts') || [];
      const caseAbstract = getState('case.caseAbstract');
      mainEl.appendChild(renderCaseDetailsCard(caseRecord, completeness, detectedPts, caseAbstract));
    }

    const caseSummary = getState('case.caseSummary');
    mainEl.appendChild(h('div', { id: 'streaming-summary', class: 'card', style: { marginBottom: '12px', padding: '10px 14px', borderLeft: '3px solid var(--primary)' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '4px' } }, 'Case Summary'),
      h('div', { class: 'summary-content' }, caseSummary ? renderMarkdown(caseSummary) : h('span', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, 'Loading…'))
    ));

    const prodDocGap = getState('case.prodDocGap');
    if (prodDocGap && prodDocGap.hasGap) mainEl.appendChild(renderProductDocGapCard(prodDocGap));

    _container.appendChild(grid);
  } else {
    const sidebar = _container.querySelector('#case-stream-sidebar');
    if (sidebar) {
      sidebar.textContent = '';
      const result = getState('case.result');
      if (result?.structured) {
        sidebar.appendChild(renderSidebarQuality(result.structured));
      } else {
        sidebar.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', fontSize: '12px', color: 'var(--primary)' } }, streamingDots(), h('span', null, 'Evaluating')));
      }
      sidebar.appendChild(renderSidebarArticles(topArticles));
      const ki = getState('case.knownIssues') || [];
      if (ki.length) sidebar.appendChild(renderSidebarKnownIssues(ki));
      const productDocs = getState('case.productDocs') || [];
      if (productDocs.length) sidebar.appendChild(renderSidebarProductDocs(productDocs));
    }
  }

  if (suggestions.length) {
    const existingCards = mainEl.querySelectorAll('.sug-card-done');
    const grouped = groupByArticle(suggestions);
    const groupKeys = Object.keys(grouped);

    if (groupKeys.length > existingCards.length) {
      for (let i = existingCards.length; i < groupKeys.length; i++) {
        const key = groupKeys[i];
        const inProgress = mainEl.querySelector(`#sug-progress-${key}`);
        if (inProgress) inProgress.remove();
        const sugs = grouped[key];
        const card = (sugs[0]?.isFullRewrite) ? renderFullRewriteCard(sugs[0]) : renderArticleSuggestionCard(sugs);
        card.classList.add('sug-card-done');
        card.style.animation = 'fadeIn 0.3s ease-in';
        const loadingEl = mainEl.querySelector('#stream-loading');
        if (loadingEl) mainEl.insertBefore(card, loadingEl);
        else mainEl.appendChild(card);
      }
    }
  }

  for (const [articleId, deltaText] of Object.entries(suggestionDeltas)) {
    if (!deltaText) continue;
    let progressCard = mainEl.querySelector(`#sug-progress-${articleId}`);
    if (!progressCard) {
      const topArticle = topArticles.find(a => a.id === articleId);
      const articleNum = topArticle?.articleNumber || '';
      const articleTitle = topArticle?.title || '';
      progressCard = h('div', { id: `sug-progress-${articleId}`, class: 'card', style: { marginBottom: '12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border)' } },
          streamingDots(),
          h('a', { href: articleUrl(articleId), target: '_blank', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' } }, `#${articleNum}`),
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
      const fragment = document.createDocumentFragment();
      renderStreamingSuggestion(deltaText, fragment);
      contentEl.replaceChildren(fragment);
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  }

  if (streamText) {
    let draftEl = mainEl.querySelector('#stream-draft');
    if (!draftEl) {
      draftEl = h('div', { id: 'stream-draft', class: 'card', style: { marginBottom: '12px', padding: '16px' } },
        h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' } },
          streamingDots(),
          h('span', null, 'Drafting New Article')
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

  const hasActiveStreams = Object.keys(suggestionDeltas).length > 0 || streamText;
  let loadingEl = mainEl.querySelector('#stream-loading');
  if (hasActiveStreams && !loadingEl) {
    loadingEl = h('div', { id: 'stream-loading', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px', justifyContent: 'center' } },
      streamingDots(),
      h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, 'Generating')
    );
    mainEl.appendChild(loadingEl);
  } else if (!hasActiveStreams && !suggestions.length && !streamText) {
    if (!loadingEl) {
      loadingEl = h('div', { id: 'stream-loading', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', justifyContent: 'center' } },
        streamingDots(),
        h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, 'Generating recommendations')
      );
      mainEl.appendChild(loadingEl);
    }
  } else if (!hasActiveStreams && loadingEl) {
    loadingEl.remove();
  }
}

function renderStreamingSuggestion(text, container) {
  const cleaned = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

  if (cleaned.length < 20) {
    container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px' } }, streamingDots(), h('span', null, 'Generating')));
    return;
  }

  const title = extractStreamingField(cleaned, 'title');
  const summary = extractStreamingField(cleaned, 'summary');
  const changes = extractStreamingField(cleaned, 'changesSummary');
  const description = extractStreamingSectionBody(cleaned, 'Description');
  const resolution = extractStreamingSectionBody(cleaned, 'Resolution');

  const sections = [
    { name: 'Title', data: title },
    { name: 'Summary', data: summary },
    { name: 'Description', data: description },
    { name: 'Resolution', data: resolution }
  ];

  for (const { name, data } of sections) {
    const sec = h('div', { style: { marginBottom: '8px', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)' } });
    sec.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '600', color: 'var(--primary)', marginBottom: '3px', textTransform: 'uppercase' } }, name));

    if (data && data.value) {
      const text = data.value;
      if (name === 'Title') {
        sec.appendChild(h('div', { style: { fontSize: '12px', fontWeight: '600' } }, text.replace(/\n/g, ' ')));
      } else {
        const lines = text.split('\n').slice(0, 10);
        lines.forEach(line => {
          if (line.startsWith('- ')) sec.appendChild(h('div', { style: { paddingLeft: '6px', fontSize: '11px' } }, '• ' + line.slice(2)));
          else if (/^\d+\.\s/.test(line)) sec.appendChild(h('div', { style: { paddingLeft: '6px', fontSize: '11px' } }, line));
          else if (line.trim()) sec.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, line));
        });
        if (text.split('\n').length > 10) sec.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, '…'));
      }
      if (!data.complete) sec.appendChild(h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--primary)', fontSize: '10px', marginTop: '3px' } }, streamingDots(), h('span', null, 'streaming')));
    } else {
      const isWriting = (name === 'Summary' && title?.complete) || (name === 'Description' && summary?.complete) || (name === 'Resolution' && description);
      if (isWriting) {
        sec.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)', fontSize: '10px' } }, streamingDots(), h('span', null, 'Writing')));
      } else {
        sec.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Pending…'));
      }
    }
    container.appendChild(sec);
  }

  if (changes?.value) {
    container.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', borderTop: '1px solid var(--border)', paddingTop: '4px' } }, 'Changes: ' + changes.value));
  }
}

function renderStreamingDraft(text, container) {
  const cleaned = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

  if (cleaned.length < 20) {
    container.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '12px' } }, streamingDots(), h('span', null, 'Generating')));
    return;
  }

  const title = extractStreamingField(cleaned, 'title');
  const summary = extractStreamingField(cleaned, 'summary');
  const description = extractStreamingSectionBody(cleaned, 'Description');
  const resolution = extractStreamingSectionBody(cleaned, 'Resolution');

  const sections = [
    { name: 'Title', data: title },
    { name: 'Summary', data: summary },
    { name: 'Description', data: description },
    { name: 'Resolution', data: resolution }
  ];

  for (const { name, data } of sections) {
    const sec = h('div', { style: { marginBottom: '10px', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)' } });
    sec.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px', textTransform: 'uppercase' } }, name));

    if (data && data.value) {
      const text = data.value;
      if (name === 'Title') {
        sec.appendChild(h('div', { style: { fontSize: '14px', fontWeight: '700' } }, text.replace(/\n/g, ' ')));
      } else {
        const lines = text.split('\n');
        lines.forEach(line => {
          if (line.startsWith('## ')) sec.appendChild(h('h3', { style: { fontSize: '12px', fontWeight: '600', marginTop: '8px' } }, line.slice(3)));
          else if (line.startsWith('- ')) sec.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px' } }, '• ' + line.slice(2)));
          else if (/^\d+\.\s/.test(line)) sec.appendChild(h('div', { style: { paddingLeft: '12px', fontSize: '12px' } }, line));
          else if (line.trim()) sec.appendChild(h('p', { style: { margin: '3px 0', fontSize: '12px' } }, line));
        });
      }
      if (!data.complete) sec.appendChild(h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--primary)', fontSize: '10px', marginTop: '4px' } }, streamingDots(), h('span', null, 'streaming')));
    } else {
      const isWriting = (name === 'Summary' && title?.complete) || (name === 'Description' && summary?.complete) || (name === 'Resolution' && description);
      if (isWriting) {
        sec.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)', fontSize: '10px' } }, streamingDots(), h('span', null, 'Writing')));
      } else {
        sec.appendChild(h('div', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'Pending…'));
      }
    }
    container.appendChild(sec);
  }
}

function renderResult() {
  if (!_container) return;

  if (_sidebarOnly) {
    _sidebarOnly = false;
    const sidebar = _container.querySelector('[data-role="sidebar"]');
    if (sidebar) {
      sidebar.textContent = '';
      const result = getState('case.result');
      const structured = result?.structured || result || {};
      const topArticles = getState('case.topArticles') || [];
      sidebar.appendChild(renderSidebarQuality(structured));
      sidebar.appendChild(renderSidebarArticles(topArticles));
      const knownIssues = getState('case.knownIssues') || [];
      if (knownIssues.length) sidebar.appendChild(renderSidebarKnownIssues(knownIssues));
      const productDocs = getState('case.productDocs') || [];
      if (productDocs.length) sidebar.appendChild(renderSidebarProductDocs(productDocs));
    }
    return;
  }

  _container.textContent = '';
  _container.appendChild(buildInlineSearch());

  const caseStatus = getState('case.caseRecord')?.status;
  if (caseStatus && !['Closed', 'Closed - Duplicate'].includes(caseStatus)) {
    _container.appendChild(h('div', { style: { padding: '10px 14px', marginTop: '8px', marginBottom: '12px', background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { style: { fontSize: '14px' } }, '⚠'),
      h('span', null, 'This case is still open. Root cause and resolution may change — treat generated content as preliminary.')
    ));
  }

  const custWarning = getState('case.customizationWarning');
  if (custWarning?.isCustomerSpecific) {
    const indicators = (custWarning.indicators || []).slice(0, 3).join(', ');
    _container.appendChild(h('div', { style: { padding: '10px 14px', marginBottom: '12px', background: 'color-mix(in srgb, var(--error) 8%, transparent)', border: '1px solid var(--error)', borderRadius: 'var(--radius-sm)', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { style: { fontSize: '14px' } }, '⚙'),
      h('div', null,
        h('div', { style: { fontWeight: '600' } }, 'Customer-specific configuration detected'),
        h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' } }, indicators ? `Indicators: ${indicators}` : 'Generated article may not be suitable for public KB without generalization.')
      )
    ));
  }

  const ptWarning = getState('case.ptWarning');
  if (ptWarning) {
    _container.appendChild(h('div', { style: { padding: '10px 14px', marginBottom: '12px', background: 'color-mix(in srgb, var(--primary) 8%, transparent)', border: '1px solid var(--primary)', borderRadius: 'var(--radius-sm)', fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { style: { fontSize: '14px' } }, 'i'),
      h('span', null, ptWarning)
    ));
  }

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
              h('a', { href: articleUrl(a.id), target: '_blank', style: { color: 'var(--primary)', textDecoration: 'none' } }, `#${a.articleNumber} — ${a.title}`)
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
  } else {
    main.appendChild(h('div', { class: 'card', style: { marginBottom: '12px', padding: '10px 16px', border: '1px solid var(--success)', borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--success) 6%, transparent)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '12px', fontWeight: '600', color: 'var(--success)' } }, 'Product Documentation'),
        h('span', { class: 'pill pill--success', style: { fontSize: '10px' } }, 'Not a Candidate')
      ),
      h('p', { style: { fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0 0' } }, 'No product documentation update needed for this case scenario.')
    ));
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
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onClick: (e) => e.stopPropagation() },
        (() => { const ds = (getState('case.draftScores') || {})['new-draft']; const scoring = (getState('case.scoringInProgress') || []).includes('new-draft'); if (ds) return h('span', { class: `pill pill--${ds.overall >= 75 ? 'success' : ds.overall >= 50 ? 'warning' : 'error'}`, style: { fontSize: '10px' } }, `AF: ${ds.overall}`); if (scoring) return h('span', { class: 'pill pill--neutral', style: { fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' } }, streamingDots(), 'AF: scoring'); return h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, 'AF: …'); })(),
        h('button', { class: 'btn btn--ghost btn--sm', onClick: () => refineRewrite(draft) }, 'Refine'),
        h('button', { class: 'btn btn--primary btn--sm', onClick: () => publishArticle(draft, result) }, 'Create in ORGCS')
      )
    );
    draftCard.appendChild(draftHeader);

    if (!draftCollapsed) {
      const draftBody = h('div', { style: { padding: '14px 16px' } });
      draftBody.appendChild(renderEditableSection({ heading: 'Title', body: draft.title || 'Untitled' }, 0, 'draft'));
      draftBody.appendChild(renderEditableSection({ heading: 'Summary', body: draft.summary || '(No summary generated)' }, 1, 'draft'));
      const contentSections = (draft.sections || []).filter(s => !/summary/i.test(s.heading));
      const descSection = contentSections.find(s => /description|problem|overview/i.test(s.heading));
      const resSection = contentSections.find(s => /resolution|solution|fix|steps|workaround/i.test(s.heading));
      draftBody.appendChild(renderEditableSection({ heading: 'Description', body: descSection?.body || '(No description)' }, 2, 'draft'));
      draftBody.appendChild(renderEditableSection({ heading: 'Resolution', body: resSection?.body || '(No resolution)' }, 3, 'draft'));
      const otherSections = contentSections.filter(s => s !== descSection && s !== resSection);
      otherSections.forEach((sec, idx) => draftBody.appendChild(renderEditableSection(sec, idx + 4, 'draft')));
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
  if (caseRecord.severity) metaItems.push(['Severity', caseRecord.severity]);
  if (caseRecord.supportLevel) metaItems.push(['Support', caseRecord.supportLevel]);
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

  const ownerLabels = { SUPPORT_KB: 'Support KB Team', PRODUCT_DOCUMENTATION: 'Product Documentation (CX)', BOTH: 'Both Teams' };
  const ownerColors = { SUPPORT_KB: 'info', PRODUCT_DOCUMENTATION: 'warning', BOTH: 'neutral' };

  return h('div', { class: 'card', style: { marginBottom: '12px', border: `1px solid ${recColor}`, borderRadius: 'var(--radius-sm)', overflow: 'hidden', animation: 'fadeIn 0.3s ease-in' } },
    h('div', { style: { padding: '12px 16px', background: `color-mix(in srgb, ${recColor} 6%, transparent)` } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
        h('span', { style: { fontSize: '12px', fontWeight: '600', color: recColor } }, 'Product Documentation Assessment'),
        h('span', { class: `pill pill--${prodDocGap.recommendation === 'DOCS_SUFFICIENT' ? 'success' : prodDocGap.recommendation === 'DOCS_NEED_UPDATE' ? 'warning' : 'error'}`, style: { fontSize: '10px' } }, recLabel)
      ),
      h('p', { style: { fontSize: '12px', lineHeight: '1.5', color: 'var(--text-secondary)', margin: '0' } }, prodDocGap.assessment || ''),
      (prodDocGap.targetDoc || prodDocGap.suggestedContent) ? h('div', { style: { marginTop: '8px', padding: '8px 10px', background: 'var(--surface-raised)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border)' } },
        prodDocGap.targetDoc ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: prodDocGap.suggestedContent ? '6px' : '0', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '10px', fontWeight: '600', color: 'var(--text-muted)' } }, 'Doc to update:'),
          h('a', {
            href: prodDocGap.targetDoc.helpUrl || prodDocGap.targetDoc.url,
            target: '_blank', rel: 'noopener',
            style: { fontSize: '11px', color: 'var(--primary)', textDecoration: 'none', fontWeight: '500' }
          }, `${prodDocGap.targetDoc.title}${prodDocGap.targetDoc.articleNumber ? ` (#${prodDocGap.targetDoc.articleNumber})` : ''} ↗`)
        ) : null,
        prodDocGap.suggestedContent ? h('div', null,
          h('div', { style: { fontSize: '10px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '2px' } }, prodDocGap.recommendation === 'DOCS_MISSING' ? 'Suggested new content:' : 'Suggested addition:'),
          h('div', { style: { fontSize: '11px', lineHeight: '1.5', color: 'var(--text-primary)' } }, prodDocGap.suggestedContent)
        ) : null
      ) : null,
      prodDocGap.owner ? h('div', { style: { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-muted)' } }, 'Recommended Owner:'),
        h('span', { class: `pill pill--${ownerColors[prodDocGap.owner] || 'neutral'}`, style: { fontSize: '10px' } }, ownerLabels[prodDocGap.owner] || prodDocGap.owner),
        prodDocGap.ownerReason ? h('span', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, prodDocGap.ownerReason) : null
      ) : null
    )
  );
}


async function showComparisonModal(rewrite) {
  toast('Loading original article…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'FETCH_ARTICLE_PREVIEW', articleId: rewrite.articleId });
    if (!resp?.success) { toast(resp?.error || 'Failed to load original.', 'error'); return; }
    const original = resp.article;

    const rewriteSections = rewrite.sections || [];
    const descSection = rewriteSections.find(s => /description/i.test(s.heading));
    const resSection = rewriteSections.find(s => /resolution/i.test(s.heading));

    const labelEl = (text) => h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' } }, text);
    const scrollBox = (child) => h('div', { style: { maxHeight: '260px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '8px', fontSize: '12px', lineHeight: '1.5' } }, child);
    const htmlBox = (html) => {
      const el = h('div', { style: { maxHeight: '260px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '8px', fontSize: '12px', lineHeight: '1.5' } });
      el.innerHTML = html || '<span style="color:var(--text-muted)">(empty)</span>';
      return el;
    };
    const mdOrEmpty = (text) => (text || '').trim() ? renderMarkdown(text) : h('span', { style: { color: 'var(--text-muted)' } }, '(empty)');

    const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', maxHeight: '70vh', overflow: 'auto' } },
      h('div', null,
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--border)' } }, 'Original'),
        h('div', { style: { marginBottom: '12px' } },
          labelEl('Title'),
          h('div', { style: { fontSize: '13px', fontWeight: '600' } }, original.title || '(no title)')
        ),
        h('div', { style: { marginBottom: '12px' } },
          labelEl('Summary'),
          h('div', { style: { fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap' } }, original.summary || '(empty)')
        ),
        h('div', { style: { marginBottom: '12px' } }, labelEl('Description'), htmlBox(original.descriptionHtml)),
        h('div', { style: { marginBottom: '12px' } }, labelEl('Resolution'), htmlBox(original.resolutionHtml)),
        original.stepsHtml ? h('div', null, labelEl('Steps'), htmlBox(original.stepsHtml)) : null
      ),
      h('div', null,
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--primary)' } }, 'Rewritten'),
        h('div', { style: { marginBottom: '12px' } },
          labelEl('Title'),
          h('div', { style: { fontSize: '13px', fontWeight: '600', color: 'var(--primary)' } }, rewrite.title || '(no title)')
        ),
        h('div', { style: { marginBottom: '12px' } },
          labelEl('Summary'),
          h('div', { style: { fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap' } }, rewrite.summary || '(empty)')
        ),
        h('div', { style: { marginBottom: '12px' } }, labelEl('Description'), scrollBox(mdOrEmpty(descSection?.body))),
        h('div', null, labelEl('Resolution'), scrollBox(mdOrEmpty(resSection?.body)))
      )
    );

    modal(`Compare: #${rewrite.articleNumber}`, body, { wide: true });
  } catch (e) {
    toast('Comparison failed: ' + e.message, 'error');
  }
}

function renderSidebarKnownIssues(kiItems) {
  const isCollapsed = _collapsedSections['known-issues'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['known-issues'] = !_collapsedSections['known-issues']; _sidebarOnly = true; renderByView(); } },
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
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['articles'] = !_collapsedSections['articles']; _sidebarOnly = true; renderByView(); } },
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
        const artLink = a.url || articleUrl(a.id);
        const link = h('a', { href: artLink, target: '_blank', rel: 'noopener', style: { fontSize: '11px', fontWeight: '500', color: 'var(--text-primary)', lineHeight: '1.3', textDecoration: 'none', flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.title || 'Untitled');
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
          a.topicName ? h('div', { style: { fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.topicName) : null,
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
      data.descriptionHtml ? renderRichTextSection('Description', data.descriptionHtml) : (data.description ? h('div', { style: { marginBottom: '12px' } }, h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, 'Description'), renderMarkdown(data.description.slice(0, 2000))) : null),
      data.resolutionHtml ? renderRichTextSection('Resolution', data.resolutionHtml) : (data.resolution ? h('div', { style: { marginBottom: '12px' } }, h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, 'Resolution'), renderMarkdown(data.resolution.slice(0, 2000))) : null)
    );
    modal(data.title || article.title || 'Article Preview', body, { wide: true });
  } catch (e) {
    toast('Preview failed: ' + e.message, 'error');
  }
}

function renderRichTextSection(heading, html) {
  const section = h('div', { style: { marginBottom: '12px' } });
  section.appendChild(h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', marginBottom: '4px' } }, heading));
  const content = h('div', { style: { fontSize: '12px', lineHeight: '1.6', maxHeight: '400px', overflowY: 'auto', padding: '8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)' } });
  content.innerHTML = sanitizeHtml(html);
  section.appendChild(content);
  return section;
}

function sanitizeHtml(html) {
  const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'colspan', 'rowspan', 'width', 'height', 'scope', 'headers', 'id', 'name', 'type', 'value', 'align', 'valign', 'border', 'cellpadding', 'cellspacing']);
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,iframe,object,embed,form,input,link,meta,base').forEach(el => el.remove());
  div.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (!SAFE_ATTRS.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
    if (el.hasAttribute('style')) {
      const style = el.getAttribute('style');
      if (/expression|javascript|url\s*\(/i.test(style)) el.removeAttribute('style');
    }
  });
  return div.innerHTML;
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

  const draftScores = getState('case.draftScores') || {};
  const hasDraftScores = Object.keys(draftScores).length > 0;

  const topArticles = getState('case.topArticles') || [];
  const articlesWithKbScore = topArticles.filter(a => a.kbScore != null);
  const avgKbScore = articlesWithKbScore.length
    ? Math.round(articlesWithKbScore.reduce((s, a) => s + a.kbScore, 0) / articlesWithKbScore.length)
    : null;

  let readinessScore;
  if (hasDraftScores) {
    const draftVals = Object.values(draftScores).map(s => s.overall).filter(v => v != null);
    readinessScore = draftVals.length ? Math.round(draftVals.reduce((a, b) => a + b, 0) / draftVals.length) : 0;
  } else {
    const confidenceScore = structured.confidence === 'HIGH' ? 90 : structured.confidence === 'MEDIUM' ? 60 : 30;
    const actionScore = structured.action === 'NO_ACTION' ? 95 : structured.action === 'UPDATE_EXISTING' ? 70 : structured.action === 'CREATE_NEW' ? 40 : 55;
    readinessScore = avgKbScore != null
      ? Math.round((avgKbScore * 0.4) + (confidenceScore * 0.3) + (actionScore * 0.3))
      : Math.round((confidenceScore * 0.5) + (actionScore * 0.5));
  }
  const scoreColor = readinessScore >= 75 ? 'var(--success)' : readinessScore >= 50 ? 'var(--warning)' : 'var(--error)';
  const scoreLabel = readinessScore >= 75 ? 'AGF Ready' : readinessScore >= 50 ? 'Needs Work' : 'Not Ready';

  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['quality'] = !_collapsedSections['quality']; _sidebarOnly = true; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
      h('span', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.5px' } }, 'AF Readiness'),
      h('span', { style: { fontSize: '14px', fontWeight: '700', color: scoreColor } }, `${readinessScore}`)
    ),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼')
  );
  section.appendChild(header);

  if (!isCollapsed) {
    const body = h('div', { style: { fontSize: '11px' } });

    const barOuter = h('div', { style: { width: '100%', height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden', marginBottom: '10px' } });
    barOuter.appendChild(h('div', { style: { width: `${readinessScore}%`, height: '100%', background: scoreColor, borderRadius: '3px', transition: 'width 0.3s' } }));
    body.appendChild(barOuter);
    body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' } },
      h('span', { style: { color: scoreColor, fontWeight: '600' } }, scoreLabel),
      h('span', { style: { color: 'var(--text-muted)' } }, `${readinessScore}/100`)
    ));

    const items = [];

    if (hasDraftScores) {
      items.push(['— Generated Content —', '']);
      const result = getState('case.result');
      const suggestions = result?.structured?.suggestions || [];
      for (const [key, scoreData] of Object.entries(draftScores)) {
        let label = 'New Article';
        if (key !== 'new-draft') {
          const artId = key.replace('rewrite-', '');
          const sug = suggestions.find(s => s.articleId === artId);
          label = `Rewrite #${sug?.articleNumber || artId.slice(0, 8)}`;
        }
        items.push([label, `${scoreData.overall}/100`]);
      }
      items.push(['', '']);
      items.push(['— Existing Coverage —', '']);
    }

    items.push(['Action', formatAction(structured.action)]);
    items.push(['Confidence', structured.confidence || 'N/A']);
    if (avgKbScore != null) items.push(['Existing Avg', `${avgKbScore}/100`]);
    if (!hasDraftScores) {
      items.push(['Articles Found', String(topArticles.length)]);
    }

    items.forEach(([label, value]) => {
      if (!label && !value) { body.appendChild(h('div', { style: { height: '6px' } })); return; }
      if (label.startsWith('—')) {
        body.appendChild(h('div', { style: { fontSize: '9px', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase', padding: '4px 0 2px', letterSpacing: '0.3px' } }, label.replace(/—/g, '').trim()));
        return;
      }
      const valueColor = label === 'Confidence' ? (value === 'HIGH' ? 'var(--success)' : value === 'MEDIUM' ? 'var(--warning)' : 'var(--error)') : 'var(--text-primary)';
      body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid var(--border)' } },
        h('span', { style: { color: 'var(--text-muted)' } }, label),
        h('span', { style: { fontWeight: '500', color: valueColor } }, value)
      ));
    });

    if (hasDraftScores) {
      body.appendChild(h('div', { style: { marginTop: '8px' } },
        h('button', { class: 'btn btn--ghost btn--sm', style: { width: '100%', fontSize: '10px' }, onClick: () => showScoreInsights(draftScores) }, 'View Insights')
      ));
    }

    section.appendChild(body);
  }
  return section;
}



function renderSidebarProductDocs(docs) {
  const isCollapsed = _collapsedSections['product-docs'] || false;
  const section = h('div', { style: { marginBottom: '16px' } });
  const header = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' }, onClick: () => { _collapsedSections['product-docs'] = !_collapsedSections['product-docs']; _sidebarOnly = true; renderByView(); } },
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
      const scoreColor = d._relevanceScore >= 70 ? 'var(--success)' : d._relevanceScore >= 50 ? 'var(--warning)' : 'var(--text-muted)';
      body.appendChild(h('div', { style: { padding: '5px 0', borderBottom: '1px solid var(--border)' } },
        link,
        d.summary ? h('div', { style: { fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: '1.3' } }, d.summary.slice(0, 120)) : null,
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', marginTop: '3px' } },
          d._relevanceScore ? h('span', { style: { fontSize: '9px', fontWeight: '600', color: scoreColor } }, `${d._relevanceScore}%`) : null,
          h('span', { class: 'pill pill--info', style: { fontSize: '9px' } }, 'Product Doc')
        )
      ));
    });
    section.appendChild(body);
  }
  return section;
}


function renderArticleSuggestionCard(sugs) {
  const articleNumber = sugs[0].articleNumber;
  const articleTitle = sugs[0].articleTitle;
  const articleId = sugs[0].articleId;
  const artLink = articleUrl(articleId);
  const collapseKey = `sug-${articleId}`;
  const isCollapsed = _collapsedSections[collapseKey] || false;

  const card = h('div', { class: 'card', style: { marginBottom: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  const collapseIcon = h('span', { style: { fontSize: '10px', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px' } }, isCollapsed ? '▶' : '▼');
  const cardHeader = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface-raised)', borderBottom: isCollapsed ? 'none' : '1px solid var(--border)', cursor: 'pointer' }, onClick: () => { _collapsedSections[collapseKey] = !_collapsedSections[collapseKey]; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      collapseIcon,
      h('a', { href: artLink, target: '_blank', rel: 'noopener', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' }, onClick: (e) => e.stopPropagation() }, `#${articleNumber}`),
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
  const rewriteLink = articleUrl(rewrite.articleId);
  const collapseKey = `rewrite-${rewrite.articleId}`;
  const isCollapsed = _collapsedSections[collapseKey] || false;

  const card = h('div', { class: 'card', style: { marginBottom: '16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' } });

  const cardHeader = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'var(--surface-raised)', borderBottom: isCollapsed ? 'none' : '1px solid var(--border)', cursor: 'pointer' }, onClick: () => { _collapsedSections[collapseKey] = !_collapsedSections[collapseKey]; renderByView(); } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, isCollapsed ? '▶' : '▼'),
      h('span', { class: 'pill pill--warning', style: { fontSize: '10px' } }, 'REWRITE'),
      h('a', { href: rewriteLink, target: '_blank', rel: 'noopener', style: { fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--primary)', textDecoration: 'none', fontWeight: '600' }, onClick: (e) => e.stopPropagation() }, `#${rewrite.articleNumber}`),
      h('span', { style: { fontSize: '13px', fontWeight: '500', color: 'var(--text-primary)' } }, rewrite.title || rewrite.articleTitle)
    ),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' }, onClick: (e) => e.stopPropagation() },
      (() => { const key = `rewrite-${rewrite.articleId}`; const ds = (getState('case.draftScores') || {})[key]; const scoring = (getState('case.scoringInProgress') || []).includes(key); if (ds) return h('span', { class: `pill pill--${ds.overall >= 75 ? 'success' : ds.overall >= 50 ? 'warning' : 'error'}`, style: { fontSize: '10px' } }, `AF: ${ds.overall}`); if (scoring) return h('span', { class: 'pill pill--neutral', style: { fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '4px' } }, streamingDots(), 'AF: scoring'); return h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, 'AF: …'); })(),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => refineRewrite(rewrite) }, 'Refine'),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => showComparisonModal(rewrite) }, 'Compare'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: () => publishUpdate(rewrite, getState('case.result')) }, 'Create New Version in ORGCS')
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
    body.appendChild(renderEditableSection({ heading: 'Summary', body: rewrite.summary || '(No summary)' }, 1, prefix));
    const contentSections = (rewrite.sections || []).filter(s => !/summary/i.test(s.heading));
    const descSection = contentSections.find(s => /description|problem|overview/i.test(s.heading));
    const resSection = contentSections.find(s => /resolution|solution|fix|steps|workaround/i.test(s.heading));
    body.appendChild(renderEditableSection({ heading: 'Description', body: descSection?.body || '(No description)' }, 2, prefix));
    body.appendChild(renderEditableSection({ heading: 'Resolution', body: resSection?.body || '(No resolution)' }, 3, prefix));
    const otherSections = contentSections.filter(s => s !== descSection && s !== resSection);
    otherSections.forEach((sec, idx) => body.appendChild(renderEditableSection(sec, idx + 4, prefix)));
    card.appendChild(body);
  }

  return card;
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
  toast('Creating new draft version in ORGCS…', 'info');
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
      const actionLabel = resp.action === 'patched-draft' ? 'Existing draft updated!' : 'New draft version created!';
      toast(actionLabel, 'success');
      if (resp.warning) toast(resp.warning, 'warning');
      if (resp.url) {
        setState('case.publishedUrl', resp.url);
        renderByView();
      }
    } else {
      toast(resp?.error || 'Failed to create draft version.', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function renderEditableSection(sec, idx, prefix) {
  const id = `${prefix}-section-${idx}`;
  const isEditing = _editingSections.has(id);
  const container = h('div', { style: { marginBottom: '12px', borderBottom: '1px solid var(--border)', paddingBottom: '12px' } });

  const headerRow = h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '6px' } },
    h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.3px', flex: '1' } }, sec.heading || 'Section'),
    h('button', { class: `btn btn--ghost btn--sm`, style: { fontSize: '10px', padding: '2px 6px', opacity: '0.7' }, onClick: () => toggleEdit(id, sec) }, isEditing ? 'Done' : 'Edit'),
    h('button', { class: 'btn btn--ghost btn--sm', style: { fontSize: '10px', padding: '2px 6px', color: 'var(--primary)', opacity: '0.7' }, onClick: () => refineSection(sec) }, 'Refine')
  );
  container.appendChild(headerRow);

  if (isEditing) {
    const textarea = h('textarea', { id, class: 'input', style: { width: '100%', minHeight: '120px', fontSize: '12px', lineHeight: '1.6', fontFamily: 'inherit', border: '2px solid var(--primary)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', resize: 'vertical' } });
    textarea.value = sec.body || '';
    textarea.addEventListener('input', () => { sec.body = textarea.value; });
    container.appendChild(textarea);
  } else {
    const contentArea = h('div', { id, style: { fontSize: '12px', lineHeight: '1.7', color: 'var(--text-primary)' } });
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

function refineRewrite(rewrite) {
  const sectionsText = (rewrite.sections || []).map(s => `## ${s.heading}\n${s.body}`).join('\n\n');
  const fullContent = `Title: ${rewrite.title || ''}\nSummary: ${rewrite.summary || ''}\n\n${sectionsText}`;

  const inputEl = h('input', { type: 'text', class: 'input', placeholder: 'Focus on… (e.g. "make more generic", "add steps", "simplify resolution")', style: { width: '100%', marginBottom: '12px' } });
  const bodyEl = h('div', null,
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' } }, `Refining entire article: ${rewrite.title || rewrite.articleTitle || ''}`),
    h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' } }, `${(rewrite.sections || []).length} sections will be re-generated with your focus applied.`),
    inputEl,
    h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
      h('button', { class: 'btn btn--primary btn--sm', onClick: doRefine }, 'Refine Article')
    )
  );
  const { close } = modal('Refine Article', bodyEl);
  inputEl.focus();
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRefine(); });

  async function doRefine() {
    const focus = inputEl.value.trim();
    close();
    toast('Refining article…', 'info');
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'REFINE_SECTION',
        content: fullContent,
        title: rewrite.title || rewrite.articleTitle || '',
        focus
      });
      if (resp?.success && resp.refined) {
        const lines = resp.refined.split('\n');
        let newTitle = rewrite.title;
        let newSummary = rewrite.summary;
        const newSections = [];
        let currentHeading = null;
        let currentBody = [];

        for (const line of lines) {
          if (line.startsWith('## ')) {
            if (currentHeading) newSections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
            currentHeading = line.slice(3).trim();
            currentBody = [];
          } else if (line.startsWith('Title: ') && !currentHeading) {
            newTitle = line.slice(7).trim();
          } else if (line.startsWith('Summary: ') && !currentHeading) {
            newSummary = line.slice(9).trim();
          } else {
            currentBody.push(line);
          }
        }
        if (currentHeading) newSections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });

        rewrite.title = newTitle || rewrite.title;
        rewrite.summary = newSummary || rewrite.summary;
        if (newSections.length) rewrite.sections = newSections;
        const refKey = rewrite.articleId ? `rewrite-${rewrite.articleId}` : 'new-draft';
        const draftScores = { ...(getState('case.draftScores') || {}) };
        if (refKey in draftScores) {
          delete draftScores[refKey];
          setState('case.draftScores', draftScores);
        }
        renderByView();
        toast('Article refined.', 'success');
      } else {
        toast(resp?.error || 'Refine failed.', 'error');
      }
    } catch (e) {
      toast('Refine error: ' + e.message, 'error');
    }
  }
}

function showScoreInsights(draftScores) {
  const content = h('div', null);
  for (const [key, scoreData] of Object.entries(draftScores)) {
    const label = key === 'new-draft' ? 'New Article Draft' : `Rewrite ${key.replace('rewrite-', '#')}`;
    const scoreColor = scoreData.overall >= 75 ? 'var(--success)' : scoreData.overall >= 50 ? 'var(--warning)' : 'var(--error)';
    const articleSection = h('div', { style: { marginBottom: '16px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
        h('span', { style: { fontWeight: '600', fontSize: '13px' } }, label),
        h('span', { style: { fontWeight: '700', fontSize: '14px', color: scoreColor } }, `${scoreData.overall}/100`)
      )
    );
    if (scoreData.criteria?.length) {
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: '11px' } });
      for (const c of scoreData.criteria) {
        if (c.na) continue;
        const cColor = c.score >= c.max * 0.8 ? 'var(--success)' : c.score >= c.max * 0.5 ? 'var(--warning)' : 'var(--error)';
        grid.appendChild(h('span', { style: { color: 'var(--text-secondary)' } }, c.label || c.id));
        grid.appendChild(h('span', { style: { fontWeight: '500', color: cColor, textAlign: 'right' } }, `${c.score}/${c.max}`));
        if (c.issues?.length) {
          grid.appendChild(h('div', { style: { gridColumn: '1 / -1', paddingLeft: '8px', color: 'var(--error)', fontSize: '10px', marginBottom: '2px' } }, c.issues.join('; ')));
        }
      }
      articleSection.appendChild(grid);
    }
    content.appendChild(articleSection);
  }
  modal('AF Readiness Insights', content, { wide: true });
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

  if (newAction === 'CREATE_NEW') {
    const caseRecord = getState('case.caseRecord');
    const caseId = caseRecord?.id || result?.caseId;
    if (!caseId) { toast('No case ID available.', 'error'); return; }
    triggerNewArticleGeneration(caseId);
    return;
  }

  const newStructured = {
    ...(result.structured || {}),
    action: newAction,
    summary: `User override: Suggesting updates.`
  };
  setState('case.result', { ...result, structured: newStructured });
  renderByView();
}

function triggerNewArticleGeneration(caseId) {
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }

  setState('case.view', 'streaming');
  setState('case.streamText', '');
  setState('case.suggestions', []);
  setState('case.suggestionDeltas', {});
  setState('case.progress', { step: 0, label: 'Generating new article…' });

  _port = chrome.runtime.connect({ name: 'kba-analyze' });
  _port.postMessage({ action: 'GENERATE_NEW_ARTICLE', caseId });
  _port.onMessage.addListener((msg) => {
    if (msg.type === 'delta') {
      setState('case.streamText', (getState('case.streamText') || '') + msg.chunk);
    } else if (msg.type === 'streaming-start') {
      setState('case.streamText', '');
    } else if (msg.type === 'result') {
      const existingResult = getState('case.result') || {};
      setState('case.result', { ...existingResult, structured: msg.structured });
      setState('case.view', 'result');
    } else if (msg.type === 'meta') {
      if (msg.draftScore) {
        const scores = getState('case.draftScores') || {};
        scores[msg.draftScore.key] = msg.draftScore.score;
        setState('case.draftScores', { ...scores });
      }
      if (msg.scoringInProgress) setState('case.scoringInProgress', msg.scoringInProgress);
    } else if (msg.type === 'error') {
      toast(msg.error, 'error');
      setState('case.view', 'result');
    }
  });
  _port.onDisconnect.addListener(() => {
    _port = null;
    if (getState('case.view') === 'streaming') {
      toast('Connection lost during generation.', 'error');
      setState('case.view', 'result');
    }
  });
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
let _retryCount = 0;
const MAX_AUTO_RETRIES = 1;

function startAnalysis(caseId, isRetry = false) {
  if (_port) { try { _port.disconnect(); } catch {} _port = null; }
  if (!isRetry) {
    _retryCount = 0;
    _sidebarOnly = false;
    _editingSections.clear();
  }
  const gen = ++_analysisGen;
  setState('case.view', 'analyzing');
  setState('case.progress', { step: 0, label: isRetry ? 'Reconnecting…' : 'Connecting…' });
  setState('case.result', null);
  setState('case.streamText', '');
  setState('case.topArticles', null);
  setState('case.suggestions', []);
  setState('case.suggestionDeltas', {});
  setState('case.caseSummary', null);
  setState('case.gusItems', null);
  setState('case.productDocs', null);
  setState('case.prodDocGap', null);
  setState('case.caseRecord', null);
  setState('case.caseCompleteness', null);
  setState('case.detectedPts', null);
  setState('case.caseAbstract', null);
  setState('case.knownIssues', null);
  setState('case.publishedUrl', null);
  setState('case.draftScores', null);
  setState('case.scoringInProgress', null);

  _port = chrome.runtime.connect({ name: 'kba-analyze' });
  _port.postMessage({ action: 'ANALYZE_CASE', caseId });
  _port.onMessage.addListener(onPortMessage);
  _port.onDisconnect.addListener(() => {
    if (gen !== _analysisGen) return;
    _port = null;
    const view = getState('case.view');
    if (view === 'analyzing' || view === 'progressive' || view === 'streaming') {
      const suggestions = getState('case.suggestions') || [];
      const lastStep = getState('case.progress')?.label || 'unknown';
      const disconnectReason = chrome.runtime.lastError?.message || 'service worker terminated';

      if (suggestions.length) {
        setState('case.result', { structured: { action: 'UPDATE_EXISTING', confidence: 'LOW', summary: 'Connection lost. Showing partial results.', suggestions }, caseNumber: getState('case.progress')?.caseNumber, subject: '' });
        setState('case.view', 'result');
      } else if (_retryCount < MAX_AUTO_RETRIES) {
        _retryCount++;
        toast(`Connection dropped at "${lastStep}". Retrying…`, 'info');
        setTimeout(() => {
          if (gen === _analysisGen) startAnalysis(caseId, true);
        }, 1500);
      } else {
        toast(`Analysis failed — disconnected at "${lastStep}" (${disconnectReason}). Try again.`, 'error');
        setState('case.view', 'idle');
      }
    }
  });
}

function onPortMessage(msg) {
  if (msg.type === 'keepalive') return;
  switch (msg.type) {
    case 'progress':
      setState('case.progress', { ...getState('case.progress'), step: msg.step ?? 0, label: msg.label || '', caseNumber: msg.caseNumber || getState('case.progress')?.caseNumber });
      break;
    case 'stopped': {
      const hasSuggestions = (getState('case.suggestions') || []).length > 0;
      const hasResult = !!getState('case.result');
      if (hasSuggestions || hasResult) {
        if (!hasResult) {
          setState('case.result', { structured: { action: 'UPDATE_EXISTING', confidence: 'LOW', summary: 'Stopped early. Showing partial results.', suggestions: getState('case.suggestions') || [] }, caseNumber: getState('case.caseRecord')?.caseNumber || '', subject: getState('case.caseRecord')?.subject || '' });
        }
        setState('case.view', 'result');
        toast('Processing stopped. Showing partial results.', 'info');
      } else {
        setState('case.view', 'idle');
        toast('Processing stopped. No results generated yet.', 'info');
      }
      break;
    }
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
      if (msg.prodDocGap) setState('case.prodDocGap', msg.prodDocGap);
      if (msg.customizationWarning) setState('case.customizationWarning', msg.customizationWarning);
      if (msg.ptWarning) setState('case.ptWarning', msg.ptWarning);
      if (msg.knownIssues) setState('case.knownIssues', msg.knownIssues);
      if (msg.scoringInProgress) {
        setState('case.scoringInProgress', msg.scoringInProgress);
        if (getState('case.view') === 'result') renderByView();
      }
      if (msg.draftScore) {
        const scores = getState('case.draftScores') || {};
        const inProgress = (getState('case.scoringInProgress') || []).filter(k => k !== msg.draftScore.key);
        setState('case.draftScores', { ...scores, [msg.draftScore.key]: msg.draftScore.score });
        setState('case.scoringInProgress', inProgress.length ? inProgress : null);
        if (getState('case.view') === 'result') renderByView();
      }
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
