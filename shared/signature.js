import { sfPost, sfGet } from './api.js';
import { SF_API_VERSION } from './config.js';

export const SIGNATURE_PHRASE = 'Do not remove this line for KB Agent tracking';

const MARKER_SPECS = {
  'case-scan': { label: 'Case scanned', suffix: 'case-scan marker' },
  'article-scored': { label: 'Article scored', suffix: 'article-score marker' },
  'rewrite-generated': { label: 'Rewrite generated', suffix: 'rewrite-generated marker' },
  'rewrite-published': { label: 'Rewrite published', suffix: 'rewrite-published marker' },
  'ki-created': { label: 'Known Issue created', suffix: 'ki-created marker' },
  'ki-updated': { label: 'Known Issue updated', suffix: 'ki-updated marker' },
  'ki-rewrite-generated': { label: 'Known Issue rewrite generated', suffix: 'ki-rewrite-generated marker' },
  'ki-scored': { label: 'Known Issue scored', suffix: 'ki-scored marker' }
};

function buildMarker(kind, who) {
  const spec = MARKER_SPECS[kind];
  if (!spec) return null;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const name = String(who || '').trim() || 'KB Agent';
  return `${spec.label} on ${ts} UTC by ${name}\n- KB Agent ${spec.suffix}(${SIGNATURE_PHRASE})`;
}

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MARKER_MATCHERS = Object.entries(MARKER_SPECS).map(([kind, spec]) => [
  kind,
  new RegExp(`KB Agent ${escapeRegex(spec.suffix)}\\(${escapeRegex(SIGNATURE_PHRASE)}\\)`, 'i')
]);

export function classifySignature(body) {
  if (!body) return null;
  return MARKER_MATCHERS.find(([, rx]) => rx.test(body))?.[0] || null;
}

const _userNameCache = new Map();

async function getCurrentUserName(apiBase, sid) {
  if (_userNameCache.has(apiBase)) return _userNameCache.get(apiBase);
  try {
    const info = await sfGet(`${apiBase}/services/data/${SF_API_VERSION}/chatter/users/me`, sid);
    const name = info?.name || '';
    _userNameCache.set(apiBase, name);
    return name;
  } catch {
    return '';
  }
}

export async function logSignature(kind, apiBase, sid, subjectId) {
  if (!apiBase || !sid || !subjectId) return;
  const who = await getCurrentUserName(apiBase, sid);
  const body = buildMarker(kind, who);
  if (!body) return;
  try {
    await sfPost(`${apiBase}/services/data/${SF_API_VERSION}/chatter/feed-elements`, sid, {
      feedElementType: 'FeedItem',
      subjectId,
      visibility: 'InternalUsers',
      body: { messageSegments: [{ type: 'Text', text: body }] }
    });
  } catch {}
}
