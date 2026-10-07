import { redactPii } from './pii.js';

export const KI_PII_OPTS = { maskIds: true };

export const KI_SECTION_KEYS = ['subject', 'summary', 'repro', 'workaround'];

export function normalizeKiText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function kiSectionsDiffer(a, b) {
  return KI_SECTION_KEYS.some(k => normalizeKiText(a?.[k]) !== normalizeKiText(b?.[k]));
}

export function kiVersionLabel(basedOnDraft, published) {
  if (!basedOnDraft) return 'Published';
  return published ? 'Draft (unpublished edits)' : 'Draft';
}

export function kiPublicationState({ published, approvalStatus, draftDiffers }) {
  if (published) {
    if (approvalStatus === 'Pending') return { label: 'Published · edits pending approval', tone: 'warning' };
    if (draftDiffers) return { label: 'Published · unsubmitted edits', tone: 'warning' };
    return { label: 'Published', tone: 'success' };
  }
  if (approvalStatus === 'Pending') return { label: 'Draft · pending approval', tone: 'info' };
  if (approvalStatus === 'Rejected') return { label: 'Draft · rejected', tone: 'error' };
  if (approvalStatus === 'Removed') return { label: 'Draft · approval recalled', tone: 'neutral' };
  if (approvalStatus === 'Approved') return { label: 'Unpublished', tone: 'neutral' };
  if (approvalStatus === 'Unknown') return { label: 'Draft · approval unknown', tone: 'neutral' };
  return { label: 'Draft · not submitted', tone: 'neutral' };
}

export const KI_SYSTEM_PROMPT = `You are drafting a Salesforce Known Issue (KI) record. Known Issues are PUBLIC-FACING — they publish directly to help.salesforce.com/s/issues. Write as a formal technical writer:
- Do NOT include customer names, employee names, backup IDs, org IDs, or any other customer-identifying detail
- If a 15 or 18 character Salesforce record ID must be mentioned, keep only the first 3 characters and replace the rest with X
- Do NOT include internal infrastructure details, internal build/version codes, or internal-only URLs
- Use clear, easy-to-understand, formal language — no ALL-CAPS, use correct product/feature names
- Output EXACTLY these 4 fields:
  subject: title description of the issue
  summary: one paragraph max — what customers experience and where in the product
  repro: numbered steps to reproduce
  workaround: numbered steps, or exactly "There is no workaround at this time" if none is known
Return JSON: {"subject":"...","summary":"...","repro":"...","workaround":"..."}`;

export const KI_REWRITE_SYSTEM_PROMPT = `${KI_SYSTEM_PROMPT}\nYou are REVISING an existing Known Issue — preserve accurate technical content, improve clarity, fix any customer-identifying leaks, and fill in Repro/Workaround if missing or weak.`;

export const KI_SCORING_SYSTEM_PROMPT = `You are a strict reviewer of Salesforce Known Issue (KI) records. KIs are PUBLIC-FACING — they publish directly to help.salesforce.com/s/issues. Score this KI on these criteria, each out of the given max, summing to 100:

- subject (20): clear, specific, correct product/feature names, not ALL-CAPS, no customer-specific or internal detail
- summary (20): one paragraph max, states what customers experience and where in the product, no customer-specific or internal detail
- repro (25): clear numbered steps to reproduce the issue
- workaround (25): clear numbered workaround steps, or explicitly states "There is no workaround at this time" if none
- safety (10): no customer names, employee names, internal IDs/build codes, or internal URLs leaked; any 15/18-character Salesforce ID is properly masked (first 3 characters kept, rest replaced with X)

Return ONLY JSON: {"overall":<sum>,"criteria":[{"id":"subject","label":"Subject","score":<n>,"max":20,"passed":["..."],"issues":["..."]},{"id":"summary","label":"Summary","score":<n>,"max":20,"passed":["..."],"issues":["..."]},{"id":"repro","label":"Repro Steps","score":<n>,"max":25,"passed":["..."],"issues":["..."]},{"id":"workaround","label":"Workaround","score":<n>,"max":25,"passed":["..."],"issues":["..."]},{"id":"safety","label":"PII/Redaction Safety","score":<n>,"max":10,"passed":["..."],"issues":["..."]}]}`;

export function buildKiRewriteUserPrompt(existing, chatterNotes, instructions) {
  return `EXISTING KNOWN ISSUE:
Subject: ${redactPii(existing.subject || '', KI_PII_OPTS)}
Summary: ${redactPii(existing.summary || '', KI_PII_OPTS)}
Repro: ${redactPii(existing.repro || '', KI_PII_OPTS)}
Workaround: ${redactPii(existing.workaround || '', KI_PII_OPTS)}${chatterNotes ? `\n\nRELATED CHATTER NOTES (internal context only — factual/technical input from SMEs on this KI, if any; use only if genuinely relevant, ignore automated or irrelevant notes):\n${redactPii(chatterNotes, KI_PII_OPTS)}` : ''}${instructions ? `\n\nADDITIONAL USER INSTRUCTIONS (follow these while still satisfying every rule above): ${redactPii(instructions, KI_PII_OPTS)}` : ''}`;
}

export function buildKiScoreUserPrompt(ki) {
  return `Subject: ${redactPii(ki.subject || '', KI_PII_OPTS)}\nSummary: ${redactPii(ki.summary || '', KI_PII_OPTS)}\nRepro: ${redactPii(ki.repro || '', KI_PII_OPTS)}\nWorkaround: ${redactPii(ki.workaround || '', KI_PII_OPTS)}`;
}
