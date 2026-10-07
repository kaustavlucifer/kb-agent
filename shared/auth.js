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
  return { sid: null, apiBase: null, lightningHost: null, orgs };
}

async function detectOrgSession(matchKey) {
  const sfCookies = await loadFreshSfCookies();
  if (!sfCookies.length) return { sid: null, apiBase: null, lightningHost: null };

  const groups = groupCookiesByOrg(sfCookies);
  for (const [key, group] of groups.entries()) {
    if (!group.bestCookie?.value) continue;
    if (!matchKey(key)) continue;
    const hosts = Array.from(group.hosts);
    const apiHost = hosts.find(h => h.endsWith('.my.salesforce.com')) || hosts[0];
    const lightHost = hosts.find(h => h.endsWith('.lightning.force.com')) || `${key}.lightning.force.com`;
    return {
      sid: group.bestCookie.value,
      apiBase: `https://${apiHost}`,
      lightningHost: lightHost,
      key
    };
  }
  return { sid: null, apiBase: null, lightningHost: null };
}

export function detectGusSession() {
  return detectOrgSession(key => key.toLowerCase() === 'gus');
}

export function detectKiSession() {
  return detectOrgSession(key => /^known-issues/i.test(key));
}

const PING_CACHE_TTL_MS = 5 * 60 * 1000;

async function pingSession(detectFn, cacheRef) {
  const session = await detectFn();
  if (!session.sid) return { status: 'none', apiBase: null, key: session.key || null, lightningHost: session.lightningHost || null };
  const info = { apiBase: session.apiBase, key: session.key || null, lightningHost: session.lightningHost };
  if (cacheRef.value && cacheRef.value.sid === session.sid && Date.now() - cacheRef.value.ts < PING_CACHE_TTL_MS) {
    return { status: cacheRef.value.status, ...info };
  }
  try {
    const r = await fetch(`${session.apiBase}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent('SELECT Id, Name FROM User WHERE IsActive = true LIMIT 1')}`, {
      headers: { Authorization: `Bearer ${session.sid}`, Accept: 'application/json' }
    });
    const status = r.ok ? 'active' : 'expired';
    cacheRef.value = { sid: session.sid, status, ts: Date.now() };
    return { status, ...info };
  } catch {
    cacheRef.value = null;
    return { status: 'error', ...info };
  }
}

const _orgcsPingCache = { value: null };
const _gusPingCache = { value: null };
const _kiPingCache = { value: null };

export function pingOrgcsSession() {
  return pingSession(detectSession, _orgcsPingCache);
}

export function pingGusSession() {
  return pingSession(detectGusSession, _gusPingCache);
}

export function pingKiSession() {
  return pingSession(detectKiSession, _kiPingCache);
}

export function clearAuthCache() {
  _orgcsPingCache.value = null;
  _gusPingCache.value = null;
  _kiPingCache.value = null;
}

export function isCaseAnalysisAllowed(caseRecord) {
  const supportLevel = String(caseRecord?.__supportLevel ?? '').trim();
  const hyperforce = String(caseRecord?.__hyperforce ?? '').trim().toLowerCase();
  for (const forbidden of CASE_GUARD_RAIL_EXCLUSIONS) {
    if (supportLevel && supportLevel.toLowerCase().includes(forbidden.toLowerCase())) {
      return {
        allowed: false,
        reason: `Restricted support tier (${supportLevel}). Cannot send to AI gateway.`
      };
    }
  }
  if (hyperforce === 'no' || hyperforce === 'false') {
    return { allowed: false, reason: 'Non-Hyperforce case. Cannot send to AI gateway.' };
  }
  return { allowed: true };
}

const _guardRailCache = new Map();

async function describeGuardRailFields(apiBase, sid) {
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
}

export async function verifyGuardRailFields(apiBase, sid) {
  const cached = _guardRailCache.get(apiBase);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  const value = describeGuardRailFields(apiBase, sid);
  _guardRailCache.set(apiBase, { value, ts: Date.now() });
  try {
    return await value;
  } catch (e) {
    _guardRailCache.delete(apiBase);
    return { hasSupportLevel: false, hasHyperforce: false, bothPresent: false, describeFailed: true, error: e.message };
  }
}
