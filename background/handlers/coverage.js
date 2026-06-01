import { callClaude, extractText, extractJson } from '../../shared/gateway.js';
import { PT_HIGH_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../../shared/config.js';

export async function analyzePtCoverage(msg) {
  const { ptName, clusters, articles } = msg;
  const clusterText = clusters.slice(0, 25).map(c =>
    `${c.label || c.name} | ${c.conversations || 0} convs | ${Math.round((c.resolution_pct || 0) * 100)}% res`
  ).join('\n');
  const articleText = articles.slice(0, 50).map(a => `- [${a.articleNumber}] ${a.title}`).join('\n');

  const resp = await callClaude({
    system: 'You are a KB coverage analyst. Identify gaps and recommend articles to create. Be concise.',
    messages: [{ role: 'user', content: `P&T: ${ptName}\n\nClusters:\n${clusterText}\n\nArticles:\n${articleText}\n\nIdentify which clusters have no coverage and what articles should be created.` }],
    maxTokens: 1500,
    temperature: 0.2
  });
  return { success: true, narrative: extractText(resp) };
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
      if (matched.length < PT_LOW_COVERAGE_ARTICLES) {
        gaps.push({
          cluster: name,
          conversations: cluster.conversations || 0,
          coverage: matched.length > 0 ? 'partial' : 'gap',
          priority: (cluster.conversations || 0) >= PT_HIGH_VOLUME_CONVS ? 'high' : 'medium'
        });
      }
    });
    port.postMessage({ type: 'done', gaps });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}
