import { callClaude, extractText, extractJson } from '../../shared/gateway.js';
import { PT_HIGH_VOLUME_CONVS, PT_LOW_COVERAGE_ARTICLES } from '../../shared/config.js';

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
