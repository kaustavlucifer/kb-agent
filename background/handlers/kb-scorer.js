import { detectSession } from '../../shared/auth.js';
import { mapWithConcurrency, stripHtml } from '../../shared/api.js';
import { streamClaude } from '../../shared/gateway.js';
import { SCORE_CONCURRENCY, MAX_BODY_CHARS } from '../../shared/config.js';
import { scoreArticle, fetchArticleBodies } from '../../shared/scoring.js';

export async function handleScoreBatch(port, msg) {
  const articles = msg.articles || [];
  if (!articles.length) { port.postMessage({ type: 'done', scored: [] }); return; }

  const session = await detectSession();
  if (!session.sid) { port.postMessage({ type: 'error', error: 'No SF session' }); return; }

  const bodyMap = await fetchArticleBodies(articles.map(a => a.id), session);
  const results = [];
  let done = 0;

  await mapWithConcurrency(articles, SCORE_CONCURRENCY, async (article) => {
    const body = bodyMap.get(article.id) || {};
    const enriched = { ...article, ...body };
    try {
      const result = await scoreArticle(enriched);
      results.push({ id: article.id, overall: result.overall, criteria: result.criteria });
    } catch (e) {
      results.push({ id: article.id, overall: null, error: e.message });
    }
    done++;
    port.postMessage({ type: 'progress', scored: { id: article.id, overall: results[results.length - 1].overall }, done, total: articles.length });
  });

  // Retry failed articles once
  const failed = results.filter(r => r.overall == null);
  if (failed.length) {
    await new Promise(r => setTimeout(r, 2000));
    const failedArticles = failed.map(f => articles.find(a => a.id === f.id)).filter(Boolean);
    await mapWithConcurrency(failedArticles, 2, async (article) => {
      const body = bodyMap.get(article.id) || {};
      const enriched = { ...article, ...body };
      try {
        const result = await scoreArticle(enriched);
        const idx = results.findIndex(r => r.id === article.id);
        if (idx >= 0) results[idx] = { id: article.id, overall: result.overall, criteria: result.criteria };
        port.postMessage({ type: 'progress', scored: { id: article.id, overall: result.overall }, done: results.filter(r => r.overall != null).length, total: articles.length });
      } catch {}
    });
  }

  port.postMessage({ type: 'done', scored: results });
}

export async function handleRewrite(port, msg) {
  const article = msg.article;
  if (!article) { port.postMessage({ type: 'error', error: 'No article provided' }); return; }
  try {
    const desc = stripHtml(article.description || article.body || '').slice(0, MAX_BODY_CHARS);
    const res = stripHtml(article.resolution || '').slice(0, MAX_BODY_CHARS);
    const steps = stripHtml(article.steps || '').slice(0, 1500);
    await streamClaude({
      system: `You are an expert technical writer specializing in Salesforce Knowledge Articles optimized for Agentforce (AGF) retrieval.

CONTEXT — HOW AGENTFORCE RETRIEVES CONTENT:
- Articles are split into chunks at header boundaries (section-aware chunking, max 512 tokens per chunk)
- Only TOP 5 chunks from 195k+ pieces are selected via hybrid search (exact match + vector similarity)
- Title is prepended to every chunk — it directly affects ALL retrieval
- Videos, screenshots, file attachments are IGNORED — only text and alt-text are indexed
- Code blocks are poorly consumed — text explanations are essential
- Product & Topic tags are NOT yet used by RAG — product name must appear in body text

REWRITE RULES:
1. TITLE: ≤60 chars, front-load keywords, include specific product name, no question format, symptom-based for troubleshooting
2. SUMMARY: ≤170 chars, use DIFFERENT words/synonyms than title, specify audience, include exact error text if applicable
3. DESCRIPTION: Start with intent paragraph explaining WHAT question this answers and WHY. Explain uncommon acronyms. Use present tense. Include the customer's likely phrasing of the problem. Mention product name explicitly.
4. RESOLUTION: Begin with a brief context paragraph. Use numbered steps. Each step is a complete actionable instruction. Include expected outcomes. Add real-life examples with Salesforce-format data (random UUIDs, realistic field values — never "xxxxx").
5. HEADERS: Use ## for sections (translates to <h2>). Make headers descriptive with intent keywords. Keep content under each header ≤512 tokens (~2048 chars). If longer, split with sub-headers (###).
6. STRUCTURE: Short paragraphs (3-5 sentences). Use bullet lists. Each section self-contained and readable in isolation (it may be retrieved as a standalone chunk).
7. NO: visual indicators in tables, screenshot-only solutions, unexplained code blocks, internal URLs, speculative statements, PII/credentials, "contact Salesforce support" as a resolution step.

Output format:
## TITLE
## SUMMARY
## DESCRIPTION
## RESOLUTION

Preserve all technical accuracy from the original. Enhance structure, clarity, and retrieval optimization.`,
      messages: [{ role: 'user', content: `Original Article to Rewrite:\n\nTitle: ${article.title}\nProduct & Topic: ${article.topicName || '(none)'}\nValidation: ${article.validationStatus || 'Not Validated'}\n\nSummary: ${article.summary || '(empty)'}\n\nDescription:\n${desc || '(empty)'}\n\nResolution:\n${res || '(empty)'}${steps ? `\n\nSteps:\n${steps}` : ''}` }],
      maxTokens: 4000,
      onDelta: (chunk) => port.postMessage({ type: 'delta', chunk }),
      onDone: (full) => port.postMessage({ type: 'done', text: full })
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: e.message });
  }
}

