const RPM_LIMIT = 48;
const WINDOW_MS = 60_000;
const IS_SERVICE_WORKER = typeof window === 'undefined';
const OWN_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsSw' : '_rateLimiterTsUi';
const OTHER_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsUi' : '_rateLimiterTsSw';

let _ownTimestamps = [];

async function windowTimestamps() {
  const now = Date.now();
  _ownTimestamps = _ownTimestamps.filter(ts => now - ts < WINDOW_MS);
  let other = [];
  try {
    const data = await chrome.storage.session.get(OTHER_KEY);
    if (Array.isArray(data[OTHER_KEY])) other = data[OTHER_KEY].filter(ts => now - ts < WINDOW_MS);
  } catch {}
  return [..._ownTimestamps, ...other].sort((a, b) => a - b);
}

export async function acquireSlot() {
  const all = await windowTimestamps();
  if (all.length >= RPM_LIMIT) {
    const waitMs = WINDOW_MS - (Date.now() - all[0]) + 50;
    await new Promise(r => setTimeout(r, Math.max(waitMs, 50)));
    return acquireSlot();
  }
  _ownTimestamps.push(Date.now());
  chrome.storage.session.set({ [OWN_KEY]: _ownTimestamps }).catch(() => {});
}
