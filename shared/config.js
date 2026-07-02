export const GATEWAY_BASE = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl';

export let DEFAULT_MODEL = 'claude-sonnet-4-6';
export let FAST_MODEL = 'claude-sonnet-4-6';
export let SCORING_MODEL = 'claude-haiku-4-5-20251001';

export const SF_API_VERSION = 'v62.0';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_CACHE_BETA = 'prompt-caching-2024-07-31';

export const TOP_K = 5;
export const SOSL_PER_QUERY = 10;
export const MAX_SOSL_QUERIES = 8;
export const FINAL_MAX_TOKENS = 5000;
export const CLAUDE_TIMEOUT_MS = 90_000;

export let SCORE_CONCURRENCY = 8;
export const BODY_FETCH_BATCH_SIZE = 50;
export const MAX_BODY_CHARS = 4000;
export const SCORING_MAX_TOKENS = 4000;
export const SCORING_RETRY_MAX_TOKENS = 6000;

export const DEDUP_BATCH_SIZE = 20;
export const DEDUP_CONCURRENCY = 5;
export const DEDUP_MAX_TOKENS = 4000;
export const DEDUP_BODY_CHARS = 2000;

export const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
  'claude-opus-4-8': { in: 15.0, out: 75.0 }
};
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CHARS_PER_TOKEN = 3.7;
export const SCORING_SYSTEM_CHARS = 9473;
export const SCORING_EST_OUTPUT_TOKENS = 1200;
export const DEDUP_SYSTEM_CHARS = 1126;
export const DEDUP_EST_OUTPUT_INPUT_RATIO = 0.05;


export let SCORE_HIGH_THRESHOLD = 80;
export let SCORE_MID_THRESHOLD = 60;

export let SCORE_GOOD_ENOUGH_THRESHOLD = 70;
export let RELEVANCE_COVERAGE_THRESHOLD = 65;

export const PT_HIGH_VOLUME_CONVS = 200;
export const PT_MID_VOLUME_CONVS = 100;
export const PT_LOW_COVERAGE_ARTICLES = 3;

export const CLUSTER_HIGH_VOLUME_CONVS = 200;
export const CLUSTER_MID_VOLUME_CONVS = 50;

export const STREAM_RENDER_THROTTLE_MS = 150;

export const CACHE_TTL_MS = 30 * 60 * 1000;

export const CASE_GUARD_RAIL_EXCLUSIONS = [
  'EU Premier', 'US Premier', 'Gov', 'US Sig'
];

export const ORGCS_BASE = 'https://orgcs.lightning.force.com';
export function articleUrl(id) { return `${ORGCS_BASE}/lightning/r/Knowledge__kav/${id}/view`; }

export const CLOUDS = ['Industry', 'Revenue'];

export function getCloudFromPt(topicName) {
  if (!topicName) return 'Other';
  const lower = topicName.toLowerCase();
  for (const cloud of CLOUDS) {
    if (lower.startsWith(cloud.toLowerCase())) return cloud;
  }
  return 'Other';
}

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
  AUTH_CACHE: 'authCache',
  SETTINGS: 'kba_settings',
  COST_TOTALS_UI: 'kba_cost_totals_ui',
  COST_TOTALS_SW: 'kba_cost_totals_sw'
};

export const MODEL_CHOICES = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced, default)' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (highest quality, slowest)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest, lower quality)' }
];

export const SETTINGS_SCHEMA = [
  {
    key: 'modelGeneration', kind: 'model', binding: 'DEFAULT_MODEL', default: 'claude-sonnet-4-6',
    label: 'Article generation & rewrite',
    help: 'Model used to draft new articles and rewrite existing ones. Quality matters most here — Opus produces the strongest prose; Haiku is fastest.'
  },
  {
    key: 'modelScoring', kind: 'model', binding: 'SCORING_MODEL', default: 'claude-haiku-4-5-20251001',
    label: 'Scoring & duplicate detection',
    help: 'Model used to score articles against the AGF rubric and to compare articles for duplicates. Runs many times per batch, so faster models noticeably speed up bulk scoring.'
  },
  {
    key: 'modelCaseAnalysis', kind: 'model', binding: 'FAST_MODEL', default: 'claude-sonnet-4-6',
    label: 'Case analysis (search & relevance)',
    help: 'Model used for case search, abstraction, and article-relevance scoring during case analysis.'
  },
  {
    key: 'scoreGoodEnough', kind: 'number', binding: 'SCORE_GOOD_ENOUGH_THRESHOLD', default: 70, min: 0, max: 100, step: 1,
    label: 'Good-enough quality gate',
    help: 'An article scoring at or above this is considered already well-structured for Agentforce, so a rewrite is skipped (you can still override). Raise it to rewrite more aggressively; lower it to rewrite only the worst articles.'
  },
  {
    key: 'relevanceCoverage', kind: 'number', binding: 'RELEVANCE_COVERAGE_THRESHOLD', default: 65, min: 0, max: 100, step: 1,
    label: 'Case-coverage relevance gate',
    help: 'During case analysis, an existing article must score at least this on case relevance (and pass the quality gate) to count as already covering the case. Higher = stricter about what counts as coverage.'
  },
  {
    key: 'scoreHigh', kind: 'number', binding: 'SCORE_HIGH_THRESHOLD', default: 80, min: 0, max: 100, step: 1,
    label: 'High-score band (green)',
    help: 'Scores at or above this show green across the UI and as the "High" filter. Purely a display/triage band — does not change AI behavior.'
  },
  {
    key: 'scoreMid', kind: 'number', binding: 'SCORE_MID_THRESHOLD', default: 60, min: 0, max: 100, step: 1,
    label: 'Mid-score band (amber)',
    help: 'Scores at or above this (but below the high band) show amber; below it shows red. Display/triage band only.'
  },
  {
    key: 'scoreConcurrency', kind: 'number', binding: 'SCORE_CONCURRENCY', default: 8, min: 1, max: 12, step: 1,
    label: 'Scoring concurrency',
    help: 'How many articles are scored in parallel during a batch. Higher is faster but is capped by the gateway rate limit (~48/min) — values above ~12 stop helping and risk throttling.'
  }
];

export function applySettings(stored) {
  if (!stored || typeof stored !== 'object') return;
  for (const item of SETTINGS_SCHEMA) {
    if (!(item.key in stored)) continue;
    const v = stored[item.key];
    if (item.kind === 'model') {
      if (typeof v !== 'string' || !MODEL_CHOICES.some(m => m.value === v)) continue;
      if (item.binding === 'DEFAULT_MODEL') DEFAULT_MODEL = v;
      else if (item.binding === 'FAST_MODEL') FAST_MODEL = v;
      else if (item.binding === 'SCORING_MODEL') SCORING_MODEL = v;
    } else if (item.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < item.min || n > item.max) continue;
      if (item.binding === 'SCORE_GOOD_ENOUGH_THRESHOLD') SCORE_GOOD_ENOUGH_THRESHOLD = n;
      else if (item.binding === 'RELEVANCE_COVERAGE_THRESHOLD') RELEVANCE_COVERAGE_THRESHOLD = n;
      else if (item.binding === 'SCORE_HIGH_THRESHOLD') SCORE_HIGH_THRESHOLD = n;
      else if (item.binding === 'SCORE_MID_THRESHOLD') SCORE_MID_THRESHOLD = n;
      else if (item.binding === 'SCORE_CONCURRENCY') SCORE_CONCURRENCY = n;
    }
  }
}

export function currentSettings() {
  const map = {
    DEFAULT_MODEL, FAST_MODEL, SCORING_MODEL,
    SCORE_GOOD_ENOUGH_THRESHOLD, RELEVANCE_COVERAGE_THRESHOLD,
    SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD, SCORE_CONCURRENCY
  };
  const out = {};
  for (const item of SETTINGS_SCHEMA) out[item.key] = map[item.binding];
  return out;
}
