import { sfSearch, sfQuery, soqlIdList, mapWithConcurrency } from '../shared/api.js';
import { classifySignature, SIGNATURE_PHRASE } from '../shared/signature.js';

const WINDOW_DAYS = 14;
const PAGE_LIMIT = 1000;
const MAX_CONCURRENT = 6;
const RESOLVE_BATCH_SIZE = 200;

function buildSlices(monthsBack) {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - monthsBack);
  const slices = [];
  let upper = now;
  while (upper > from) {
    const lowerMs = upper.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const lower = new Date(Math.max(lowerMs, from.getTime()));
    slices.push({ from: lower, to: upper });
    upper = lower;
  }
  return slices;
}

function buildFeedSosl(from, to) {
  return `FIND {"${SIGNATURE_PHRASE}"} IN ALL FIELDS RETURNING FeedItem(Id, ParentId, CreatedBy.Name, CreatedDate, Body WHERE Type = 'TextPost' AND Visibility = 'InternalUsers' AND CreatedDate > ${from.toISOString()} AND CreatedDate <= ${to.toISOString()} ORDER BY CreatedDate DESC LIMIT ${PAGE_LIMIT})`;
}

async function drainWindow(apiBase, sid, from, to, signal, rowsOut, seenIds) {
  let upper = to;
  while (true) {
    if (signal?.aborted) return;
    const rows = await sfSearch(apiBase, sid, buildFeedSosl(from, upper), signal);
    for (const r of rows) {
      if (seenIds.has(r.Id)) continue;
      seenIds.add(r.Id);
      const kind = classifySignature(r.Body);
      if (!kind) continue;
      rowsOut.push({ kind, author: r.CreatedBy?.Name || 'Unknown', parentId: r.ParentId, date: r.CreatedDate });
    }
    if (rows.length < PAGE_LIMIT) break;
    const oldest = rows[rows.length - 1]?.CreatedDate;
    if (!oldest) break;
    upper = new Date(oldest);
  }
}

async function resolveNames(apiBase, sid, ids, soqlTemplate, mapFn, signal) {
  const map = new Map();
  if (!ids.length) return map;
  const batches = [];
  for (let i = 0; i < ids.length; i += RESOLVE_BATCH_SIZE) batches.push(ids.slice(i, i + RESOLVE_BATCH_SIZE));
  await mapWithConcurrency(batches, MAX_CONCURRENT, async (batch) => {
    try {
      const records = await sfQuery(apiBase, sid, soqlTemplate(batch), signal);
      for (const r of records) map.set(r.Id, mapFn(r));
    } catch {}
  }, signal);
  return map;
}

const KIND_TARGET = {
  'case-scan': 'case',
  'article-scored': 'article',
  'rewrite-generated': 'article',
  'rewrite-published': 'article',
  'ki-created': 'ki',
  'ki-updated': 'ki',
  'ki-rewrite-generated': 'ki',
  'ki-scored': 'ki'
};

const DEFAULT_BY_KIND = Object.fromEntries(Object.keys(KIND_TARGET).map(k => [k, 0]));

export async function auditSignatures(apiBase, sid, { monthsBack = 3, onProgress, signal } = {}) {
  const slices = buildSlices(monthsBack);
  const rows = [];
  const seenIds = new Set();
  let done = 0;
  let failedSlices = 0;
  let firstError = null;
  await mapWithConcurrency(slices, MAX_CONCURRENT, async (slice) => {
    try {
      await drainWindow(apiBase, sid, slice.from, slice.to, signal, rows, seenIds);
    } catch (e) {
      if (!signal?.aborted) {
        failedSlices++;
        if (!firstError) firstError = e?.message || 'Search failed';
      }
    }
    done++;
    if (onProgress) onProgress(done, slices.length);
  }, signal);

  if (signal?.aborted) {
    const err = new Error('Audit aborted');
    err.name = 'AbortError';
    throw err;
  }

  const caseIds = [...new Set(rows.filter(r => KIND_TARGET[r.kind] === 'case').map(r => r.parentId))];
  const articleIds = [...new Set(rows.filter(r => KIND_TARGET[r.kind] === 'article').map(r => r.parentId))];
  const kiIds = [...new Set(rows.filter(r => KIND_TARGET[r.kind] === 'ki').map(r => r.parentId))];

  const [cases, articles, kis] = await Promise.all([
    resolveNames(apiBase, sid, caseIds, batch => `SELECT Id, CaseNumber FROM Case WHERE Id IN (${soqlIdList(batch)})`, r => `Case #${r.CaseNumber}`, signal),
    resolveNames(apiBase, sid, articleIds, batch => `SELECT Id, ArticleNumber, Title FROM Knowledge__kav WHERE Id IN (${soqlIdList(batch)})`, r => `#${r.ArticleNumber} ${r.Title}`, signal),
    resolveNames(apiBase, sid, kiIds, batch => `SELECT Id, Name, Subject__c FROM Known_Issue__c WHERE Id IN (${soqlIdList(batch)})`, r => `${r.Name}${r.Subject__c ? ' — ' + r.Subject__c : ''}`, signal)
  ]);

  const byMonth = {};
  const byAuthor = {};
  const byKind = { ...DEFAULT_BY_KIND };
  const perRecord = new Map();

  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const monthKey = String(r.date || '').slice(0, 7);
    byMonth[monthKey] = (byMonth[monthKey] || 0) + 1;
    byAuthor[r.author] = (byAuthor[r.author] || 0) + 1;

    const target = KIND_TARGET[r.kind];
    const names = target === 'case' ? cases : target === 'ki' ? kis : articles;
    const label = names.get(r.parentId) || r.parentId;
    const key = `${r.kind}:${r.parentId}`;
    if (!perRecord.has(key)) perRecord.set(key, { label, kind: r.kind, parentId: r.parentId, count: 0, lastDate: r.date });
    const entry = perRecord.get(key);
    entry.count++;
    if (r.date > entry.lastDate) entry.lastDate = r.date;
  }

  const months = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count }));
  const authors = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  const records = [...perRecord.values()].sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));

  return {
    total: rows.length,
    byKind,
    months,
    authors,
    records,
    windowFrom: slices.length ? slices[slices.length - 1].from.toISOString() : null,
    windowTo: slices.length ? slices[0].to.toISOString() : null,
    failedSlices,
    totalSlices: slices.length,
    firstError
  };
}

export function mergeAuditReports(a, b) {
  const byKind = { ...a.byKind };
  for (const [k, v] of Object.entries(b.byKind)) byKind[k] = (byKind[k] || 0) + v;

  const monthMap = new Map(a.months.map(m => [m.label, m.count]));
  for (const m of b.months) monthMap.set(m.label, (monthMap.get(m.label) || 0) + m.count);
  const months = [...monthMap.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([label, count]) => ({ label, count }));

  const authorMap = new Map(a.authors.map(x => [x.label, x.count]));
  for (const x of b.authors) authorMap.set(x.label, (authorMap.get(x.label) || 0) + x.count);
  const authors = [...authorMap.entries()].sort((x, y) => y[1] - x[1]).map(([label, count]) => ({ label, count }));

  const mergedRecords = new Map();
  for (const r of [...a.records, ...b.records]) {
    const key = `${r.kind}:${r.parentId}`;
    const existing = mergedRecords.get(key);
    if (!existing) {
      mergedRecords.set(key, { ...r });
    } else {
      existing.count += r.count;
      if ((r.lastDate || '') > (existing.lastDate || '')) existing.lastDate = r.lastDate;
    }
  }
  const records = [...mergedRecords.values()].sort((x, y) => (y.lastDate || '').localeCompare(x.lastDate || ''));

  return {
    total: a.total + b.total,
    byKind,
    months,
    authors,
    records,
    windowFrom: [a.windowFrom, b.windowFrom].filter(Boolean).sort()[0] || null,
    windowTo: [a.windowTo, b.windowTo].filter(Boolean).sort().slice(-1)[0] || null,
    failedSlices: (a.failedSlices || 0) + (b.failedSlices || 0),
    totalSlices: (a.totalSlices || 0) + (b.totalSlices || 0),
    firstError: a.firstError || b.firstError || null
  };
}
