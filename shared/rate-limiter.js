const RPM_LIMIT = 48;
const WINDOW_MS = 60_000;

let _callTimestamps = [];

export async function acquireSlot() {
  const now = Date.now();
  _callTimestamps = _callTimestamps.filter(ts => now - ts < WINDOW_MS);
  if (_callTimestamps.length >= RPM_LIMIT) {
    const oldest = _callTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 50;
    await new Promise(r => setTimeout(r, waitMs));
    return acquireSlot();
  }
  _callTimestamps.push(Date.now());
}

export function getUsage() {
  const now = Date.now();
  _callTimestamps = _callTimestamps.filter(ts => now - ts < WINDOW_MS);
  return { used: _callTimestamps.length, limit: RPM_LIMIT, window: WINDOW_MS };
}
