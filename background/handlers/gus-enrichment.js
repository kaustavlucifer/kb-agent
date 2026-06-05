import { detectGusSession, pingGusSession } from '../../shared/auth.js';
import { sfGet, sfQuery, soqlIdList, escapeSoql } from '../../shared/api.js';
import { SF_API_VERSION } from '../../shared/config.js';

const GUS_WORK_ITEM_RE = /\bW-\d{4,8}\b/g;
const WORK_OBJECT = 'ADM_Work__c';

const GUS_FIELDS = [
  'Id', 'Name', 'Subject__c', 'Status__c', 'Priority__c', 'CreatedDate',
  'Assignee__r.Name', 'Scrum_Team__r.Name', 'Product_Tag__r.Name'
];

export function extractWorkItemNames(comments) {
  const seen = new Set();
  for (const c of (comments || [])) {
    const text = c.CommentBody || '';
    const matches = text.match(GUS_WORK_ITEM_RE);
    if (matches) matches.forEach(m => seen.add(m));
  }
  return [...seen];
}

export async function fetchGusWorkItems(workNames) {
  if (!workNames.length) return { items: [], feed: [], error: null };

  const gusSession = await detectGusSession();
  if (!gusSession.sid) return { items: [], feed: [], error: 'No GUS session. Log into GUS in the browser.' };

  const { apiBase, sid } = gusSession;
  const items = [];

  const batches = [];
  for (let i = 0; i < workNames.length; i += 20) batches.push(workNames.slice(i, i + 20));

  const batchResults = await Promise.all(batches.map(async (batch) => {
    const inList = batch.map(n => `'${escapeSoql(n)}'`).join(',');
    try {
      const soql = `SELECT ${GUS_FIELDS.join(', ')} FROM ${WORK_OBJECT} WHERE Name IN (${inList})`;
      return await sfQuery(apiBase, sid, soql);
    } catch { return []; }
  }));
  for (const records of batchResults) {
    for (const r of records) {
      items.push({
        id: r.Id,
        name: r.Name,
        subject: r.Subject__c || null,
        status: r.Status__c || null,
        priority: r.Priority__c || null,
        assignee: r.Assignee__r?.Name || null,
        scrumTeam: r.Scrum_Team__r?.Name || null,
        productTag: r.Product_Tag__r?.Name || null,
        createdDate: r.CreatedDate || null
      });
    }
  }

  let feed = [];
  if (items.length) {
    const workIds = items.map(i => i.id);
    try {
      const feedSoql = `SELECT Id, ParentId, Type, Body, CreatedDate, CreatedBy.Name FROM ADM_Work__Feed WHERE ParentId IN (${soqlIdList(workIds)}) AND Type IN ('TextPost','ContentPost','LinkPost') ORDER BY CreatedDate ASC LIMIT 50`;
      const feedRecords = await sfQuery(apiBase, sid, feedSoql);
      feed = feedRecords.map(r => ({
        workId: r.ParentId,
        body: r.Body || '',
        author: r.CreatedBy?.Name || null,
        createdDate: r.CreatedDate
      }));
    } catch {}
  }

  return { items, feed, error: null };
}

export async function checkGusConnection() {
  const result = await pingGusSession();
  return { connected: result.status === 'active' };
}
