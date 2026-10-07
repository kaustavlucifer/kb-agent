import { KI_BASE } from './config.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const AWS_KEY_RE = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SF_ID_RE = /\b([A-Za-z0-9]{3})([A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\b/g;
const URL_SEGMENT_RE = /\]\([^)\s]*\)|https?:\/\/[^\s)<>"']+/g;
const SF_ID_SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function isSfIdLike(id) {
  if (!/[0-9]/.test(id) || !/[A-Za-z]/.test(id)) return false;
  if (id.length === 15) return (id.match(/[0-9]/g) || []).length >= 3;
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    let flags = 0;
    for (let j = 0; j < 5; j++) if (/[A-Z]/.test(id[i * 5 + j])) flags |= 1 << j;
    suffix += SF_ID_SUFFIX_CHARS[flags];
  }
  return suffix === id.slice(15);
}

function maskSfIdsInText(text) {
  return text.replace(SF_ID_RE, (full, prefix, rest) => isSfIdLike(full) ? prefix + 'X'.repeat(rest.length) : full);
}

const KI_ORG_PREFIX = new URL(KI_BASE).hostname.split('.')[0].toLowerCase();
const CUSTOMER_HOST_RE = /(?:^|\.)(?:my\.salesforce\.com|my\.site\.com|force\.com|visualforce\.com|documentforce\.com|salesforce-sites\.com)$/i;
const URL_PARTS_RE = /^(https?:\/\/)([^/?#\s]*)([\s\S]*)$/i;

function isKiOrgHost(host) {
  const lower = host.toLowerCase();
  return lower.startsWith(`${KI_ORG_PREFIX}.`) || lower.startsWith(`${KI_ORG_PREFIX}--`);
}

function maskUrl(url) {
  const m = URL_PARTS_RE.exec(url);
  if (!m) return maskSfIdsInText(url);
  const [, scheme, host, rest] = m;
  if (isKiOrgHost(host)) return url;
  return scheme + (CUSTOMER_HOST_RE.test(host) ? '[REDACTED-HOST]' : host) + maskSfIdsInText(rest);
}

function maskSfIds(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_SEGMENT_RE)) {
    const segment = m[0].startsWith('](') ? `](${maskUrl(m[0].slice(2, -1))})` : maskUrl(m[0]);
    out += maskSfIdsInText(text.slice(last, m.index)) + segment;
    last = m.index + m[0].length;
  }
  return out + maskSfIdsInText(text.slice(last));
}

export function redactPii(text, opts = {}) {
  if (!text) return text;
  let out = String(text)
    .replace(EMAIL_RE, '[REDACTED-EMAIL]')
    .replace(SSN_RE, '[REDACTED-SSN]')
    .replace(AWS_KEY_RE, '[REDACTED-KEY]')
    .replace(CREDIT_CARD_RE, '[REDACTED-CC]')
    .replace(PHONE_RE, '[REDACTED-PHONE]')
    .replace(IPV4_RE, '[REDACTED-IP]');
  return opts.maskIds ? maskSfIds(out) : out;
}

export function redactCaseRecord(caseRecord, opts) {
  if (!caseRecord) return caseRecord;
  return {
    ...caseRecord,
    Subject: redactPii(caseRecord.Subject || '', opts),
    Description: redactPii(caseRecord.Description || '', opts)
  };
}

export function redactComments(comments, opts) {
  if (!comments?.length) return comments;
  return comments.map(c => ({ ...c, CommentBody: redactPii(c.CommentBody || '', opts) }));
}
