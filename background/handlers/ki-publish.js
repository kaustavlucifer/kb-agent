import { sfPost, sfPatch, sfQuery, sfQueryAll, escapeSoql, sanitizeId, stripHtmlKeepLinks } from '../../shared/api.js';
import { detectKiSession } from '../../shared/auth.js';
import { SF_API_VERSION, CACHE_TTL_MS, STORAGE_KEYS, SCORING_MODEL, KI_BASE } from '../../shared/config.js';
import { callClaude, extractText, extractJson } from '../../shared/gateway.js';
import { redactPii } from '../../shared/pii.js';
import { KI_PII_OPTS, KI_SYSTEM_PROMPT } from '../../shared/ki-prompts.js';
import { markdownToHtml } from '../../shared/markdown.js';
import { fetchArticleChatterBatch } from '../../shared/scoring.js';
import { logSignature } from '../../shared/signature.js';
import { localGet, localSet } from '../../shared/storage.js';
import { KI_CATEGORIES } from '../../data/ki_mapping.js';

function publicWorkSubject(subject) {
  return String(subject || '')
    .replace(/^(?:\s*\[[^\]]*\])+\s*/, '')
    .replace(/^(?:[A-Za-z]+\s*-\s*)?\d{8,9}\s*-\s*[^-]+?\s+-\s*/, '')
    .replace(/^-\s*/, '')
    .trim();
}

export async function generateKiDraftContent(caseRecord, comments, chatterNotes, signal, gusItems = []) {
  const commentText = comments.slice(0, 8).map(c => c.CommentBody?.slice(0, 400)).filter(Boolean).join('\n');
  const gusText = gusItems.slice(0, 3).map(g => `${g.recordType || 'Work'}: ${publicWorkSubject(g.subject)} (${g.status || ''})${(g.linkedBugs || []).map(b => `; follow-up ${b.recordType}: ${publicWorkSubject(b.subject)} (${b.status || ''})`).join('')}`).join('\n');
  const user = `Case Subject: ${redactPii(caseRecord.Subject || '', KI_PII_OPTS)}
Description: ${redactPii((caseRecord.Description || '').slice(0, 2000), KI_PII_OPTS)}
Comments:
${redactPii(commentText.slice(0, 3000), KI_PII_OPTS)}${gusText ? `\nLinked engineering work:\n${redactPii(gusText, KI_PII_OPTS)}` : ''}${chatterNotes ? `\nRelated Chatter notes:\n${redactPii(chatterNotes, KI_PII_OPTS)}` : ''}`;
  try {
    const resp = await callClaude({
      system: KI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      maxTokens: 3000,
      temperature: 0.2,
      model: SCORING_MODEL,
      signal
    });
    return extractJson(extractText(resp));
  } catch {
    return null;
  }
}

const KI_REPRO_FIELD = 'Repro__c';
const KI_OUTSIDE_CORE_FIELD = 'Outside_Core__c';
const KI_DISABLE_GUS_SYNC_FIELD = 'Disable_GUS_Sync__c';
const KI_DRAFT_SUBJECT_FIELD = 'DRAFTSubject__c';
const KI_DRAFT_SUMMARY_FIELD = 'DRAFTSummary__c';
const KI_DRAFT_REPRO_FIELD = 'DRAFTRepro__c';
const KI_DRAFT_WORKAROUND_FIELD = 'DRAFTWorkaround__c';

function kiRichText(markdown) {
  const text = redactPii(markdown || '', KI_PII_OPTS).trim();
  return text ? markdownToHtml(text, { headingBase: 3 }) : '';
}

export function kiUrl(lightningHost, id) {
  return `${lightningHost ? `https://${lightningHost}` : KI_BASE}/lightning/r/Known_Issue__c/${id}/view`;
}

export async function fetchKnownIssueDetail(id, session) {
  session = session || await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session.' };
  let safeId;
  try { safeId = sanitizeId(id); } catch (e) { return { success: false, error: e.message }; }

  try {
    const soql = `SELECT Id, Name, Subject__c, Summary__c, Status__c, Cloud__c, Workaround__c, ${KI_REPRO_FIELD}, ${KI_DRAFT_SUBJECT_FIELD}, ${KI_DRAFT_SUMMARY_FIELD}, ${KI_DRAFT_REPRO_FIELD}, ${KI_DRAFT_WORKAROUND_FIELD} FROM Known_Issue__c WHERE Id = '${safeId}' LIMIT 1`;
    const records = await sfQuery(session.apiBase, session.sid, soql);
    if (!records.length) return { success: false, error: 'Known Issue not found.' };
    const r = records[0];
    return {
      success: true,
      ki: {
        id: r.Id,
        name: r.Name,
        subject: r.Subject__c || '',
        summary: stripHtmlKeepLinks(r.Summary__c || '', session.apiBase),
        status: r.Status__c || '',
        cloud: r.Cloud__c || '',
        workaround: stripHtmlKeepLinks(r.Workaround__c || '', session.apiBase),
        repro: stripHtmlKeepLinks(r[KI_REPRO_FIELD] || '', session.apiBase),
        draft: {
          subject: r[KI_DRAFT_SUBJECT_FIELD] || '',
          summary: stripHtmlKeepLinks(r[KI_DRAFT_SUMMARY_FIELD] || '', session.apiBase),
          repro: stripHtmlKeepLinks(r[KI_DRAFT_REPRO_FIELD] || '', session.apiBase),
          workaround: stripHtmlKeepLinks(r[KI_DRAFT_WORKAROUND_FIELD] || '', session.apiBase)
        }
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function loadKiRewriteContext(kiId, session) {
  const detail = await fetchKnownIssueDetail(kiId, session);
  if (!detail.success) return detail;

  let chatterNotes = '';
  let chatterError;
  if (session.sid) {
    try {
      const chatterMap = await fetchArticleChatterBatch([detail.ki.id], session, 'Known_Issue__Feed');
      chatterNotes = chatterMap.get(detail.ki.id) || '';
    } catch (e) {
      chatterError = e.message;
    }
  }

  const pendingDraft = detail.ki.draft;
  const basedOnDraft = !!(pendingDraft && (pendingDraft.subject || pendingDraft.summary || pendingDraft.repro || pendingDraft.workaround));
  const basis = basedOnDraft
    ? {
      subject: pendingDraft.subject || detail.ki.subject,
      summary: pendingDraft.summary || detail.ki.summary,
      repro: pendingDraft.repro || detail.ki.repro,
      workaround: pendingDraft.workaround || detail.ki.workaround
    }
    : { subject: detail.ki.subject, summary: detail.ki.summary, repro: detail.ki.repro, workaround: detail.ki.workaround };

  return { success: true, ki: detail.ki, basis, basedOnDraft, chatterNotes, chatterError };
}

export async function prepareKiRewrite(kiId) {
  const session = await detectKiSession();
  const ctx = await loadKiRewriteContext(kiId, session);
  if (!ctx.success) return ctx;
  const { ki, ...rest } = ctx;
  return { ...rest, live: { subject: ki.subject, summary: ki.summary, repro: ki.repro, workaround: ki.workaround } };
}

export async function logKiSignature(kind, kiId) {
  if (!['ki-rewrite-generated', 'ki-scored'].includes(kind)) return { ok: false };
  const session = await detectKiSession();
  if (session.sid) logSignature(kind, session.apiBase, session.sid, kiId);
  return { ok: true };
}

const kiCategoryIdCache = new Map();

async function resolveKiCategoryId(session, categoryName) {
  const cacheKey = `${session.apiBase}|${categoryName}`;
  if (kiCategoryIdCache.has(cacheKey)) return kiCategoryIdCache.get(cacheKey);
  const escaped = escapeSoql(categoryName);
  const soql = `SELECT Category__c FROM Known_Issue__c WHERE Category__r.Name = '${escaped}' AND Category__c != null LIMIT 1`;
  const records = await sfQuery(session.apiBase, session.sid, soql);
  const id = records[0]?.Category__c || null;
  if (id) kiCategoryIdCache.set(cacheKey, id);
  return id;
}

export async function createKnownIssue(payload) {
  const session = await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session. Log into the Known Issues org first.' };

  const categoryId = await resolveKiCategoryId(session, payload.category);
  if (!categoryId) {
    return { success: false, error: `Could not resolve Known Issue category "${payload.category}" to a record Id.` };
  }

  const record = {
    [KI_DRAFT_SUBJECT_FIELD]: redactPii(payload.subject || '', KI_PII_OPTS).slice(0, 255),
    [KI_DRAFT_SUMMARY_FIELD]: kiRichText(payload.summary),
    [KI_DRAFT_REPRO_FIELD]: kiRichText(payload.repro),
    [KI_DRAFT_WORKAROUND_FIELD]: kiRichText(payload.workaround),
    [KI_OUTSIDE_CORE_FIELD]: true,
    [KI_DISABLE_GUS_SYNC_FIELD]: false,
    Status__c: 'In Review',
    Category__c: categoryId
  };
  if (/^W-\d{4,9}$/.test(payload.workId || '')) record.Work_ID__c = payload.workId;

  try {
    const result = await sfPost(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Known_Issue__c`, session.sid, record);
    logSignature('ki-created', session.apiBase, session.sid, result.id);
    await chrome.storage.local.remove([STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]);
    return { success: true, id: result.id, url: kiUrl(session.lightningHost, result.id) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function updateKnownIssue(payload) {
  const session = await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session. Log into the Known Issues org first.' };
  let safeId;
  try { safeId = sanitizeId(payload.id); } catch (e) { return { success: false, error: e.message }; }

  const record = {
    [KI_DRAFT_SUBJECT_FIELD]: redactPii(payload.subject || '', KI_PII_OPTS).slice(0, 255),
    [KI_DRAFT_SUMMARY_FIELD]: kiRichText(payload.summary),
    [KI_DRAFT_REPRO_FIELD]: kiRichText(payload.repro),
    [KI_DRAFT_WORKAROUND_FIELD]: kiRichText(payload.workaround)
  };

  try {
    await sfPatch(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Known_Issue__c/${safeId}`, session.sid, record);
    logSignature('ki-updated', session.apiBase, session.sid, safeId);
    await chrome.storage.local.remove([STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]);
    return { success: true, id: safeId, url: kiUrl(session.lightningHost, safeId) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const KI_LIST_FIELDS = 'Id, Name, Subject__c, Status__c, Cloud__c, Category__r.Name, CreatedBy.Name, Approver__r.Name, Work_ID__c, Reporting_User_Count__c, CreatedDate, LastModifiedDate';

function mapKiListRecord(r, lightningHost) {
  return {
    id: r.Id,
    name: r.Name,
    subject: r.Subject__c || '',
    status: r.Status__c || '',
    cloud: r.Cloud__c || '',
    category: r.Category__r?.Name || '',
    createdByName: r.CreatedBy?.Name || '',
    approverName: r.Approver__r?.Name || '',
    workId: r.Work_ID__c || '',
    reportingCount: r.Reporting_User_Count__c || 0,
    createdDate: r.CreatedDate || '',
    lastModifiedDate: r.LastModifiedDate || '',
    url: kiUrl(lightningHost, r.Id)
  };
}

export async function searchKnownIssuesUnscoped(query) {
  if (!query || query.trim().length < 2) return { items: [] };
  const session = await detectKiSession();
  if (!session.sid) return { items: [], error: 'No Known Issues org session.' };

  const escaped = escapeSoql(query.trim());
  const soql = `SELECT ${KI_LIST_FIELDS} FROM Known_Issue__c WHERE Subject__c LIKE '%${escaped}%' OR Name LIKE '%${escaped}%' ORDER BY LastModifiedDate DESC LIMIT 50`;
  try {
    const records = await sfQuery(session.apiBase, session.sid, soql);
    return { items: records.map(r => mapKiListRecord(r, session.lightningHost)) };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

export async function loadAllKnownIssues({ forceLive = false } = {}) {
  if (!forceLive) {
    const cached = await localGet([STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]);
    const items = cached[STORAGE_KEYS.ALL_KNOWN_ISSUES];
    const at = cached[STORAGE_KEYS.ALL_KNOWN_ISSUES_AT];
    if (items?.length && at && (Date.now() - at < CACHE_TTL_MS)) {
      return { items, fromCache: true };
    }
  }

  const session = await detectKiSession();
  if (!session.sid) return { items: [], error: 'No Known Issues org session.' };

  const catList = KI_CATEGORIES.map(c => `'${escapeSoql(c)}'`).join(',');
  const soql = `SELECT ${KI_LIST_FIELDS} FROM Known_Issue__c WHERE Category__r.Name IN (${catList}) ORDER BY LastModifiedDate DESC`;

  try {
    const records = await sfQueryAll(session.apiBase, session.sid, soql);
    const items = records.map(r => mapKiListRecord(r, session.lightningHost));
    await localSet({ [STORAGE_KEYS.ALL_KNOWN_ISSUES]: items, [STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]: Date.now() });
    return { items, fromCache: false };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
