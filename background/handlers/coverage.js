import { streamClaude } from '../../shared/gateway.js';
import { PT_HIGH_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../../shared/config.js';

export async function analyzePtCoverage(msg, port) {
  const { ptName, clusters, articles } = msg;
  const clusterText = clusters.slice(0, 25).map(c =>
    `${c.label || c.name} | ${c.conversations || 0} convs | ${Math.round((c.resolution_pct || 0) * 100)}% res | ${c.escalations || 0} escals`
  ).join('\n');
  const articleText = articles.slice(0, 50).map(a => `- [${a.articleNumber}] ${a.title}`).join('\n');

  if (port) {
    const fullText = await streamClaude({
      system: `You are a KB coverage analyst for Salesforce Agentforce. Analyze this Product & Topic's conversation clusters against existing KB articles.

OUTPUT FORMAT (use proper markdown):
## Coverage Gaps
Use a markdown table: | Cluster | Convs | Res% | Gap Reason |

## Recommended Articles to Create
For each article, use:
### Priority: [Immediate/High/Medium]
1. **Article Title** — Covers: [description]. Addresses: *[cluster names]* ([X] convs)

Be specific about article titles. Use product names. Be concise but complete.`,
      messages: [{ role: 'user', content: `P&T: ${ptName}\n\nClusters:\n${clusterText}\n\nExisting Articles:\n${articleText}\n\nAnalyze coverage gaps and recommend new articles to create.` }],
      maxTokens: 2000,
      temperature: 0.2,
      onDelta: (chunk) => { try { port.postMessage({ type: 'delta', chunk }); } catch {} }
    });
    port.postMessage({ type: 'done', narrative: fullText });
    return;
  }

  const fullText = await streamClaude({
    system: 'You are a KB coverage analyst. Identify gaps and recommend articles to create. Use markdown tables and headers.',
    messages: [{ role: 'user', content: `P&T: ${ptName}\n\nClusters:\n${clusterText}\n\nArticles:\n${articleText}\n\nIdentify which clusters have no coverage and what articles should be created.` }],
    maxTokens: 2000,
    temperature: 0.2,
    onDelta: () => {}
  });
  return { success: true, narrative: fullText };
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
