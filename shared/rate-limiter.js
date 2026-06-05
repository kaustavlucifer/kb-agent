const RPM_LIMIT = 48;
const WINDOW_MS = 60_000;
const STORAGE_KEY = '_rateLimiterTs';

let _callTimestamps = [];
let _loaded = false;

async function loadTimestamps() {
  if (_loaded) return;
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY);
    if (Array.isArray(data[STORAGE_KEY])) {
      const now = Date.now();
      _callTimestamps = data[STORAGE_KEY].filter(ts => now - ts < WINDOW_MS);
    }
  } catch {}
  _loaded = true;
}

function persistTimestamps() {
  chrome.storage.session.set({ [STORAGE_KEY]: _callTimestamps }).catch(() => {});
}

export async function acquireSlot() {
  await loadTimestamps();
  const now = Date.now();
  _callTimestamps = _callTimestamps.filter(ts => now - ts < WINDOW_MS);
  if (_callTimestamps.length >= RPM_LIMIT) {
    const oldest = _callTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 50;
    await new Promise(r => setTimeout(r, waitMs));
    return acquireSlot();
  }
  _callTimestamps.push(Date.now());
  persistTimestamps();
}

export function getUsage() {
  const now = Date.now();
  _callTimestamps = _callTimestamps.filter(ts => now - ts < WINDOW_MS);
  return { used: _callTimestamps.length, limit: RPM_LIMIT, window: WINDOW_MS };
}
