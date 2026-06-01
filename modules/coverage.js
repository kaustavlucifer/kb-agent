import { h, spinner, emptyState, toast, progressBar } from '../shared/ui.js';
import { setState, getState, subscribe } from '../shared/state.js';
import { streamClaude, callClaude, extractText, extractJson } from '../shared/gateway.js';
import { stripHtml } from '../shared/api.js';
import { PT_HIGH_VOLUME_CONVS, PT_MID_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../shared/config.js';

let _container = null;
let _unsubs = [];
let _clusters = null;

export function mount(container) {
  _container = container;
  if (!_clusters) loadClusters();
  else renderView();
  _unsubs.push(subscribe('coverage.analysis', renderView));
  _unsubs.push(subscribe('coverage.running', renderView));
  _unsubs.push(subscribe('kb.articles', renderView));
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
    renderView();
  } catch (e) {
    toast('Failed to load P&T clusters: ' + e.message, 'error');
  }
}

function renderView() {
  if (!_container) return;
  _container.textContent = '';
  const articles = getState('kb.articles') || [];
  const analysis = getState('coverage.analysis');
  const running = getState('coverage.running');

  const toolbar = h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
    h('div', { style: { fontSize: '12px', color: 'var(--text-secondary)' } },
      !_clusters ? 'Loading clusters…'
        : `${Object.keys(_clusters).length} P&T clusters · ${articles.length} articles`
    ),
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'btn btn--secondary btn--sm', onClick: () => { setState('coverage.analysis', null); renderView(); }, disabled: !analysis }, 'Reset'),
      h('button', { class: 'btn btn--primary btn--sm', onClick: runFullAnalysis, disabled: running || !_clusters || !articles.length },
        running ? 'Analyzing…' : 'Analyze Coverage'
      )
    )
  );
  _container.appendChild(toolbar);

  if (running) {
    _container.appendChild(h('div', { class: 'card', style: { padding: '12px', marginBottom: '12px' } },
      h('div', { style: { fontSize: '12px', marginBottom: '6px' } }, running.label || 'Analyzing…'),
      progressBar(running.pct || 0, 'default')
    ));
    return;
  }

  if (!_clusters) {
    _container.appendChild(h('div', { style: { textAlign: 'center', padding: '32px' } }, spinner('md')));
    return;
  }

  if (!articles.length) {
    _container.appendChild(emptyState('📊', 'Load articles in the KB Articles tab first, then analyze coverage.'));
    return;
  }

  if (analysis) {
    renderAnalysis(analysis);
  } else {
    renderQuickTable();
  }
}

function renderQuickTable() {
  const articles = getState('kb.articles') || [];
  const entries = Object.entries(_clusters)
    .map(([name, data]) => {
      const keywords = (data.keywords || []).map(k => k.toLowerCase());
      const convs = data.conversations || 0;
      const matched = articles.filter(a => {
        const text = `${a.title || ''} ${a.summary || ''} ${a.topicName || ''}`.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
      const count = matched.length;
      const coverage = count >= PT_LOW_COVERAGE_ARTICLES ? 'good' : count > 0 ? 'partial' : 'gap';
      return { name, convs, count, coverage, keywords };
    })
    .sort((a, b) => b.convs - a.convs);

  const gaps = entries.filter(e => e.coverage !== 'good');
  const summaryStats = h('div', { class: 'card', style: { marginBottom: '12px', padding: '12px' } },
    h('div', { style: { display: 'flex', gap: '24px', fontSize: '12px' } },
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--success)' } }, String(entries.filter(e => e.coverage === 'good').length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Covered')
      ),
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--warning)' } }, String(entries.filter(e => e.coverage === 'partial').length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Partial')
      ),
      h('div', null,
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: 'var(--error)' } }, String(entries.filter(e => e.coverage === 'gap').length)),
        h('div', { style: { color: 'var(--text-secondary)' } }, 'Gaps')
      )
    )
  );
  _container.appendChild(summaryStats);

  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Cluster'),
      h('th', { style: { width: '80px' } }, 'Convs'),
      h('th', { style: { width: '60px' } }, 'Articles'),
      h('th', { style: { width: '80px' } }, 'Coverage')
    )),
    h('tbody', null)
  );
  const tbody = table.querySelector('tbody');

  entries.slice(0, 60).forEach(e => {
    tbody.appendChild(h('tr', null,
      h('td', { style: { fontSize: '12px', fontWeight: '500' } }, e.name),
      h('td', null,
        h('span', { class: `pill pill--${e.convs >= PT_HIGH_VOLUME_CONVS ? 'error' : e.convs >= PT_MID_VOLUME_CONVS ? 'warning' : 'neutral'}` }, String(e.convs))
      ),
      h('td', { style: { fontSize: '12px' } }, String(e.count)),
      h('td', null,
        h('span', { class: `pill pill--${e.coverage === 'good' ? 'success' : e.coverage === 'partial' ? 'warning' : 'error'}` },
          e.coverage === 'good' ? 'Good' : e.coverage === 'partial' ? 'Partial' : 'Gap'
        )
      )
    ));
  });

  _container.appendChild(table);
}

function renderAnalysis(analysis) {
  if (analysis.narrative) {
    _container.appendChild(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { style: { fontSize: '11px', fontWeight: '600', color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' } }, 'AI Coverage Summary'),
      h('div', { style: { fontSize: '13px', whiteSpace: 'pre-wrap', lineHeight: '1.6' } }, analysis.narrative)
    ));
  }

  if (analysis.gaps?.length) {
    const table = h('table', { class: 'data-table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Cluster'),
        h('th', { style: { width: '60px' } }, 'Convs'),
        h('th', { style: { width: '60px' } }, 'Res%'),
        h('th', { style: { width: '80px' } }, 'Coverage'),
        h('th', null, 'Best Article'),
        h('th', null, 'Gap Note'),
        h('th', { style: { width: '70px' } }, 'Priority')
      )),
      h('tbody', null)
    );
    const tbody = table.querySelector('tbody');
    analysis.gaps.forEach(g => {
      tbody.appendChild(h('tr', null,
        h('td', { style: { fontSize: '12px', fontWeight: '500' } }, g.cluster),
        h('td', { style: { fontSize: '11px' } }, String(g.conversations || 0)),
        h('td', { style: { fontSize: '11px' } }, g.resolution_pct != null ? `${Math.round(g.resolution_pct * 100)}%` : '—'),
        h('td', null,
          h('span', { class: `pill pill--${g.coverage === 'covered' ? 'success' : g.coverage === 'partial' ? 'warning' : 'error'}` }, g.coverage)
        ),
        h('td', { style: { fontSize: '11px', color: 'var(--text-secondary)' } }, g.best_article || '—'),
        h('td', { style: { fontSize: '11px' } }, g.gap_description || ''),
        h('td', null,
          h('span', { class: `pill pill--${g.priority === 'high' ? 'error' : g.priority === 'medium' ? 'warning' : 'info'}` }, g.priority || '')
        )
      ));
    });
    _container.appendChild(table);
  }
}

async function runFullAnalysis() {
  if (!_clusters) return;
  const articles = getState('kb.articles') || [];
  const entries = Object.entries(_clusters);

  setState('coverage.running', { label: 'Building cluster map…', pct: 10 });

  const ptGroups = new Map();
  entries.forEach(([name, data]) => {
    const pt = data.product_topic || name.split(' - ')[0] || name;
    if (!ptGroups.has(pt)) ptGroups.set(pt, []);
    ptGroups.get(pt).push({ name, ...data });
  });

  setState('coverage.running', { label: 'Generating AI analysis…', pct: 40 });

  const topPTs = [...ptGroups.entries()]
    .map(([pt, clusters]) => ({ pt, clusters, totalConvs: clusters.reduce((s, c) => s + (c.conversations || 0), 0) }))
    .sort((a, b) => b.totalConvs - a.totalConvs)
    .slice(0, 5);

  let narrative = '';
  const allGaps = [];

  for (let i = 0; i < topPTs.length; i++) {
    const { pt, clusters } = topPTs[i];
    setState('coverage.running', { label: `Analyzing ${pt}…`, pct: 40 + Math.round((i / topPTs.length) * 50) });

    const ptArticles = articles.filter(a => (a.topicName || '').toLowerCase().includes(pt.toLowerCase()));
    const articleSummaries = ptArticles.slice(0, 80).map(a => `- [${a.articleNumber}] ${a.title}${a.summary ? ` — ${a.summary.slice(0, 100)}` : ''}`).join('\n');
    const clusterText = clusters.slice(0, 25).map(c => {
      const cited = (c.cited_articles || []).length
        ? c.cited_articles.map(a => `"${a.title}" (${Math.round((a.resolution_pct || 0) * 100)}% res)`).join(', ')
        : 'none cited';
      return `${c.name} | ${c.conversations || 0} convs | ${Math.round((c.resolution_pct || 0) * 100)}% resolution | Cited: ${cited}`;
    }).join('\n');

    const totalConvs = clusters.reduce((s, c) => s + (c.conversations || 0), 0);
    const avgRes = clusters.length ? clusters.reduce((s, c) => s + (c.resolution_pct || 0), 0) / clusters.length : 0;

    const system = `You are a Knowledge Management analyst evaluating KB coverage for Agentforce readiness.
Output exactly: NARRATIVE (2-3 paragraphs), then GAPS (one row per cluster, tab-separated: cluster_label\tconversations\tresolution_pct\tcoverage\tbest_article\tgap_description\tpriority).
coverage = "covered"|"partial"|"gap". priority = "high"|"medium"|"low".`;

    const user = `P&T: ${pt}
Total Conversations: ${totalConvs}
Resolution Rate: ${Math.round(avgRes * 100)}%

CLUSTERS:
${clusterText || '(none)'}

ARTICLES (${ptArticles.length}):
${articleSummaries || '(none)'}

Produce NARRATIVE then GAPS.`;

    try {
      const resp = await callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: 2000, temperature: 0.2 });
      const text = extractText(resp);
      const narMatch = text.match(/NARRATIVE\s*\n([\s\S]*?)(?=\nGAPS|$)/);
      if (narMatch) narrative += `### ${pt}\n${narMatch[1].trim()}\n\n`;

      const gapsMatch = text.match(/GAPS\s*\n([\s\S]*?)$/);
      if (gapsMatch) {
        const lines = gapsMatch[1].split('\n').filter(l => l.trim());
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 7) {
            allGaps.push({
              cluster: parts[0].trim(),
              conversations: parseInt(parts[1], 10) || 0,
              resolution_pct: parseFloat(parts[2]) || 0,
              coverage: parts[3].trim(),
              best_article: parts[4].trim(),
              gap_description: parts[5].trim(),
              priority: parts[6].trim()
            });
          }
        }
      }
    } catch {}
  }

  allGaps.sort((a, b) => {
    const prio = { high: 3, medium: 2, low: 1 };
    return (prio[b.priority] || 0) - (prio[a.priority] || 0) || b.conversations - a.conversations;
  });

  setState('coverage.running', null);
  setState('coverage.analysis', { narrative: narrative.trim(), gaps: allGaps.slice(0, 40) });
  toast(`Coverage analysis complete: ${allGaps.filter(g => g.coverage !== 'covered').length} gaps found.`, 'info');
}

