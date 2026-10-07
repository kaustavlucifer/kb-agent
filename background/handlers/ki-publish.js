import { sfPost, sfPatch, sfQuery, sfQueryAll, soqlIdList, escapeSoql, sanitizeId, stripHtmlKeepLinks } from '../../shared/api.js';
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

const KI_SECTION_KEYS = ['subject', 'summary', 'repro', 'workaround'];

function normalizeKiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function kiVersionsDiffer(published, draft) {
  return KI_SECTION_KEYS.some(k => normalizeKiText(published[k]) !== normalizeKiText(draft[k]));
}

function hasKiContent(sections) {
  return KI_SECTION_KEYS.some(k => normalizeKiText(sections[k]));
}

export function kiPublicationState({ published, approvalStatus, draftDiffers }) {
  if (published) {
    if (approvalStatus === 'Pending') return { label: 'Published · edits pending approval', tone: 'warning' };
    if (draftDiffers) return { label: 'Published · unsubmitted edits', tone: 'warning' };
    return { label: 'Published', tone: 'success' };
  }
  if (approvalStatus === 'Pending') return { label: 'Draft · pending approval', tone: 'info' };
  if (approvalStatus === 'Rejected') return { label: 'Draft · rejected', tone: 'error' };
  if (approvalStatus === 'Removed') return { label: 'Draft · approval recalled', tone: 'neutral' };
  if (approvalStatus === 'Approved') return { label: 'Unpublished', tone: 'neutral' };
  return { label: 'Draft · not submitted', tone: 'neutral' };
}

async function fetchLatestApproval(session, kiId) {
  const soql = `SELECT Status, CreatedDate, CompletedDate, (SELECT StepStatus, Comments, CreatedDate, Actor.Name FROM StepsAndWorkitems ORDER BY CreatedDate DESC LIMIT 1) FROM ProcessInstance WHERE TargetObjectId = '${kiId}' ORDER BY CreatedDate DESC LIMIT 1`;
  const records = await sfQuery(session.apiBase, session.sid, soql);
  const r = records[0];
  if (!r) return null;
  const step = r.StepsAndWorkitems?.records?.[0];
  return {
    status: r.Status,
    submittedDate: r.CreatedDate || '',
    completedDate: r.CompletedDate || '',
    actorName: step?.Actor?.Name || '',
    comment: step?.Comments || ''
  };
}

export async function fetchKnownIssueDetail(id, session) {
  session = session || await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session.' };
  let safeId;
  try { safeId = sanitizeId(id); } catch (e) { return { success: false, error: e.message }; }

  try {
    const soql = `SELECT Id, Name, Published__c, Subject__c, Summary__c, Status__c, Cloud__c, Workaround__c, ${KI_REPRO_FIELD}, ${KI_DRAFT_SUBJECT_FIELD}, ${KI_DRAFT_SUMMARY_FIELD}, ${KI_DRAFT_REPRO_FIELD}, ${KI_DRAFT_WORKAROUND_FIELD} FROM Known_Issue__c WHERE Id = '${safeId}' LIMIT 1`;
    const [records, approval] = await Promise.all([
      sfQuery(session.apiBase, session.sid, soql),
      fetchLatestApproval(session, safeId).catch(() => null)
    ]);
    if (!records.length) return { success: false, error: 'Known Issue not found.' };
    const r = records[0];
    const publishedVersion = {
      subject: r.Subject__c || '',
      summary: stripHtmlKeepLinks(r.Summary__c || '', session.apiBase),
      repro: stripHtmlKeepLinks(r[KI_REPRO_FIELD] || '', session.apiBase),
      workaround: stripHtmlKeepLinks(r.Workaround__c || '', session.apiBase)
    };
    const draftVersion = {
      subject: r[KI_DRAFT_SUBJECT_FIELD] || '',
      summary: stripHtmlKeepLinks(r[KI_DRAFT_SUMMARY_FIELD] || '', session.apiBase),
      repro: stripHtmlKeepLinks(r[KI_DRAFT_REPRO_FIELD] || '', session.apiBase),
      workaround: stripHtmlKeepLinks(r[KI_DRAFT_WORKAROUND_FIELD] || '', session.apiBase)
    };
    const published = r.Published__c === true;
    const draftDiffers = hasKiContent(draftVersion) && kiVersionsDiffer(publishedVersion, draftVersion);
    return {
      success: true,
      ki: {
        id: r.Id,
        name: r.Name,
        status: r.Status__c || '',
        cloud: r.Cloud__c || '',
        published,
        hasPublishedContent: hasKiContent(publishedVersion),
        draftDiffers,
        approval,
        publication: kiPublicationState({ published, approvalStatus: approval?.status, draftDiffers }),
        publishedVersion,
        draftVersion
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function kiWorkingVersion(ki) {
  const useDraft = hasKiContent(ki.draftVersion) && (!ki.published || ki.draftDiffers);
  const source = useDraft ? ki.draftVersion : ki.publishedVersion;
  return {
    sections: { subject: source.subject, summary: source.summary, repro: source.repro, workaround: source.workaround },
    version: useDraft ? (ki.published ? 'Draft (unpublished edits)' : 'Draft') : 'Published',
    basedOnDraft: useDraft
  };
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

  const working = kiWorkingVersion(detail.ki);
  return { success: true, ki: detail.ki, basis: working.sections, basedOnDraft: working.basedOnDraft, version: working.version, published: detail.ki.published, chatterNotes, chatterError };
}

export async function prepareKiRewrite(kiId) {
  const session = await detectKiSession();
  const ctx = await loadKiRewriteContext(kiId, session);
  if (!ctx.success) return ctx;
  const { ki, ...rest } = ctx;
  return rest;
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

const KI_LIST_FIELDS = 'Id, Name, Published__c, Subject__c, DRAFTSubject__c, Status__c, Cloud__c, Category__r.Name, CreatedBy.Name, Approver__r.Name, Work_ID__c, Reporting_User_Count__c, CreatedDate, LastModifiedDate';

function mapKiListRecord(r, lightningHost, approvalStatus) {
  const published = r.Published__c === true;
  const publishedSubject = r.Subject__c || '';
  const draftSubject = r[KI_DRAFT_SUBJECT_FIELD] || '';
  const subjectDiffers = !!draftSubject && normalizeKiText(draftSubject) !== normalizeKiText(publishedSubject);
  const publication = kiPublicationState({ published, approvalStatus, draftDiffers: subjectDiffers });
  return {
    id: r.Id,
    name: r.Name,
    published,
    subject: published ? (publishedSubject || draftSubject) : (draftSubject || publishedSubject),
    publishedSubject,
    draftSubject,
    publication: publication.label,
    publicationTone: publication.tone,
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

async function fetchApprovalStatuses(session, kiWhere) {
  const [latest, pending] = await Promise.all([
    sfQueryAll(session.apiBase, session.sid, `SELECT TargetObjectId, Status FROM ProcessInstance WHERE TargetObjectId IN (SELECT Id FROM Known_Issue__c WHERE ${kiWhere}) ORDER BY CreatedDate DESC`),
    sfQueryAll(session.apiBase, session.sid, `SELECT TargetObjectId FROM ProcessInstance WHERE Status = 'Pending' AND TargetObject.Type = 'Known_Issue__c'`)
  ]);
  const statuses = new Map();
  for (const r of latest) if (!statuses.has(r.TargetObjectId)) statuses.set(r.TargetObjectId, r.Status);
  for (const r of pending) statuses.set(r.TargetObjectId, 'Pending');
  return statuses;
}

export async function searchKnownIssuesUnscoped(query) {
  if (!query || query.trim().length < 2) return { items: [] };
  const session = await detectKiSession();
  if (!session.sid) return { items: [], error: 'No Known Issues org session.' };

  const escaped = escapeSoql(query.trim());
  const soql = `SELECT ${KI_LIST_FIELDS} FROM Known_Issue__c WHERE Subject__c LIKE '%${escaped}%' OR ${KI_DRAFT_SUBJECT_FIELD} LIKE '%${escaped}%' OR Name LIKE '%${escaped}%' ORDER BY LastModifiedDate DESC LIMIT 50`;
  try {
    const records = await sfQuery(session.apiBase, session.sid, soql);
    const approvals = records.length ? await fetchApprovalStatuses(session, `Id IN (${soqlIdList(records.map(r => r.Id))})`).catch(() => new Map()) : new Map();
    return { items: records.map(r => mapKiListRecord(r, session.lightningHost, approvals.get(r.Id))) };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

export async function loadAllKnownIssues({ forceLive = false } = {}) {
  if (!forceLive) {
    const cached = await localGet([STORAGE_KEYS.ALL_KNOWN_ISSUES, STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]);
    const items = cached[STORAGE_KEYS.ALL_KNOWN_ISSUES];
    const at = cached[STORAGE_KEYS.ALL_KNOWN_ISSUES_AT];
    if (items?.length && at && (Date.now() - at < CACHE_TTL_MS) && items[0].publication) {
      return { items, fromCache: true };
    }
  }

  const session = await detectKiSession();
  if (!session.sid) return { items: [], error: 'No Known Issues org session.' };

  const catList = KI_CATEGORIES.map(c => `'${escapeSoql(c)}'`).join(',');
  const soql = `SELECT ${KI_LIST_FIELDS} FROM Known_Issue__c WHERE Category__r.Name IN (${catList}) ORDER BY LastModifiedDate DESC`;

  try {
    const [records, approvals] = await Promise.all([
      sfQueryAll(session.apiBase, session.sid, soql),
      fetchApprovalStatuses(session, `Category__r.Name IN (${catList}) AND Published__c = false`).catch(() => new Map())
    ]);
    const items = records.map(r => mapKiListRecord(r, session.lightningHost, approvals.get(r.Id)));
    await localSet({ [STORAGE_KEYS.ALL_KNOWN_ISSUES]: items, [STORAGE_KEYS.ALL_KNOWN_ISSUES_AT]: Date.now() });
    return { items, fromCache: false };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
