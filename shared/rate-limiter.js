const DEFAULT_RPM_LIMIT = 48;
const RPM_SAFETY_RATIO = 0.9;
const WINDOW_MS = 60_000;
const CATALOG_KEY = 'kba_model_catalog';
const IS_SERVICE_WORKER = typeof window === 'undefined';
const OWN_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsSw' : '_rateLimiterTsUi';
const OTHER_KEY = IS_SERVICE_WORKER ? '_rateLimiterTsUi' : '_rateLimiterTsSw';

let _ownTimestamps = [];
let _rpmLimit = DEFAULT_RPM_LIMIT;

function applyLimits(catalog) {
  const rpm = Number(catalog?.limits?.rpmLimit);
  _rpmLimit = Number.isFinite(rpm) && rpm > 0 ? Math.max(1, Math.floor(rpm * RPM_SAFETY_RATIO)) : DEFAULT_RPM_LIMIT;
}

chrome.storage.local.get(CATALOG_KEY).then(d => applyLimits(d[CATALOG_KEY])).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CATALOG_KEY]) applyLimits(changes[CATALOG_KEY].newValue);
});

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
  if (all.length >= _rpmLimit) {
    const waitMs = WINDOW_MS - (Date.now() - all[0]) + 50;
    await new Promise(r => setTimeout(r, Math.max(waitMs, 50)));
    return acquireSlot();
  }
  _ownTimestamps.push(Date.now());
  chrome.storage.session.set({ [OWN_KEY]: _ownTimestamps }).catch(() => {});
}
