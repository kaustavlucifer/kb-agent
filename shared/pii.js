const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_RE = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g;
const PHONE_RE = /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const AWS_KEY_RE = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SF_ID_RE = /\b([A-Za-z0-9]{3})([A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)\b/g;

export function redactPii(text, opts = {}) {
  if (!text) return text;
  let out = String(text)
    .replace(EMAIL_RE, '[REDACTED-EMAIL]')
    .replace(SSN_RE, '[REDACTED-SSN]')
    .replace(AWS_KEY_RE, '[REDACTED-KEY]')
    .replace(CREDIT_CARD_RE, '[REDACTED-CC]')
    .replace(PHONE_RE, '[REDACTED-PHONE]')
    .replace(IPV4_RE, '[REDACTED-IP]');
  if (opts.maskIds) {
    out = out.replace(SF_ID_RE, (full, prefix, rest) => {
      const whole = prefix + rest;
      if (!/[0-9]/.test(whole) || !/[A-Za-z]/.test(whole)) return full;
      return prefix + 'X'.repeat(rest.length);
    });
  }
  return out;
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
