import { SF_API_VERSION } from './config.js';

const ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export function sanitizeId(id) {
  if (!id || !ID_RE.test(id)) throw new Error(`Invalid Salesforce ID: ${id}`);
  return id;
}

export function escapeSoql(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function escapeSosl(str) {
  return String(str || '').replace(/[?&|!{}[\]()^~*:\\"'+\-]/g, '\\$&');
}

export async function sfGet(url, sid) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${sid}`, Accept: 'application/json' }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SF API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export async function sfPost(url, sid, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sid}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SF API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export async function sfQuery(apiBase, sid, soql) {
  const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const result = await sfGet(url, sid);
  const records = [...(result.records || [])];
  let next = result.nextRecordsUrl;
  while (next) {
    const page = await sfGet(`${apiBase}${next}`, sid);
    records.push(...(page.records || []));
    next = page.nextRecordsUrl;
  }
  return records;
}

export async function sfSearch(apiBase, sid, sosl) {
  const url = `${apiBase}/services/data/${SF_API_VERSION}/search?q=${encodeURIComponent(sosl)}`;
  const result = await sfGet(url, sid);
  return result.searchRecords || [];
}

export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
