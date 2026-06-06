export async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

export async function localSet(obj) {
  return chrome.storage.local.set(obj);
}
