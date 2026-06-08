export const GATEWAY_BASE = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const FAST_MODEL = 'claude-sonnet-4-6';
export const SCORING_MODEL = 'claude-sonnet-4-6';

export const SF_API_VERSION = 'v62.0';
export const ANTHROPIC_VERSION = '2023-06-01';

export const TOP_K = 5;
export const SOSL_PER_QUERY = 10;
export const MAX_SOSL_QUERIES = 8;
export const FINAL_MAX_TOKENS = 5000;
export const CLAUDE_TIMEOUT_MS = 90_000;

export const SCORE_CONCURRENCY = 8;
export const BODY_FETCH_BATCH_SIZE = 50;
export const MAX_BODY_CHARS = 4000;

export const DEDUP_BATCH_SIZE = 20;
export const DEDUP_CONCURRENCY = 5;


export const SCORE_HIGH_THRESHOLD = 80;
export const SCORE_MID_THRESHOLD = 60;

export const PT_HIGH_VOLUME_CONVS = 200;
export const PT_MID_VOLUME_CONVS = 100;
export const PT_LOW_COVERAGE_ARTICLES = 3;

export const STREAM_RENDER_THROTTLE_MS = 150;

export const CACHE_TTL_MS = 30 * 60 * 1000;

export const CASE_GUARD_RAIL_EXCLUSIONS = [
  'EU Premier', 'US Premier', 'Gov', 'US Sig'
];

export const ORGCS_BASE = 'https://orgcs.lightning.force.com';
export function articleUrl(id) { return `${ORGCS_BASE}/lightning/r/Knowledge__kav/${id}/view`; }

export const STORAGE_KEYS = {
  GATEWAY_TOKEN: 'gatewayToken',
  MODEL: 'modelName',
  ALL_ARTICLES: 'kba_all_articles',
  ALL_ARTICLES_AT: 'kba_all_articles_at',
  ARTICLE_SCORES: 'kba_article_scores',
  DEDUP_RESULTS: 'kba_dedup_results',
  DEDUP_AT: 'kba_dedup_at',
  RECENT_CASES: 'recentCases',
  BYPASS_GUARD_RAILS: 'bypassGuardRails',
  AUTH_CACHE: 'authCache'
};
