import { detectKiSession } from '../../shared/auth.js';
import { sfSearch, escapeSoql, escapeSosl, mapWithConcurrency } from '../../shared/api.js';
import { callClaudeFast, extractText, extractJson } from '../../shared/gateway.js';
import { KI_CLOUD_MAPPING } from '../../data/ki_mapping.js';
import { kiUrl } from './ki-publish.js';

const KI_FIELDS = 'Id, Name, Subject__c, Summary__c, Status__c, Cloud__c, Category__r.Name, Workaround__c, Work_ID__c, Reporting_User_Count__c';
const KI_ACTIVE_STATUSES = ['In Review', 'Solution in Progress', 'Solution Scheduled', 'Solution Deploying'];
const KI_STATUS_FILTER = KI_ACTIVE_STATUSES.map(s => `'${s}'`).join(',');
const SOSL_TERM_MAX_WORDS = 8;
const SOSL_TERM_MAX_CHARS = 100;

export async function fetchRelatedKnownIssues(caseAbstract, ptPatterns, caseSubject, signal) {
  const kiSession = await detectKiSession();
  if (!kiSession.sid) return { items: [], error: 'No KI session. Log into the Known Issues org.' };

  const { apiBase, sid, lightningHost } = kiSession;
  const cloudValues = resolveCloudValues(ptPatterns);
  const searchTerms = buildSearchTerms(caseAbstract, caseSubject);

  if (!searchTerms.length) return { items: [], lightningHost, error: null };

  const candidates = new Map();
  let firstError = null;

  const searchPass = (terms, extraWhere) => mapWithConcurrency(terms, terms.length, async (term) => {
    try {
      const records = await sfSearch(apiBase, sid,
        `FIND {${escapeSosl(term)}} IN ALL FIELDS RETURNING Known_Issue__c(${KI_FIELDS} WHERE Published__c = true AND Status__c IN (${KI_STATUS_FILTER})${extraWhere}) LIMIT 5`,
        signal
      );
      for (const r of records) if (!candidates.has(r.Id)) candidates.set(r.Id, r);
    } catch (e) {
      firstError = firstError || e.message;
    }
  });

  if (cloudValues.length) {
    await searchPass(searchTerms.slice(0, 3), ` AND (${cloudValues.map(c => `Cloud__c = '${escapeSoql(c)}'`).join(' OR ')})`);
  }
  if (candidates.size < 3) await searchPass(searchTerms.slice(0, 2), '');

  if (!candidates.size || signal?.aborted) return { items: [], lightningHost, error: firstError };

  const ranked = await rankKiRelevance([...candidates.values()], caseAbstract, caseSubject, lightningHost, signal);
  return { items: ranked, lightningHost, error: firstError };
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

function soslTerm(text) {
  return String(text || '')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, SOSL_TERM_MAX_WORDS)
    .join(' ')
    .slice(0, SOSL_TERM_MAX_CHARS)
    .trim();
}

function buildSearchTerms(caseAbstract, caseSubject) {
  const terms = [caseAbstract?.errorSignature, caseAbstract?.symptomClass];
  if (caseSubject) {
    const cleaned = caseSubject.replace(/[^\w\s-]/g, ' ').trim();
    if (cleaned.length > 5) terms.push(cleaned.split(/\s+/).slice(0, 6).join(' '));
  }
  terms.push(caseAbstract?.product);
  return [...new Set(terms.map(soslTerm))].filter(t => t.length > 3);
}

function toKiItem(ki, lightningHost, relevanceScore, relevanceReason) {
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
    url: kiUrl(lightningHost, ki.Id),
    relevanceScore,
    relevanceReason
  };
}

async function rankKiRelevance(candidates, caseAbstract, caseSubject, lightningHost, signal) {
  const kiList = candidates.slice(0, 10).map((r, i) => {
    return `[${i}] ${r.Name}: "${r.Subject__c || ''}"\nSummary: ${(r.Summary__c || '').slice(0, 200)}\nCloud: ${r.Cloud__c || ''}\nStatus: ${r.Status__c || ''}`;
  }).join('\n\n');

  try {
    const resp = await callClaudeFast({
      system: `You rank Known Issues by relevance to a support case. Score each 0-100. Return JSON: {"ranked": [{"index": 0, "score": 85, "reason": "short reason"}, ...]}. Include only items scoring above 30. Be strict.`,
      messages: [{ role: 'user', content: `CASE:\nSubject: ${caseSubject || ''}\nProduct: ${caseAbstract?.product || ''}\nSymptom: ${caseAbstract?.symptomClass || ''}\nError: ${caseAbstract?.errorSignature || ''}\n\nKNOWN ISSUES:\n${kiList}` }],
      maxTokens: 600,
      temperature: 0,
      signal
    });
    const parsed = extractJson(extractText(resp));
    if (parsed?.ranked?.length) {
      return parsed.ranked
        .filter(r => r.index >= 0 && r.index < candidates.length && r.score > 30)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(r => toKiItem(candidates[r.index], lightningHost, r.score, r.reason || ''));
    }
  } catch {}

  return candidates.slice(0, 5).map(ki => toKiItem(ki, lightningHost, null, ''));
}
