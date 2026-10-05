import { GATEWAY_BASE, ANTHROPIC_VERSION, ANTHROPIC_CACHE_BETA, DEFAULT_MODEL, FAST_MODEL, CLAUDE_TIMEOUT_MS } from './config.js';
import { localGet } from './storage.js';
import { acquireSlot } from './rate-limiter.js';
import { recordUsage, usageFromResponse } from './cost.js';

async function getToken() {
  const data = await localGet(['gatewayToken']);
  return data.gatewayToken || null;
}

function getModel(preferFast = false) {
  return preferFast ? FAST_MODEL : DEFAULT_MODEL;
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

export async function fetchGatewayKeyLimits(token) {
  if (!token) return null;
  try {
    const resp = await fetch(`${GATEWAY_BASE}/key/info`, { method: 'GET', headers: buildHeaders(token) });
    if (!resp.ok) return null;
    const info = (await resp.json())?.info || {};
    const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
    return { rpmLimit: num(info.rpm_limit), tpmLimit: num(info.tpm_limit), maxParallel: num(info.max_parallel_requests), maxBudget: num(info.max_budget), spend: num(info.spend) };
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

export async function pingGateway(token) {
  const t = token || await getToken();
  if (!t) return { connected: false, hasToken: false, error: 'No token configured' };
  try {
    const resp = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(t),
      body: JSON.stringify({
        model: FAST_MODEL,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      })
    });
    if (resp.ok) return { connected: true, hasToken: true };
    const text = await resp.text().catch(() => '');
    return { connected: false, hasToken: true, error: `${resp.status}: ${text.slice(0, 100)}` };
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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function postMessages(token, cache, body, signal) {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await acquireSlot();
    const resp = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(token, cache),
      body: JSON.stringify(body),
      signal
    });
    if (resp.ok || !RETRYABLE_STATUSES.has(resp.status) || attempt >= MAX_GATEWAY_RETRIES) return resp;
    const retryAfter = resp.headers.get('retry-after');
    const bodyText = await resp.text().catch(() => '');
    await sleep(retryDelayMs(attempt, retryAfter, bodyText), signal);
  }
}

export async function callClaude({ system, messages, maxTokens, model, token, temperature, thinking, cache, signal }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await acquireSlot();
  const t = token || await getToken();
  if (!t) throw new Error('No AI gateway token configured');
  const m = model || await getModel();
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
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await postMessages(t, cache, body, controller.signal);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const retryAfter = resp.headers.get('retry-after');
      throw Object.assign(new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`), { status: resp.status, retryAfter });
    }
    const data = await resp.json();
    await recordUsage(data.model || m, usageFromResponse(data));
    return data;
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function callClaudeFast(opts) {
  return callClaude({ ...opts, model: opts.model || FAST_MODEL });
}

const STREAM_IDLE_TIMEOUT_MS = 30_000;

export async function streamClaude({ system, messages, maxTokens, model, token, temperature, cache, onDelta, onDone, onError, signal }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await acquireSlot();
  const t = token || await getToken();
  if (!t) throw new Error('No AI gateway token configured');
  const m = model || await getModel();
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

  const resp = await postMessages(t, cache, body, controller.signal).catch(err => {
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
  const streamUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let idleTimer = setTimeout(() => { idleAborted = true; controller.abort(); }, STREAM_IDLE_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleAborted = true; controller.abort(); }, STREAM_IDLE_TIMEOUT_MS);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            if (onDelta) onDelta(event.delta.text, fullText);
          } else if (event.type === 'message_start' && event.message) {
            streamModel = event.message.model || streamModel;
            const u = event.message.usage || {};
            streamUsage.inputTokens = u.input_tokens || 0;
            streamUsage.cacheReadTokens = u.cache_read_input_tokens || 0;
            streamUsage.cacheCreationTokens = u.cache_creation_input_tokens || 0;
          } else if (event.type === 'message_delta' && event.usage) {
            streamUsage.outputTokens = event.usage.output_tokens || streamUsage.outputTokens;
          }
        } catch {}
      }
    }
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
    if (onError) onError(err);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  await recordUsage(streamModel, streamUsage);
  if (onDone) onDone(fullText);
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

