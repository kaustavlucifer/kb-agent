import { STORAGE_KEYS } from './config.js';

const DEFAULT_RPM_LIMIT = 48;
const RPM_SAFETY_RATIO = 0.9;
const WINDOW_MS = 60_000;
const IS_SERVICE_WORKER = typeof window === 'undefined';
const KEY_PREFIX = '_rateLimiterTs_';
const OWN_KEY = IS_SERVICE_WORKER ? `${KEY_PREFIX}sw` : `${KEY_PREFIX}ui_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let _ownTimestamps = [];
const _otherTimestamps = new Map();
let _rpmLimit = DEFAULT_RPM_LIMIT;

function applyLimits(catalog) {
  const rpm = Number(catalog?.limits?.rpmLimit);
  _rpmLimit = Number.isFinite(rpm) && rpm > 0 ? Math.max(1, Math.floor(rpm * RPM_SAFETY_RATIO)) : DEFAULT_RPM_LIMIT;
}

function recent(value, now = Date.now()) {
  return Array.isArray(value) ? value.filter(ts => now - ts < WINDOW_MS) : [];
}

function setOther(key, value) {
  const ts = recent(value);
  if (ts.length) _otherTimestamps.set(key, ts);
  else _otherTimestamps.delete(key);
}

async function loadSessionTimestamps() {
  const all = await chrome.storage.session.get(null);
  const stale = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    if (key === OWN_KEY) { _ownTimestamps = recent(value); continue; }
    if (recent(value).length) setOther(key, value);
    else stale.push(key);
  }
  if (stale.length) await chrome.storage.session.remove(stale);
}

chrome.storage.local.get(STORAGE_KEYS.MODEL_CATALOG).then(d => applyLimits(d[STORAGE_KEYS.MODEL_CATALOG])).catch(() => {});
const _ready = loadSessionTimestamps().catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.MODEL_CATALOG]) applyLimits(changes[STORAGE_KEYS.MODEL_CATALOG].newValue);
  if (area !== 'session') return;
  for (const [key, change] of Object.entries(changes)) {
    if (key.startsWith(KEY_PREFIX) && key !== OWN_KEY) setOther(key, change.newValue);
  }
});
if (!IS_SERVICE_WORKER) {
  window.addEventListener('pagehide', () => { chrome.storage.session.remove(OWN_KEY).catch(() => {}); });
}

export function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function acquireSlot(signal) {
  await _ready;
  while (true) {
    if (signal?.aborted) throw abortError();
    const now = Date.now();
    _ownTimestamps = recent(_ownTimestamps, now);
    const all = [..._ownTimestamps];
    for (const ts of _otherTimestamps.values()) all.push(...recent(ts, now));
    all.sort((a, b) => a - b);
    if (all.length < _rpmLimit) {
      _ownTimestamps.push(now);
      chrome.storage.session.set({ [OWN_KEY]: _ownTimestamps }).catch(() => {});
      return;
    }
    const oldestIndex = all.length - _rpmLimit;
    await sleep(Math.max(WINDOW_MS - (now - all[oldestIndex]) + 50 + Math.floor(Math.random() * 200), 50), signal);
  }
}
