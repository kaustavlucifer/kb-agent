import { GATEWAY_BASE, ANTHROPIC_VERSION, ANTHROPIC_CACHE_BETA, DEFAULT_MODEL, FAST_MODEL, CLAUDE_TIMEOUT_MS, STORAGE_KEYS } from './config.js';
import { localGet, localSet } from './storage.js';
import { acquireSlot, sleep } from './rate-limiter.js';
import { recordUsage, usageFromResponse } from './cost.js';

async function getToken() {
  const data = await localGet([STORAGE_KEYS.GATEWAY_TOKEN]);
  return data[STORAGE_KEYS.GATEWAY_TOKEN] || null;
}

function buildHeaders(token, cache = false) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION
  };
  if (cache) headers['anthropic-beta'] = ANTHROPIC_CACHE_BETA;
  return headers;
}

function buildSystemField(system, cache) {
  if (!cache) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

const MODEL_FAMILY_ORDER = { opus: 0, sonnet: 1, haiku: 2 };

function familyRank(id) {
  const lower = id.toLowerCase();
  for (const family of Object.keys(MODEL_FAMILY_ORDER)) {
    if (lower.includes(family)) return MODEL_FAMILY_ORDER[family];
  }
  return 3;
}

async function fetchGatewayPricing(token) {
  try {
    const resp = await fetch(`${GATEWAY_BASE}/model_group/info`, { method: 'GET', headers: buildHeaders(token) });
    if (!resp.ok) return {};
    const data = await resp.json();
    const pricing = {};
    for (const g of data?.data || []) {
      if (!g.model_group?.startsWith('claude-')) continue;
      const inPerTok = Number(g.input_cost_per_token);
      const outPerTok = Number(g.output_cost_per_token);
      if (!Number.isFinite(inPerTok) || !Number.isFinite(outPerTok) || inPerTok <= 0) continue;
      pricing[g.model_group] = { in: inPerTok * 1_000_000, out: outPerTok * 1_000_000 };
    }
    return pricing;
  } catch {
    return {};
  }
}

async function fetchKeyInfo(token) {
  const resp = await fetch(`${GATEWAY_BASE}/key/info`, { method: 'GET', headers: buildHeaders(token) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { ok: false, error: `${resp.status}: ${text.slice(0, 100)}` };
  }
  const info = (await resp.json())?.info || {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
  return { ok: true, limits: { rpmLimit: num(info.rpm_limit), tpmLimit: num(info.tpm_limit), maxParallel: num(info.max_parallel_requests), maxBudget: num(info.max_budget), spend: num(info.spend) } };
}

export async function fetchGatewayKeyLimits(token) {
  if (!token) return null;
  try {
    const r = await fetchKeyInfo(token);
    return r.ok ? r.limits : null;
  } catch {
    return null;
  }
}

export async function listGatewayModels(token) {
  if (!token) return null;
  try {
    const [resp, pricing] = await Promise.all([
      fetch(`${GATEWAY_BASE}/v1/models`, { method: 'GET', headers: buildHeaders(token) }),
      fetchGatewayPricing(token)
    ]);
    if (!resp.ok) return null;
    const data = await resp.json();
    const models = (data?.data || [])
      .filter(m => m.id && m.id.startsWith('claude-') && !m.id.includes('auto-model'))
      .map(m => ({ value: m.id, label: m.display_name || m.id, pricing: pricing[m.id] || null }))
      .sort((a, b) => {
        const rankDiff = familyRank(a.value) - familyRank(b.value);
        if (rankDiff !== 0) return rankDiff;
        return b.value.localeCompare(a.value);
      });
    return models;
  } catch {
    return null;
  }
}

const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function refreshModelCatalog({ force = false } = {}) {
  const data = await localGet([STORAGE_KEYS.MODEL_CATALOG, STORAGE_KEYS.GATEWAY_TOKEN]);
  const catalog = data[STORAGE_KEYS.MODEL_CATALOG] || null;
  const fresh = catalog?.at && Date.now() - catalog.at < MODEL_CATALOG_MAX_AGE_MS;
  if (!force && fresh) return { catalog, refreshed: false };
  const token = data[STORAGE_KEYS.GATEWAY_TOKEN];
  if (!token) return { catalog, refreshed: false, error: 'No token configured' };
  const [models, limits] = await Promise.all([listGatewayModels(token), fetchGatewayKeyLimits(token)]);
  if (!models?.length) return { catalog, refreshed: false, error: 'Could not load models' };
  const next = { models, limits, at: Date.now() };
  await localSet({ [STORAGE_KEYS.MODEL_CATALOG]: next });
  return { catalog: next, refreshed: true };
}

export async function pingGateway(token) {
  const t = token || await getToken();
  if (!t) return { connected: false, hasToken: false, error: 'No token configured' };
  try {
    const r = await fetchKeyInfo(t);
    if (r.ok) return { connected: true, hasToken: true };
    return { connected: false, hasToken: true, error: r.error };
  } catch (e) {
    return { connected: false, hasToken: true, error: e.message };
  }
}

function supportsTemperature(model) {
  const match = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model || '');
  if (!match) return true;
  const [, family, majorStr, minorStr] = match;
  const major = Number(majorStr);
  const minor = minorStr && minorStr.length <= 2 ? Number(minorStr) : 0;
  if (family === 'opus') return major < 4 || (major === 4 && minor < 7);
  return major < 5;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
const MAX_GATEWAY_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;

function retryDelayMs(attempt, retryAfter, bodyText) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const reset = /Limit resets at:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i.exec(bodyText || '');
  if (reset) {
    const untilReset = Date.parse(`${reset[1]}T${reset[2]}Z`) - Date.now();
    if (Number.isFinite(untilReset)) return Math.min(Math.max(untilReset + 250, 250), MAX_RETRY_DELAY_MS);
  }
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), MAX_RETRY_DELAY_MS);
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function timeoutError() {
  return Object.assign(new Error('AI gateway request timed out'), { name: 'TimeoutError', timeout: true });
}

async function fetchWithTimeout(url, init, signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    if (timedOut) throw timeoutError();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function postMessages(token, cache, body, signal, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    await acquireSlot(signal);
    const resp = await fetchWithTimeout(`${GATEWAY_BASE}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(token, cache),
      body: JSON.stringify(body)
    }, signal, timeoutMs);
    if (resp.ok || !RETRYABLE_STATUSES.has(resp.status) || attempt >= MAX_GATEWAY_RETRIES) return resp;
    const retryAfter = resp.headers.get('retry-after');
    const bodyText = await resp.text().catch(() => '');
    await sleep(retryDelayMs(attempt, retryAfter, bodyText), signal);
  }
}

export async function callClaude({ system, messages, maxTokens, model, token, temperature, thinking, cache, signal }) {
  if (signal?.aborted) throw abortError();
  const t = token || await getToken();
  if (!t) throw new Error('No AI gateway token configured');
  const m = model || DEFAULT_MODEL;
  const body = {
    model: m,
    max_tokens: maxTokens || 2048,
    messages
  };
  if (system) body.system = buildSystemField(system, cache);
  if (thinking) {
    body.thinking = thinking;
    body.temperature = 1;
  } else if (temperature != null && supportsTemperature(m)) {
    body.temperature = temperature;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let readTimedOut = false;
  try {
    const resp = await postMessages(t, cache, body, controller.signal, CLAUDE_TIMEOUT_MS);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const retryAfter = resp.headers.get('retry-after');
      throw Object.assign(new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`), { status: resp.status, retryAfter });
    }
    const readTimer = setTimeout(() => { readTimedOut = true; controller.abort(); }, CLAUDE_TIMEOUT_MS);
    const data = await resp.json().finally(() => clearTimeout(readTimer));
    await recordUsage(data.model || m, usageFromResponse(data));
    return data;
  } catch (e) {
    if (readTimedOut) throw timeoutError();
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function callClaudeFast(opts) {
  return callClaude({ ...opts, model: opts.model || FAST_MODEL });
}

const STREAM_IDLE_TIMEOUT_MS = 30_000;

export async function streamClaude({ system, messages, maxTokens, model, token, temperature, cache, onDelta, onDone, onError, signal }) {
  if (signal?.aborted) throw abortError();
  const t = token || await getToken();
  if (!t) throw new Error('No AI gateway token configured');
  const m = model || DEFAULT_MODEL;
  const body = {
    model: m,
    max_tokens: maxTokens || 4096,
    stream: true,
    messages
  };
  if (system) body.system = buildSystemField(system, cache);
  if (temperature != null && supportsTemperature(m)) body.temperature = temperature;

  const controller = new AbortController();
  let idleAborted = false;
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const resp = await postMessages(t, cache, body, controller.signal, CLAUDE_TIMEOUT_MS).catch(err => {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (onError) onError(err);
    throw err;
  });
  if (!resp.ok) {
    if (signal) signal.removeEventListener('abort', onAbort);
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    if (onError) onError(err);
    throw err;
  }
  if (!resp.body) {
    if (signal) signal.removeEventListener('abort', onAbort);
    const err = new Error('Gateway returned no response body for streaming request');
    if (onError) onError(err);
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let streamModel = m;
  let stopReason = null;
  const streamUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let idleTimer = setTimeout(() => { idleAborted = true; controller.abort(); }, STREAM_IDLE_TIMEOUT_MS);

  const handleLine = (line) => {
    if (!line.startsWith('data: ')) return;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    if (event.type === 'content_block_delta' && event.delta?.text) {
      fullText += event.delta.text;
      if (onDelta) onDelta(event.delta.text, fullText);
    } else if (event.type === 'message_start' && event.message) {
      streamModel = event.message.model || streamModel;
      const u = event.message.usage || {};
      streamUsage.inputTokens = u.input_tokens || 0;
      streamUsage.cacheReadTokens = u.cache_read_input_tokens || 0;
      streamUsage.cacheCreationTokens = u.cache_creation_input_tokens || 0;
    } else if (event.type === 'message_delta') {
      if (event.usage) streamUsage.outputTokens = event.usage.output_tokens || streamUsage.outputTokens;
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    } else if (event.type === 'error') {
      const streamErr = new Error(`Gateway stream error: ${event.error?.type || 'error'}${event.error?.message ? ` — ${event.error.message}` : ''}`);
      streamErr.partialText = fullText;
      throw streamErr;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleAborted = true; controller.abort(); }, STREAM_IDLE_TIMEOUT_MS);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } catch (err) {
    if (idleAborted) {
      const stallErr = new Error('Stream stalled (no data received within idle timeout)');
      stallErr.partialText = fullText;
      if (onError) onError(stallErr);
      throw stallErr;
    }
    if (err.name === 'AbortError') {
      await recordUsage(streamModel, streamUsage);
      throw err;
    }
    controller.abort();
    await recordUsage(streamModel, streamUsage);
    if (onError) onError(err);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  await recordUsage(streamModel, streamUsage);
  if (onDone) onDone(fullText, { stopReason });
  return fullText;
}

export function extractText(response) {
  if (!response?.content) return '';
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

