import { SF_API_VERSION, CASE_GUARD_RAIL_EXCLUSIONS, CACHE_TTL_MS } from './config.js';
import { sfGet } from './api.js';

function isSfDomain(d) {
  if (!d) return false;
  const domain = d.toLowerCase();
  return (domain.includes('salesforce.com') || domain.includes('force.com')) &&
    !domain.includes('login.salesforce.com');
}

function getBaseOrgKey(hostname) {
  const host = String(hostname || '').toLowerCase();
  const suffixes = [
    '.my.salesforce.com', '.lightning.force.com', '.file.force.com',
    '.visual.force.com', '.force.com', '.salesforce.com'
  ];
  for (const s of suffixes) {
    if (host.endsWith(s)) return host.slice(0, -s.length);
  }
  return host;
}

async function loadFreshSfCookies() {
  const cookies = await chrome.cookies.getAll({ name: 'sid' });
  const now = Date.now();
  return cookies.filter(c => {
    if (!isSfDomain(c.domain)) return false;
    if (c.expirationDate && c.expirationDate * 1000 <= now) return false;
    const d = c.domain.toLowerCase();
    if (d.includes('.vf.force.com') || d.includes('.visual.force.com')) return false;
    return true;
  });
}

function groupCookiesByOrg(sfCookies) {
  const groups = new Map();
  for (const cookie of sfCookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    const key = getBaseOrgKey(domain);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { hosts: new Set(), bestCookie: null });
    const group = groups.get(key);
    group.hosts.add(domain);
    const isMySf = domain.endsWith('.my.salesforce.com');
    const bestIsMySf = group.bestCookie && group.bestCookie.domain.replace(/^\./, '').endsWith('.my.salesforce.com');
    if (!group.bestCookie) {
      group.bestCookie = cookie;
    } else if (isMySf && !bestIsMySf) {
      group.bestCookie = cookie;
    } else if (!bestIsMySf && (cookie.expirationDate || 0) > (group.bestCookie.expirationDate || 0)) {
      group.bestCookie = cookie;
    }
  }
  return groups;
}

export async function detectSession() {
  const sfCookies = await loadFreshSfCookies();
  if (!sfCookies.length) return { sid: null, apiBase: null, lightningHost: null, orgs: [] };

  const groups = groupCookiesByOrg(sfCookies);
  const orgs = [];
  for (const [key, group] of groups.entries()) {
    if (!group.bestCookie?.value) continue;
    const hosts = Array.from(group.hosts);
    const apiHost = hosts.find(h => h.endsWith('.my.salesforce.com')) || hosts[0];
    const lightHost = hosts.find(h => h.endsWith('.lightning.force.com')) || null;
    orgs.push({
      key,
      apiBase: `https://${apiHost}`,
      lightningHost: lightHost || `${key}.lightning.force.com`,
      sid: group.bestCookie.value,
      isOrgcs: /^orgcs([\d_-]\w*)?$/i.test(key)
    });
  }

  const orgcs = orgs.find(o => o.isOrgcs);
  if (orgcs) return { ...orgcs, orgs };
  return orgs.length ? { ...orgs[0], orgs } : { sid: null, apiBase: null, lightningHost: null, orgs: [] };
}

export function describeAuthError(session) {
  if (!session || !session.sid) {
    return 'No active Salesforce session found. Please log into OrgCS in this browser, then retry.';
  }
  if (!session.isOrgcs) {
    const lk = String(session.key || '').toLowerCase();
    if (/^org62/.test(lk)) {
      return 'Detected an org62 session, but this extension reads OrgCS. Open OrgCS in another tab and retry.';
    }
    return `Detected session for "${session.key}", not OrgCS. Log into OrgCS and retry.`;
  }
  return null;
}

export async function findSid(lightningHost) {
  const host = String(lightningHost || '').trim().toLowerCase();
  if (!host.endsWith('.lightning.force.com')) {
    throw new Error(`Invalid Lightning host: ${JSON.stringify(lightningHost)}`);
  }
  const apiHost = host.slice(0, -'.lightning.force.com'.length) + '.my.salesforce.com';
  const apiBase = `https://${apiHost}`;
  const domains = [apiHost, lightningHost];
  const results = await Promise.all(
    domains.map(d => chrome.cookies.getAll({ domain: d, name: 'sid' }))
  );
  for (const cookies of results) {
    const fresh = cookies.reduce((best, c) => {
      if (!best) return c;
      return (c.expirationDate || 0) > (best.expirationDate || 0) ? c : best;
    }, null);
    if (fresh) return { sid: fresh.value, apiBase };
  }
  return { sid: null, apiBase };
}


export function isCaseAnalysisAllowed(caseRecord) {
  const supportLevel = (caseRecord?.__supportLevel || '').trim();
  const hyperforce = (caseRecord?.__hyperforce || '').trim();
  for (const forbidden of CASE_GUARD_RAIL_EXCLUSIONS) {
    if (supportLevel && supportLevel.toLowerCase().includes(forbidden.toLowerCase())) {
      return {
        allowed: false,
        reason: `Restricted support tier (${supportLevel}). Cannot send to AI gateway.`
      };
    }
  }
  if (hyperforce === 'No') {
    return { allowed: false, reason: 'Non-Hyperforce case. Cannot send to AI gateway.' };
  }
  return { allowed: true };
}

const _memoCache = new Map();

function memoize(key, scope, ttl, fn) {
  const fullKey = `${key}:${scope}`;
  const cached = _memoCache.get(fullKey);
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const promise = fn().then(v => {
    _memoCache.set(fullKey, { value: Promise.resolve(v), ts: Date.now() });
    return v;
  });
  _memoCache.set(fullKey, { value: promise, ts: Date.now() });
  return promise;
}

export async function verifyGuardRailFields(apiBase, sid) {
  return memoize('guardRail', apiBase, CACHE_TTL_MS, async () => {
    try {
      const describe = await sfGet(`${apiBase}/services/data/${SF_API_VERSION}/sobjects/Case/describe`, sid);
      const fields = describe.fields || [];
      const SUPPORT_PATTERNS = [/^case_support_level__c$/i, /^support_level__c$/i, /^supportlevel__c$/i];
      const HYPERFORCE_PATTERNS = [/^hyperforce__c$/i, /^is_?hyperforce__c$/i, /^on_?hyperforce__c$/i];
      let supportLevelName = null, hyperforceName = null;
      for (const f of fields) {
        if (!f?.name) continue;
        if (!supportLevelName && SUPPORT_PATTERNS.some(re => re.test(f.name))) supportLevelName = f.name;
        if (!hyperforceName && HYPERFORCE_PATTERNS.some(re => re.test(f.name))) hyperforceName = f.name;
        if (supportLevelName && hyperforceName) break;
      }
      return { hasSupportLevel: !!supportLevelName, hasHyperforce: !!hyperforceName, supportLevelName, hyperforceName, bothPresent: !!(supportLevelName && hyperforceName) };
    } catch (e) {
      return { hasSupportLevel: false, hasHyperforce: false, bothPresent: false, describeFailed: true, error: e.message };
    }
  });
}
