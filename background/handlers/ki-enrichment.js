import { detectKiSession } from '../../shared/auth.js';
import { sfSearch, sfQuery, escapeSosl, mapWithConcurrency } from '../../shared/api.js';
import { callClaudeFast, extractText, extractJson } from '../../shared/gateway.js';
import { SF_API_VERSION } from '../../shared/config.js';
import { KI_CLOUD_MAPPING } from '../../data/ki_mapping.js';

const KI_FIELDS = 'Id, Name, Subject__c, Summary__c, Status__c, Cloud__c, Category__r.Name, Workaround__c, Work_ID__c, Reporting_User_Count__c';
const KI_ACTIVE_STATUSES = ['In Review', 'Solution in Progress', 'Solution Scheduled', 'Solution Deploying'];

export async function fetchRelatedKnownIssues(caseAbstract, ptPatterns, caseSubject) {
  const kiSession = await detectKiSession();
  if (!kiSession.sid) return { items: [], error: 'No KI session. Log into the Known Issues org.' };

  const { apiBase, sid } = kiSession;

  const cloudValues = resolveCloudValues(ptPatterns);
  const searchTerms = buildSearchTerms(caseAbstract, caseSubject);

  if (!searchTerms.length) return { items: [], error: null };

  let candidates = [];

  if (cloudValues.length) {
    const cloudFilter = cloudValues.map(c => `Cloud__c = '${c.replace(/'/g, "\\'")}'`).join(' OR ');
    const statusFilter = KI_ACTIVE_STATUSES.map(s => `'${s}'`).join(',');

    await mapWithConcurrency(searchTerms.slice(0, 3), 3, async (term) => {
      if (candidates.length >= 10) return;
      try {
        const records = await sfSearch(apiBase, sid,
          `FIND {${escapeSosl(term)}} IN ALL FIELDS RETURNING Known_Issue__c(${KI_FIELDS} WHERE Published__c = true AND Status__c IN (${statusFilter}) AND (${cloudFilter})) LIMIT 5`
        );
        for (const r of records) {
          if (!candidates.some(c => c.Id === r.Id)) {
            candidates.push(r);
          }
        }
      } catch {}
    });
  }

  if (candidates.length < 3) {
    await mapWithConcurrency(searchTerms.slice(0, 2), 2, async (term) => {
      if (candidates.length >= 10) return;
      try {
        const statusFilter = KI_ACTIVE_STATUSES.map(s => `'${s}'`).join(',');
        const records = await sfSearch(apiBase, sid,
          `FIND {${escapeSosl(term)}} IN ALL FIELDS RETURNING Known_Issue__c(${KI_FIELDS} WHERE Published__c = true AND Status__c IN (${statusFilter})) LIMIT 5`
        );
        for (const r of records) {
          if (!candidates.some(c => c.Id === r.Id)) {
            candidates.push(r);
          }
        }
      } catch {}
    });
  }

  if (!candidates.length) return { items: [], error: null };

  const ranked = await rankKiRelevance(candidates, caseAbstract, caseSubject);
  return { items: ranked, error: null };
}

function resolveCloudValues(ptPatterns) {
  const clouds = new Set();
  for (const pt of ptPatterns) {
    for (const [, mapping] of Object.entries(KI_CLOUD_MAPPING)) {
      if (mapping.ptPatterns.some(p => pt.includes(p) || p.includes(pt))) {
        clouds.add(mapping.cloud);
      }
    }
  }
  return [...clouds];
}

function buildSearchTerms(caseAbstract, caseSubject) {
  const terms = [];
  if (caseAbstract?.errorSignature) terms.push(caseAbstract.errorSignature);
  if (caseAbstract?.symptomClass) terms.push(caseAbstract.symptomClass);
  if (caseSubject) {
    const cleaned = caseSubject.replace(/[^\w\s-]/g, ' ').trim();
    if (cleaned.length > 5) terms.push(cleaned.split(' ').slice(0, 6).join(' '));
  }
  if (caseAbstract?.product) terms.push(caseAbstract.product);
  return terms.filter(t => t && t.length > 3);
}

async function rankKiRelevance(candidates, caseAbstract, caseSubject) {
  const kiList = candidates.slice(0, 10).map((r, i) => {
    return `[${i}] ${r.Name}: "${r.Subject__c || ''}"\nSummary: ${(r.Summary__c || '').slice(0, 200)}\nCloud: ${r.Cloud__c || ''}\nStatus: ${r.Status__c || ''}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: `You rank Known Issues by relevance to a support case. Score each 0-100. Return JSON: {"ranked": [{"index": 0, "score": 85, "reason": "short reason"}, ...]}. Include only items scoring above 30. Be strict.`,
      messages: [{ role: 'user', content: `CASE:\nSubject: ${caseSubject || ''}\nProduct: ${caseAbstract?.product || ''}\nSymptom: ${caseAbstract?.symptomClass || ''}\nError: ${caseAbstract?.errorSignature || ''}\n\nKNOWN ISSUES:\n${kiList}` }],
      maxTokens: 600,
      temperature: 0.1
    });
    const parsed = extractJson(extractText(resp));
    if (parsed?.ranked?.length) {
      return parsed.ranked
        .filter(r => r.index >= 0 && r.index < candidates.length && r.score > 30)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(r => {
          const ki = candidates[r.index];
          return {
            id: ki.Id,
            name: ki.Name,
            subject: ki.Subject__c || '',
            summary: (ki.Summary__c || '').slice(0, 300),
            status: ki.Status__c || '',
            cloud: ki.Cloud__c || '',
            category: ki.Category__r?.Name || '',
            workaround: (ki.Workaround__c || '').slice(0, 500),
            workId: ki.Work_ID__c || '',
            reportingCount: ki.Reporting_User_Count__c || 0,
            relevanceScore: r.score,
            relevanceReason: r.reason || ''
          };
        });
    }
  } catch {}

  return candidates.slice(0, 5).map(ki => ({
    id: ki.Id,
    name: ki.Name,
    subject: ki.Subject__c || '',
    summary: (ki.Summary__c || '').slice(0, 300),
    status: ki.Status__c || '',
    cloud: ki.Cloud__c || '',
    category: ki.Category__r?.Name || '',
    workaround: (ki.Workaround__c || '').slice(0, 500),
    workId: ki.Work_ID__c || '',
    reportingCount: ki.Reporting_User_Count__c || 0,
    relevanceScore: null,
    relevanceReason: ''
  }));
}

