import { STORAGE_KEYS } from './config.js';

const DEFAULT_RPM_LIMIT = 48;
const RPM_SAFETY_RATIO = 0.9;
const WINDOW_MS = 60_000;
const IS_SERVICE_WORKER = typeof window === 'undefined';
const OWN_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsSw' : '_rateLimiterTsUi';
const OTHER_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsUi' : '_rateLimiterTsSw';

let _ownTimestamps = [];
let _otherTimestamps = [];
let _rpmLimit = DEFAULT_RPM_LIMIT;

function applyLimits(catalog) {
  const rpm = Number(catalog?.limits?.rpmLimit);
  _rpmLimit = Number.isFinite(rpm) && rpm > 0 ? Math.max(1, Math.floor(rpm * RPM_SAFETY_RATIO)) : DEFAULT_RPM_LIMIT;
}

function setOther(value) {
  _otherTimestamps = Array.isArray(value) ? value : [];
}

chrome.storage.local.get(STORAGE_KEYS.MODEL_CATALOG).then(d => applyLimits(d[STORAGE_KEYS.MODEL_CATALOG])).catch(() => {});
chrome.storage.session.get(OTHER_KEY).then(d => setOther(d[OTHER_KEY])).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.MODEL_CATALOG]) applyLimits(changes[STORAGE_KEYS.MODEL_CATALOG].newValue);
  if (area === 'session' && changes[OTHER_KEY]) setOther(changes[OTHER_KEY].newValue);
});

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function acquireSlot(signal) {
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const now = Date.now();
    _ownTimestamps = _ownTimestamps.filter(ts => now - ts < WINDOW_MS);
    const all = [..._ownTimestamps, ..._otherTimestamps.filter(ts => now - ts < WINDOW_MS)].sort((a, b) => a - b);
    if (all.length < _rpmLimit) {
      _ownTimestamps.push(now);
      chrome.storage.session.set({ [OWN_KEY]: _ownTimestamps }).catch(() => {});
      return;
    }
    const oldestIndex = all.length - _rpmLimit;
    await sleep(Math.max(WINDOW_MS - (now - all[oldestIndex]) + 50 + Math.floor(Math.random() * 200), 50), signal);
  }
}
