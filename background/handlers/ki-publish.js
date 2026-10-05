import { sfPost, sfPatch, sfQuery, sfQueryAll, escapeSoql, sanitizeId, stripHtmlKeepLinks } from '../../shared/api.js';
import { detectKiSession } from '../../shared/auth.js';
import { SF_API_VERSION, CACHE_TTL_MS, STORAGE_KEYS } from '../../shared/config.js';
import { callClaude, extractText, extractJson } from '../../shared/gateway.js';
import { redactPii } from '../../shared/pii.js';
import { fetchArticleChatterBatch } from '../../shared/scoring.js';
import { logSignature } from '../../shared/signature.js';
import { localGet, localSet } from '../../shared/storage.js';
import { resolveTargetPts } from '../../data/pt_routing.js';
import { KI_CLOUD_MAPPING, KI_CATEGORIES } from '../../data/ki_mapping.js';

const KI_PII_OPTS = { maskIds: true };

const KI_SYSTEM_PROMPT = `You are drafting a Salesforce Known Issue (KI) record. Known Issues are PUBLIC-FACING — they publish directly to help.salesforce.com/s/issues. Write as a formal technical writer:
- Do NOT include customer names, employee names, backup IDs, org IDs, or any other customer-identifying detail
- If a 15 or 18 character Salesforce record ID must be mentioned, keep only the first 3 characters and replace the rest with X
- Do NOT include internal infrastructure details, internal build/version codes, or internal-only URLs
- Use clear, easy-to-understand, formal language — no ALL-CAPS, use correct product/feature names
- Output EXACTLY these 4 fields:
  subject: title description of the issue
  summary: one paragraph max — what customers experience and where in the product
  repro: numbered steps to reproduce
  workaround: numbered steps, or exactly "There is no workaround at this time" if none is known
Return JSON: {"subject":"...","summary":"...","repro":"...","workaround":"..."}`;

const KI_SCORING_SYSTEM_PROMPT = `You are a strict reviewer of Salesforce Known Issue (KI) records. KIs are PUBLIC-FACING — they publish directly to help.salesforce.com/s/issues. Score this KI on these criteria, each out of the given max, summing to 100:

- subject (20): clear, specific, correct product/feature names, not ALL-CAPS, no customer-specific or internal detail
- summary (20): one paragraph max, states what customers experience and where in the product, no customer-specific or internal detail
- repro (25): clear numbered steps to reproduce the issue
- workaround (25): clear numbered workaround steps, or explicitly states "There is no workaround at this time" if none
- safety (10): no customer names, employee names, internal IDs/build codes, or internal URLs leaked; any 15/18-character Salesforce ID is properly masked (first 3 characters kept, rest replaced with X)

Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"subject","label":"Subject","score":<n>,"max":20,"passed":["..."],"issues":["..."]},{"id":"summary","label":"Summary","score":<n>,"max":20,"passed":["..."],"issues":["..."]},{"id":"repro","label":"Repro Steps","score":<n>,"max":25,"passed":["..."],"issues":["..."]},{"id":"workaround","label":"Workaround","score":<n>,"max":25,"passed":["..."],"issues":["..."]},{"id":"safety","label":"PII/Redaction Safety","score":<n>,"max":10,"passed":["..."],"issues":["..."]}]}`;

export function resolveKiCloud(casePt) {
  if (!casePt) return null;
  const ptPatterns = resolveTargetPts(casePt);
  for (const entry of Object.values(KI_CLOUD_MAPPING)) {
    if (entry.ptPatterns.some(p => ptPatterns.includes(p) || casePt.includes(p))) return entry.cloud;
  }
  return null;
}

export async function generateKiDraftContent(caseRecord, comments, chatterNotes) {
  const commentText = comments.slice(0, 8).map(c => c.CommentBody?.slice(0, 400)).filter(Boolean).join('\n');
  const user = `Case Subject: ${redactPii(caseRecord.Subject || '', KI_PII_OPTS)}
Description: ${redactPii((caseRecord.Description || '').slice(0, 2000), KI_PII_OPTS)}
Comments:
${redactPii(commentText.slice(0, 3000), KI_PII_OPTS)}${chatterNotes ? `\nRelated Chatter notes:\n${redactPii(chatterNotes, KI_PII_OPTS)}` : ''}`;
  try {
    const resp = await callClaude({
      system: KI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1200,
      temperature: 0.2
    });
    return extractJson(extractText(resp));
  } catch {
    return null;
  }
}

async function rewriteKiAi(existing, chatterNotes) {
  const user = `EXISTING KNOWN ISSUE:
Subject: ${existing.subject || ''}
Summary: ${existing.summary || ''}
Repro: ${existing.repro || ''}
Workaround: ${existing.workaround || ''}${chatterNotes ? `\n\nRELATED CHATTER NOTES (internal context only — factual/technical input from SMEs on this KI, if any; use only if genuinely relevant, ignore automated or irrelevant notes):\n${redactPii(chatterNotes, KI_PII_OPTS)}` : ''}`;
  try {
    const resp = await callClaude({
      system: `${KI_SYSTEM_PROMPT}\nYou are REVISING an existing Known Issue — preserve accurate technical content, improve clarity, fix any customer-identifying leaks, and fill in Repro/Workaround if missing or weak.`,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1200,
      temperature: 0.2
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

export function kiUrl(lightningHost, id) {
  return `https://${lightningHost || 'known-issues-prd1.lightning.force.com'}/lightning/r/Known_Issue__c/${id}/view`;
}

export async function fetchKnownIssueDetail(id) {
  const session = await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session.' };
  let safeId;
  try { safeId = sanitizeId(id); } catch (e) { return { success: false, error: e.message }; }

  try {
    const soql = `SELECT Id, Name, Subject__c, Summary__c, Status__c, Cloud__c, Workaround__c, ${KI_REPRO_FIELD} FROM Known_Issue__c WHERE Id = '${safeId}' LIMIT 1`;
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
        repro: stripHtmlKeepLinks(r[KI_REPRO_FIELD] || '', session.apiBase)
      }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function generateKiRewrite(kiId) {
  const detail = await fetchKnownIssueDetail(kiId);
  if (!detail.success) return detail;

  const session = await detectKiSession();
  const chatterMap = session.sid ? await fetchArticleChatterBatch([detail.ki.id], session).catch(() => new Map()) : new Map();
  const chatterNotes = chatterMap.get(detail.ki.id) || '';

  const draft = await rewriteKiAi(detail.ki, chatterNotes);
  if (!draft) return { success: false, error: 'Could not generate a rewrite for this KI.' };
  if (session.sid) logSignature('ki-rewrite-generated', session.apiBase, session.sid, detail.ki.id);
  return { success: true, draft, original: detail.ki };
}

export async function scoreKnownIssue(kiId) {
  const detail = await fetchKnownIssueDetail(kiId);
  if (!detail.success) return { success: false, error: detail.error };

  const ki = detail.ki;
  try {
    const resp = await callClaude({
      system: KI_SCORING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Subject: ${ki.subject || ''}\nSummary: ${ki.summary || ''}\nRepro: ${ki.repro || ''}\nWorkaround: ${ki.workaround || ''}` }],
      maxTokens: 1000,
      temperature: 0.1
    });
    const parsed = extractJson(extractText(resp));
    if (!parsed) return { success: false, error: 'Could not parse score.' };
    const session = await detectKiSession();
    if (session.sid) logSignature('ki-scored', session.apiBase, session.sid, kiId);
    return { success: true, score: parsed };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function createKnownIssue(payload) {
  const session = await detectKiSession();
  if (!session.sid) return { success: false, error: 'No Known Issues org session. Log into the Known Issues org first.' };

  const record = {
    [KI_DRAFT_SUBJECT_FIELD]: redactPii(payload.subject || '', KI_PII_OPTS).slice(0, 255),
    [KI_DRAFT_SUMMARY_FIELD]: redactPii(payload.summary || '', KI_PII_OPTS),
    [KI_DRAFT_REPRO_FIELD]: redactPii(payload.repro || '', KI_PII_OPTS),
    [KI_DRAFT_WORKAROUND_FIELD]: redactPii(payload.workaround || '', KI_PII_OPTS),
    [KI_OUTSIDE_CORE_FIELD]: true,
    [KI_DISABLE_GUS_SYNC_FIELD]: false,
    Status__c: 'In Review',
    Category__c: payload.category
  };
  if (payload.cloud) record.Cloud__c = payload.cloud;
  if (payload.workId) record.Work_ID__c = payload.workId;

  try {
    const result = await sfPost(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Known_Issue__c`, session.sid, record);
    logSignature('ki-created', session.apiBase, session.sid, result.id);
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
    [KI_DRAFT_SUMMARY_FIELD]: redactPii(payload.summary || '', KI_PII_OPTS),
    [KI_DRAFT_REPRO_FIELD]: redactPii(payload.repro || '', KI_PII_OPTS),
    [KI_DRAFT_WORKAROUND_FIELD]: redactPii(payload.workaround || '', KI_PII_OPTS)
  };

  try {
    await sfPatch(`${session.apiBase}/services/data/${SF_API_VERSION}/sobjects/Known_Issue__c/${safeId}`, session.sid, record);
    logSignature('ki-updated', session.apiBase, session.sid, safeId);
    return { success: true, id: safeId, url: kiUrl(session.lightningHost, safeId) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const KI_LIST_FIELDS = 'Id, Name, Subject__c, Status__c, Cloud__c, Category__r.Name, CreatedBy.Name, Approver__r.Name, Work_ID__c, Reporting_User_Count__c';

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
