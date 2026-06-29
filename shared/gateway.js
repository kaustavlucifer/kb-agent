import { GATEWAY_BASE, ANTHROPIC_VERSION, DEFAULT_MODEL, FAST_MODEL, CLAUDE_TIMEOUT_MS } from './config.js';
import { localGet } from './storage.js';
import { acquireSlot } from './rate-limiter.js';

async function getToken() {
  const data = await localGet(['gatewayToken']);
  return data.gatewayToken || null;
}

function getModel(preferFast = false) {
  return preferFast ? FAST_MODEL : DEFAULT_MODEL;
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION
  };
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

export async function callClaude({ system, messages, maxTokens, model, token, temperature, thinking, signal }) {
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
  if (system) body.system = system;
  if (thinking) {
    body.thinking = thinking;
    body.temperature = 1;
  } else if (temperature != null) {
    body.temperature = temperature;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(`${GATEWAY_BASE}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(t),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const retryAfter = resp.headers.get('retry-after');
      throw Object.assign(new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`), { status: resp.status, retryAfter });
    }
    return resp.json();
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function callClaudeFast(opts) {
  return callClaude({ ...opts, model: opts.model || FAST_MODEL });
}

const STREAM_IDLE_TIMEOUT_MS = 30_000;

export async function streamClaude({ system, messages, maxTokens, model, token, temperature, onDelta, onDone, onError, signal }) {
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
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;

  const controller = new AbortController();
  let idleAborted = false;
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const resp = await fetch(`${GATEWAY_BASE}/v1/messages`, {
    method: 'POST',
    headers: buildHeaders(t),
    body: JSON.stringify(body),
    signal: controller.signal
  }).catch(err => {
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
    if (onError) onError(err);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

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

