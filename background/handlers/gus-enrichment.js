import { detectGusSession, pingGusSession } from '../../shared/auth.js';
import { sfQuery, soqlIdList, escapeSoql, escapeSoqlLike, mapWithConcurrency } from '../../shared/api.js';

export const GUS_WORK_NAME_RE = /^W-\d{4,9}$/;
const GUS_WORK_ITEM_RE = new RegExp(`\\b${GUS_WORK_NAME_RE.source.slice(1, -1)}\\b`, 'g');
const WORK_OBJECT = 'ADM_Work__c';

const GUS_FIELDS = [
  'Id', 'Name', 'Subject__c', 'Status__c', 'RecordType.Name', 'Priority__c', 'CreatedDate',
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

export async function fetchGusWorkItems(workNames, signal) {
  if (!workNames.length) return { items: [], feed: [], error: null };

  const gusSession = await detectGusSession();
  if (!gusSession.sid) return { items: [], feed: [], error: 'No GUS session. Log into GUS in the browser.' };

  const { apiBase, sid } = gusSession;
  const items = [];
  let firstError = null;

  const batches = [];
  for (let i = 0; i < workNames.length; i += 20) batches.push(workNames.slice(i, i + 20));

  const batchResults = await mapWithConcurrency(batches, 3, async (batch) => {
    const inList = batch.map(n => `'${escapeSoql(n)}'`).join(',');
    try {
      const soql = `SELECT ${GUS_FIELDS.join(', ')} FROM ${WORK_OBJECT} WHERE Name IN (${inList})`;
      return await sfQuery(apiBase, sid, soql, signal);
    } catch (e) {
      firstError = firstError || e.message;
      return [];
    }
  });
  for (const records of batchResults) {
    for (const r of records) {
      items.push({
        id: r.Id,
        name: r.Name,
        subject: r.Subject__c || null,
        status: r.Status__c || null,
        recordType: r.RecordType?.Name || null,
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
    const loadFeed = async () => {
      try {
        const feedSoql = `SELECT Id, ParentId, Type, Body, CreatedDate, CreatedBy.Name FROM ADM_Work__Feed WHERE ParentId IN (${soqlIdList(workIds)}) AND Type IN ('TextPost','ContentPost','LinkPost') ORDER BY CreatedDate DESC LIMIT 50`;
        const feedRecords = await sfQuery(apiBase, sid, feedSoql, signal);
        feed = feedRecords.map(r => ({
          workId: r.ParentId,
          body: r.Body || '',
          author: r.CreatedBy?.Name || null,
          createdDate: r.CreatedDate
        }));
      } catch (e) {
        firstError = firstError || e.message;
      }
    };
    const loadLinkedBugs = async () => {
      const investigations = items.filter(i => i.recordType === 'Investigation');
      if (!investigations.length) return;
      try {
        const idList = soqlIdList(investigations.map(i => i.id));
        const linkSoql = `SELECT Parent_Work__c, Child_Work__c, Parent_Work__r.Name, Parent_Work__r.Status__c, Parent_Work__r.Subject__c, Parent_Work__r.RecordType.Name, Child_Work__r.Name, Child_Work__r.Status__c, Child_Work__r.Subject__c, Child_Work__r.RecordType.Name FROM ADM_Parent_Work__c WHERE Parent_Work__c IN (${idList}) OR Child_Work__c IN (${idList}) LIMIT 200`;
        const links = await sfQuery(apiBase, sid, linkSoql, signal);
        for (const inv of investigations) {
          inv.linkedBugs = links
            .map(l => l.Parent_Work__c === inv.id ? l.Child_Work__r : l.Child_Work__c === inv.id ? l.Parent_Work__r : null)
            .filter(w => ['Bug', 'User Story'].includes(w?.RecordType?.Name))
            .map(w => ({ name: w.Name, status: w.Status__c || null, subject: w.Subject__c || null, recordType: w.RecordType.Name }));
        }
      } catch (e) {
        firstError = firstError || e.message;
      }
    };
    await Promise.all([loadFeed(), loadLinkedBugs()]);
  }

  return { items, feed, error: firstError };
}

const GUS_SEARCH_FIELDS = ['Id', 'Name', 'Subject__c', 'Status__c', 'RecordType.Name', 'Product_Tag__r.Name'];

export async function searchGusWorkItems(query) {
  const term = String(query || '').trim();
  if (term.length < 3) return { items: [] };
  const gusSession = await detectGusSession();
  if (!gusSession.sid) return { items: [], error: 'No GUS session. Log into GUS in the browser.' };
  const where = GUS_WORK_NAME_RE.test(term.toUpperCase())
    ? `Name = '${escapeSoql(term.toUpperCase())}'`
    : `RecordType.Name IN ('Bug','Investigation') AND Subject__c LIKE '%${escapeSoqlLike(term)}%'`;
  try {
    const records = await sfQuery(gusSession.apiBase, gusSession.sid, `SELECT ${GUS_SEARCH_FIELDS.join(', ')} FROM ${WORK_OBJECT} WHERE ${where} ORDER BY LastModifiedDate DESC LIMIT 15`);
    return {
      items: records.map(r => ({
        name: r.Name,
        subject: r.Subject__c || '',
        status: r.Status__c || '',
        recordType: r.RecordType?.Name || '',
        productTag: r.Product_Tag__r?.Name || ''
      }))
    };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

export async function checkGusConnection() {
  const result = await pingGusSession();
  return { connected: result.status === 'active' };
}
