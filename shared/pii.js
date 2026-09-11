const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const AWS_KEY_RE = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;

export function redactPii(text) {
  if (!text) return text;
  return String(text)
    .replace(EMAIL_RE, '[REDACTED-EMAIL]')
    .replace(SSN_RE, '[REDACTED-SSN]')
    .replace(AWS_KEY_RE, '[REDACTED-KEY]')
    .replace(CREDIT_CARD_RE, '[REDACTED-CC]')
    .replace(PHONE_RE, '[REDACTED-PHONE]')
    .replace(IPV4_RE, '[REDACTED-IP]');
}

export function redactCaseRecord(caseRecord) {
  if (!caseRecord) return caseRecord;
  return {
    ...caseRecord,
    Subject: redactPii(caseRecord.Subject || ''),
    Description: redactPii(caseRecord.Description || '')
  };
}

export function redactComments(comments) {
  if (!comments?.length) return comments;
  return comments.map(c => ({ ...c, CommentBody: redactPii(c.CommentBody || '') }));
}
