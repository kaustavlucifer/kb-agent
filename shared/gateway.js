import { GATEWAY_BASE, ANTHROPIC_VERSION, DEFAULT_MODEL, FAST_MODEL, CLAUDE_TIMEOUT_MS } from './config.js';
import { localGet } from './storage.js';
import { acquireSlot } from './rate-limiter.js';

async function getToken() {
  const data = await localGet(['gatewayToken']);
  return data.gatewayToken || null;
}

async function getModel(preferFast = false) {
  const data = await localGet(['modelName']);
  if (data.modelName) return data.modelName;
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

export async function callClaude({ system, messages, maxTokens, model, token, temperature }) {
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
  if (temperature != null) body.temperature = temperature;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
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
  }
}

export async function callClaudeFast(opts) {
  return callClaude({ ...opts, model: opts.model || FAST_MODEL });
}

export async function streamClaude({ system, messages, maxTokens, model, token, temperature, onDelta, onDone, onError }) {
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

  const resp = await fetch(`${GATEWAY_BASE}/v1/messages`, {
    method: 'POST',
    headers: buildHeaders(t),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`Gateway ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    if (onError) onError(err);
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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

export async function callWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await callClaude(opts);
    } catch (e) {
      lastErr = e;
      if (e.status === 429) {
        const wait = e.retryAfter ? parseInt(e.retryAfter, 10) * 1000 : Math.min(2000 * Math.pow(2, i), 30000);
        await new Promise(r => setTimeout(r, wait));
      } else if (e.status >= 500) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}
