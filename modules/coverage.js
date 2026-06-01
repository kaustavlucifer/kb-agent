import { h, spinner, emptyState, toast, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { callClaude, extractText, extractJson } from '../shared/gateway.js';
import { SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, PT_HIGH_VOLUME_CONVS, PT_MID_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _clusters = null;

export function mount(container) {
  _container = container;
  if (!_clusters) loadClusters();
  renderCoverage();
  _unsubs.push(subscribe('coverage.analysis', renderCoverage));
  _unsubs.push(subscribe('kb.articles', renderCoverage));
}

export function unmount() {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _container = null;
}

async function loadClusters() {
  try {
    const url = chrome.runtime.getURL('data/pt_clusters.json');
    const resp = await fetch(url);
    _clusters = await resp.json();
    renderCoverage();
  } catch (e) {
    toast('Failed to load P&T clusters: ' + e.message, 'error');
  }
}

function renderCoverage() {
  if (!_container) return;
  _container.textContent = '';

  const articles = getState('kb.articles') || [];
  const analysis = getState('coverage.analysis');

  const toolbar = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } },
      _clusters ? `${Object.keys(_clusters).length} clusters loaded` : 'Loading clusters…'
    ),
    h('button', { class: 'btn btn--primary btn--sm', onClick: runAnalysis, disabled: !_clusters || !articles.length }, 'Analyze Coverage')
  );
  _container.appendChild(toolbar);

  if (!_clusters) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('md')));
    return;
  }

  if (!articles.length) {
    _container.appendChild(emptyState('📊', 'Load articles in the KB Articles tab first, then analyze coverage.'));
    return;
  }

  if (analysis) {
    renderAnalysisResults(analysis);
  } else {
    renderClusterTable();
  }
}

function renderClusterTable() {
  if (!_clusters || !_container) return;
  const articles = getState('kb.articles') || [];
  const entries = Object.entries(_clusters);

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Cluster'),
      h('th', null, 'Conversations'),
      h('th', null, 'Articles'),
      h('th', null, 'Coverage')
    )),
    h('tbody', null)
  );

  const tbody = table.querySelector('tbody');
  entries.sort((a, b) => (b[1].conversations || 0) - (a[1].conversations || 0));

  entries.slice(0, 50).forEach(([name, cluster]) => {
    const convs = cluster.conversations || 0;
    const keywords = (cluster.keywords || []).map(k => k.toLowerCase());
    const matched = articles.filter(a => {
      const text = `${a.title || ''} ${a.summary || ''}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
    const count = matched.length;
    const coverage = count >= PT_LOW_COVERAGE_ARTICLES ? 'good' : count > 0 ? 'partial' : 'gap';

    tbody.appendChild(h('tr', null,
      h('td', { style: { fontWeight: '500' } }, name),
      h('td', null,
        h('span', { class: `pill pill--${convs >= PT_HIGH_VOLUME_CONVS ? 'error' : convs >= PT_MID_VOLUME_CONVS ? 'warning' : 'info'}` }, String(convs))
      ),
      h('td', null, String(count)),
      h('td', null,
        h('span', { class: `pill pill--${coverage === 'good' ? 'success' : coverage === 'partial' ? 'warning' : 'error'}` },
          coverage === 'good' ? 'Good' : coverage === 'partial' ? 'Partial' : 'Gap'
        )
      )
    ));
  });

  _container.appendChild(table);
}

function renderAnalysisResults(analysis) {
  if (!_container) return;
  if (analysis.narrative) {
    _container.appendChild(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '4px' } }, 'Coverage Summary'),
      h('div', { style: { fontSize: '13px', whiteSpace: 'pre-wrap', lineHeight: '1.5' } }, analysis.narrative)
    ));
  }

  if (analysis.gaps?.length) {
    const gapTable = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Cluster'),
        h('th', null, 'Convs'),
        h('th', null, 'Coverage'),
        h('th', null, 'Gap Note'),
        h('th', null, 'Priority')
      )),
      h('tbody', null)
    );
    const tbody = gapTable.querySelector('tbody');
    analysis.gaps.forEach(g => {
      tbody.appendChild(h('tr', null,
        h('td', { style: { fontWeight: '500' } }, g.cluster || ''),
        h('td', null, String(g.conversations || 0)),
        h('td', null, h('span', { class: `pill pill--${g.coverage === 'good' ? 'success' : g.coverage === 'partial' ? 'warning' : 'error'}` }, g.coverage || 'gap')),
        h('td', { style: { fontSize: '12px' } }, g.note || ''),
        h('td', null, h('span', { class: `pill pill--${g.priority === 'high' ? 'error' : g.priority === 'medium' ? 'warning' : 'info'}` }, g.priority || ''))
      ));
    });
    _container.appendChild(gapTable);
  }
}

async function runAnalysis() {
  if (!_clusters) return;
  const articles = getState('kb.articles') || [];
  const entries = Object.entries(_clusters);

  const gaps = [];
  entries.forEach(([name, cluster]) => {
    const keywords = (cluster.keywords || []).map(k => k.toLowerCase());
    const matched = articles.filter(a => {
      const text = `${a.title || ''} ${a.summary || ''}`.toLowerCase();
      return keywords.some(kw => text.includes(kw));
    });
    const convs = cluster.conversations || 0;
    const count = matched.length;
    const coverage = count >= PT_LOW_COVERAGE_ARTICLES ? 'good' : count > 0 ? 'partial' : 'gap';
    if (coverage !== 'good') {
      gaps.push({ cluster: name, conversations: convs, articleCount: count, coverage, priority: convs >= PT_HIGH_VOLUME_CONVS ? 'high' : convs >= PT_MID_VOLUME_CONVS ? 'medium' : 'low' });
    }
  });
  gaps.sort((a, b) => b.conversations - a.conversations);

  let narrative = `Found ${gaps.length} coverage gaps across ${entries.length} clusters. ${gaps.filter(g => g.priority === 'high').length} high-priority gaps need immediate attention.`;
  try {
    const resp = await callClaude({
      system: 'Summarize KB coverage gaps for a support team. Be concise and actionable.',
      messages: [{ role: 'user', content: `Gaps found:\n${gaps.slice(0, 20).map(g => `- ${g.cluster}: ${g.conversations} convs, ${g.articleCount} articles (${g.coverage})`).join('\n')}` }],
      maxTokens: 1000,
      temperature: 0.2
    });
    narrative = extractText(resp) || narrative;
  } catch {}

  setState('coverage.analysis', { narrative, gaps: gaps.slice(0, 30) });
  toast(`Coverage analysis complete: ${gaps.length} gaps found.`, 'info');
}

export async function handleCoverage(port, msg) {
  port.postMessage({ type: 'progress', label: 'Analyzing coverage…' });
  try {
    const articles = msg.articles || [];
    const clusters = msg.clusters || {};
    const entries = Object.entries(clusters);
    const gaps = [];

    entries.forEach(([name, cluster]) => {
      const keywords = (cluster.keywords || []).map(k => k.toLowerCase());
      const matched = articles.filter(a => {
        const text = `${a.title || ''} ${a.summary || ''}`.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
      const convs = cluster.conversations || 0;
      const count = matched.length;
      if (count < PT_LOW_COVERAGE_ARTICLES) {
        gaps.push({ cluster: name, conversations: convs, articleCount: count, coverage: count > 0 ? 'partial' : 'gap', priority: convs >= PT_HIGH_VOLUME_CONVS ? 'high' : 'medium' });
      }
    });

    port.postMessage({ type: 'done', gaps });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}
