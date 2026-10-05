import { sfPost, sfGet } from './api.js';
import { SF_API_VERSION } from './config.js';

const SIGNATURE_PHRASE = 'Do not remove this line for KB Agent tracking';

export const CASE_SCAN_RX = /KB Agent case-scan marker\(Do not remove this line for KB Agent tracking\)/i;
export const ARTICLE_SCORED_RX = /KB Agent article-score marker\(Do not remove this line for KB Agent tracking\)/i;
export const REWRITE_GENERATED_RX = /KB Agent rewrite-generated marker\(Do not remove this line for KB Agent tracking\)/i;
export const REWRITE_PUBLISHED_RX = /KB Agent rewrite-published marker\(Do not remove this line for KB Agent tracking\)/i;
export const KI_CREATED_RX = /KB Agent ki-created marker\(Do not remove this line for KB Agent tracking\)/i;
export const KI_UPDATED_RX = /KB Agent ki-updated marker\(Do not remove this line for KB Agent tracking\)/i;
export const KI_REWRITE_GENERATED_RX = /KB Agent ki-rewrite-generated marker\(Do not remove this line for KB Agent tracking\)/i;
export const KI_SCORED_RX = /KB Agent ki-scored marker\(Do not remove this line for KB Agent tracking\)/i;

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

export function classifySignature(body) {
  if (!body) return null;
  if (CASE_SCAN_RX.test(body)) return 'case-scan';
  if (ARTICLE_SCORED_RX.test(body)) return 'article-scored';
  if (REWRITE_GENERATED_RX.test(body)) return 'rewrite-generated';
  if (REWRITE_PUBLISHED_RX.test(body)) return 'rewrite-published';
  if (KI_CREATED_RX.test(body)) return 'ki-created';
  if (KI_UPDATED_RX.test(body)) return 'ki-updated';
  if (KI_REWRITE_GENERATED_RX.test(body)) return 'ki-rewrite-generated';
  if (KI_SCORED_RX.test(body)) return 'ki-scored';
  return null;
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
