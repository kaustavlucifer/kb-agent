import { localGet, localSet } from './storage.js';
import { setState } from './state.js';
import {
  MODEL_PRICING, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, CHARS_PER_TOKEN, STORAGE_KEYS,
  SCORING_MODEL, SCORING_SYSTEM_CHARS, SCORING_EST_OUTPUT_TOKENS, MAX_BODY_CHARS,
  DEDUP_SYSTEM_CHARS, DEDUP_BODY_CHARS, DEDUP_EST_OUTPUT_INPUT_RATIO
} from './config.js';

export function costUsd(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0) {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.in
    + (cacheReadTokens / 1_000_000) * p.in * CACHE_READ_MULTIPLIER
    + (cacheCreationTokens / 1_000_000) * p.in * CACHE_WRITE_MULTIPLIER
    + (outputTokens / 1_000_000) * p.out;
}

export function charsToTokens(chars) {
  const cpt = CHARS_PER_TOKEN || 3.7;
  return Math.max(0, Math.round((chars || 0) / cpt));
}

export function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n > 0 && n < 0.01) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

export function usageFromResponse(resp) {
  const u = resp?.usage || {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0
  };
}

function emptyTotals() {
  return { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byModel: {} };
}

function emptyBucket() {
  return { costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function mergeTotals(base, add) {
  const out = emptyTotals();
  for (const src of [base, add]) {
    out.costUsd += src.costUsd || 0;
    out.calls += src.calls || 0;
    out.inputTokens += src.inputTokens || 0;
    out.outputTokens += src.outputTokens || 0;
    out.cacheReadTokens += src.cacheReadTokens || 0;
    out.cacheCreationTokens += src.cacheCreationTokens || 0;
    for (const [m, v] of Object.entries(src.byModel || {})) {
      const t = out.byModel[m] || (out.byModel[m] = emptyBucket());
      t.costUsd += v.costUsd || 0;
      t.calls += v.calls || 0;
      t.inputTokens += v.inputTokens || 0;
      t.outputTokens += v.outputTokens || 0;
      t.cacheReadTokens += v.cacheReadTokens || 0;
      t.cacheCreationTokens += v.cacheCreationTokens || 0;
    }
  }
  return out;
}

function singleTotal(model, usage, cost) {
  const t = emptyTotals();
  t.costUsd = cost;
  t.calls = 1;
  t.inputTokens = usage.inputTokens;
  t.outputTokens = usage.outputTokens;
  t.cacheReadTokens = usage.cacheReadTokens;
  t.cacheCreationTokens = usage.cacheCreationTokens;
  t.byModel[model] = { costUsd: cost, calls: 1, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens };
  return t;
}

const IS_SERVICE_WORKER = typeof window === 'undefined';
const OWN_KEY = IS_SERVICE_WORKER ? STORAGE_KEYS.COST_TOTALS_SW : STORAGE_KEYS.COST_TOTALS_UI;
const OTHER_KEY = IS_SERVICE_WORKER ? STORAGE_KEYS.COST_TOTALS_UI : STORAGE_KEYS.COST_TOTALS_SW;

let _ownPersisted = null;
let _otherPersisted = emptyTotals();
let _delta = emptyTotals();
let _flushTimer = null;
let _loadPromise = null;

function displayed() {
  return mergeTotals(mergeTotals(_ownPersisted || emptyTotals(), _delta), _otherPersisted);
}

function publish() {
  setState('app.cost', displayed());
}

async function ensureLoaded() {
  if (_ownPersisted) return;
  if (!_loadPromise) {
    _loadPromise = localGet([OWN_KEY, OTHER_KEY]).then(data => {
      if (!_ownPersisted) _ownPersisted = data[OWN_KEY] || emptyTotals();
      _otherPersisted = data[OTHER_KEY] || emptyTotals();
    });
  }
  await _loadPromise;
}

async function flushCost() {
  _flushTimer = null;
  const delta = _delta;
  if (!delta.calls) return;
  _delta = emptyTotals();
  await ensureLoaded();
  _ownPersisted = mergeTotals(_ownPersisted, delta);
  await localSet({ [OWN_KEY]: _ownPersisted });
  publish();
}

export { flushCost };

export async function recordUsage(model, usage) {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
  await ensureLoaded();
  const cost = costUsd(model, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens);
  _delta = mergeTotals(_delta, singleTotal(model, usage, cost));
  publish();
  if (!_flushTimer) _flushTimer = setTimeout(flushCost, 800);
}

export function onCostStorageChange(changes) {
  const other = changes[OTHER_KEY];
  if (other) {
    _otherPersisted = other.newValue || emptyTotals();
    publish();
  }
  const own = changes[OWN_KEY];
  if (own && (!own.newValue || !own.newValue.calls)) {
    _ownPersisted = emptyTotals();
    _delta = emptyTotals();
    publish();
  }
}

export async function getCostTotals() {
  await ensureLoaded();
  return displayed();
}

export async function resetCostTotals() {
  _delta = emptyTotals();
  _ownPersisted = emptyTotals();
  _otherPersisted = emptyTotals();
  await localSet({ [STORAGE_KEYS.COST_TOTALS_UI]: emptyTotals(), [STORAGE_KEYS.COST_TOTALS_SW]: emptyTotals() });
  publish();
}

export function estimateScoring(articles) {
  const bodyCap = MAX_BODY_CHARS * 2 + 1500;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const a of articles) {
    const body = Math.min(Math.max(a.articleLength || 0, 800), bodyCap);
    const chars = SCORING_SYSTEM_CHARS + 400 + (a.title || '').length + (a.summary || '').length + body;
    inputTokens += charsToTokens(chars);
    outputTokens += SCORING_EST_OUTPUT_TOKENS;
  }
  return { calls: articles.length, inputTokens, outputTokens, costUsd: costUsd(SCORING_MODEL, inputTokens, outputTokens) };
}

export function estimateDedup(batches) {
  const perArticleBodyCap = DEDUP_BODY_CHARS * 3;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const batch of batches) {
    let chars = DEDUP_SYSTEM_CHARS + 120;
    for (const a of batch) {
      const body = Math.min(Math.max(a.articleLength || 0, 400), perArticleBodyCap);
      chars += (a.title || '').length + 200 + body + 40;
    }
    const inTok = charsToTokens(chars);
    inputTokens += inTok;
    outputTokens += Math.round(inTok * DEDUP_EST_OUTPUT_INPUT_RATIO);
  }
  return { calls: batches.length, inputTokens, outputTokens, costUsd: costUsd(SCORING_MODEL, inputTokens, outputTokens) };
}
