import { h, spinner, emptyState, toast, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { localGet, localSet } from '../shared/storage.js';

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

