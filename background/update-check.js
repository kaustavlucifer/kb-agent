import { localGet, localSet } from '../shared/storage.js';
import { STORAGE_KEYS, CACHE_TTL_MS } from '../shared/config.js';

const DRIVE_FILE_ID = '1Tom6BWVDkDrlxRveInGaSjKrIgjNuSp6';
const VIEW_URL = `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`;
const DOWNLOAD_URL = `https://drive.google.com/uc?export=download&id=${DRIVE_FILE_ID}`;
const FILE_NAME_RX = /kb-agent-v(\d+(?:\.\d+)*)\.zip/i;

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchLatestVersion() {
  const res = await fetch(VIEW_URL, { credentials: 'include' });
  if (!res.ok) throw new Error(`Drive returned ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const m = title.match(FILE_NAME_RX);
  if (!m) throw new Error('could not read the file name from Drive (not signed in to Google?)');
  return m[1];
}

export async function checkForUpdate({ force = false } = {}) {
  const current = chrome.runtime.getManifest().version;
  const stored = (await localGet(STORAGE_KEYS.UPDATE_CHECK))[STORAGE_KEYS.UPDATE_CHECK] || {};
  let latest = stored.latest;
  const fresh = stored.checkedAt && Date.now() - stored.checkedAt < CACHE_TTL_MS;
  if (force || !fresh) {
    try {
      latest = await fetchLatestVersion();
      await localSet({ [STORAGE_KEYS.UPDATE_CHECK]: { ...stored, latest, checkedAt: Date.now() } });
    } catch (e) {
      return { ok: false, current, error: e.message };
    }
  }
  const newer = !!latest && compareVersions(latest, current) > 0;
  return {
    ok: true,
    current,
    latest,
    updateAvailable: newer && (force || stored.dismissed !== latest),
    downloadUrl: DOWNLOAD_URL
  };
}

export async function dismissUpdate(version) {
  const stored = (await localGet(STORAGE_KEYS.UPDATE_CHECK))[STORAGE_KEYS.UPDATE_CHECK] || {};
  await localSet({ [STORAGE_KEYS.UPDATE_CHECK]: { ...stored, dismissed: version } });
}
