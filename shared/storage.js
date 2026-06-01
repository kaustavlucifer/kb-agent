export async function cacheGet(key, ttlMs) {
  const result = await chrome.storage.local.get([key, `${key}__ts`]);
  const value = result[key];
  const ts = result[`${key}__ts`];
  if (value == null || ts == null) return null;
  if (ttlMs && Date.now() - ts > ttlMs) return null;
  return value;
}

export async function cacheSet(key, value) {
  await chrome.storage.local.set({ [key]: value, [`${key}__ts`]: Date.now() });
}

export async function cacheClear(key) {
  await chrome.storage.local.remove([key, `${key}__ts`]);
}

export async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

export async function localSet(obj) {
  return chrome.storage.local.set(obj);
}

export async function sessionGet(key) {
  const r = await chrome.storage.session.get(key);
  return r[key] ?? null;
}

export async function sessionSet(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

export async function sessionRemove(key) {
  await chrome.storage.session.remove(key);
}
