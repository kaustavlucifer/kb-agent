import { SF_API_VERSION, MAX_REWRITE_IMAGES_PER_ARTICLE, MAX_IMAGE_FETCH_BYTES, SUPPORTED_IMAGE_MEDIA_TYPES } from './config.js';

export const ID_RE = /^[a-zA-Z0-9]{15,18}$/;

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

export async function sfGet(url, sid, signal) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${sid}`, Accept: 'application/json' },
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SF API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export async function sfPost(url, sid, body, signal) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sid}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SF API ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

export async function sfPatch(url, sid, body, signal) {
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${sid}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`SF API ${resp.status}: ${text.slice(0, 200)}`);
  }
  if (resp.status === 204) return {};
  return resp.json();
}

export async function sfQuery(apiBase, sid, soql, signal) {
  const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const result = await sfGet(url, sid, signal);
  const records = [...(result.records || [])];
  let next = result.nextRecordsUrl;
  while (next) {
    const page = await sfGet(`${apiBase}${next}`, sid, signal);
    records.push(...(page.records || []));
    next = page.nextRecordsUrl;
  }
  return records;
}

export async function sfSearch(apiBase, sid, sosl, signal) {
  const url = `${apiBase}/services/data/${SF_API_VERSION}/search?q=${encodeURIComponent(sosl)}`;
  const result = await sfGet(url, sid, signal);
  return result.searchRecords || [];
}

export async function sfQueryAll(apiBase, sid, soql, onProgress, signal) {
  const url = `${apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const result = await sfGet(url, sid, signal);
  const records = [...(result.records || [])];
  if (onProgress) onProgress(records.length, result.totalSize || records.length);
  let next = result.nextRecordsUrl;
  while (next) {
    const page = await sfGet(`${apiBase}${next}`, sid, signal);
    records.push(...(page.records || []));
    if (onProgress) onProgress(records.length, result.totalSize || records.length);
    next = page.nextRecordsUrl;
  }
  return records;
}

export function soqlIdList(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('soqlIdList: non-empty array required');
  return ids.map(id => `'${sanitizeId(id)}'`).join(',');
}

export async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { __error: e?.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function absolutizeSfUrls(html, base) {
  if (!html) return html;
  return html.replace(/((?:src|href)\s*=\s*)(["'])\/(?!\/)/gi, `$1$2${base}/`);
}

export function stripHtmlKeepLinks(html, base) {
  if (!html) return '';
  const absolutized = base ? absolutizeSfUrls(html, base) : html;
  const withImages = absolutized.replace(
    /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*)\1[^>]*>/gi,
    (full, quote, src) => {
      if (!src) return '';
      const altMatch = full.match(/\balt\s*=\s*(["'])([^"']*)\1/i);
      const alt = altMatch ? altMatch[2] : '';
      return `![${alt}](${src})`;
    }
  );
  const withLinks = withImages.replace(
    /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_, quote, href, inner) => {
      const text = stripHtml(inner).replace(/\s+/g, ' ').trim();
      if (!href || href === '#' || !text) return text;
      return `[${text}](${href})`;
    }
  );
  return stripHtml(withLinks);
}

function extractMarkdownImageRefs(markdown) {
  if (!markdown) return [];
  const refs = [];
  const seen = new Set();
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const [, alt, src] = m;
    if (seen.has(src)) continue;
    seen.add(src);
    refs.push({ alt, src });
  }
  return refs;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsBase64(src, sid, signal) {
  let resp = null;
  try {
    resp = await fetch(src, { headers: { Authorization: `Bearer ${sid}` }, signal });
  } catch {}
  if (!resp?.ok) {
    try {
      resp = await fetch(src, { credentials: 'include', signal });
    } catch {
      return null;
    }
  }
  if (!resp.ok) return null;
  try {
    const mediaType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(mediaType)) return null;
    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (contentLength > MAX_IMAGE_FETCH_BYTES) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_FETCH_BYTES) return null;
    return { mediaType, data: arrayBufferToBase64(buf) };
  } catch {
    return null;
  }
}

async function fetchImageContentBlocks(refs, sid, signal, maxImages = MAX_REWRITE_IMAGES_PER_ARTICLE) {
  const capped = refs.slice(0, maxImages);
  const images = await mapWithConcurrency(capped, maxImages, (ref) => fetchImageAsBase64(ref.src, sid, signal));
  const blocks = [];
  for (let i = 0; i < capped.length; i++) {
    const img = images[i];
    if (!img || img.__error) continue;
    blocks.push({ type: 'text', text: `The image referenced as ![${capped[i].alt}](${capped[i].src}) is attached below:` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  return blocks;
}

export async function buildPromptContent(text, sid, signal, maxImages) {
  const imageRefs = extractMarkdownImageRefs(text);
  const imageBlocks = imageRefs.length ? await fetchImageContentBlocks(imageRefs, sid, signal, maxImages) : [];
  return imageBlocks.length ? [{ type: 'text', text }, ...imageBlocks] : text;
}

export function hasCodeBlocks(html) {
  return /<pre[^>]*class="[^"]*ckeditor_codeblock[^"]*"/i.test(html || '');
}

export function hasHeaders(html) {
  return /<h[2-6][\s>]/i.test(html || '');
}

export function hasTables(html) {
  return /<table[\s>]/i.test(html || '');
}

export function hasAltText(html) {
  if (!html) return true;
  const imgs = html.match(/<img[^>]+>/gi) || [];
  if (!imgs.length) return true;
  return imgs.every(tag => /alt\s*=\s*["'][^"']{3,}/i.test(tag));
}
