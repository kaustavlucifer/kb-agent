import { confirmModal, toast } from './ui.js';

export function sectionsToPublishArray(parsed) {
  const sections = [];
  if (parsed.description) sections.push({ heading: 'Description', body: parsed.description });
  if (parsed.resolution) sections.push({ heading: 'Resolution', body: parsed.resolution });
  return sections;
}

const _publishLocks = new Set();

function acquireLock(key) {
  if (_publishLocks.has(key)) return false;
  _publishLocks.add(key);
  return true;
}

function releaseLock(key) {
  _publishLocks.delete(key);
}

export async function confirmDraftOverwriteIfExists(existingArticleId, contentLabel = 'this content') {
  const key = `draft:${existingArticleId}`;
  if (!acquireLock(key)) {
    toast('A publish is already in progress for this article.', 'info');
    return false;
  }
  try {
    const draftCheck = await chrome.runtime.sendMessage({ action: 'CHECK_DRAFT_EXISTS', payload: { existingArticleId } });
    if (!draftCheck?.hasDraft) return true;
    const proceed = await confirmModal(
      'Existing Draft Found',
      `A draft version of this article already exists. Replace its content with ${contentLabel}, or leave the existing draft as is?`,
      { confirmLabel: 'Replace Draft Content', cancelLabel: 'Leave As Is' }
    );
    if (!proceed) {
      toast('Publish cancelled — existing draft left unchanged.', 'info');
      releaseLock(key);
    }
    return proceed;
  } catch (e) {
    releaseLock(key);
    throw e;
  }
}

export async function publishDraftUpdate({ existingArticleId, title, summary, sections, taxonomyName, caseNumber }) {
  const key = `draft:${existingArticleId}`;
  toast('Creating new draft version in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_UPDATE_DRAFT',
      payload: { existingArticleId, title, summary, sections, taxonomyName: taxonomyName || null, caseNumber }
    });
    if (resp?.success) {
      const actionLabel = (resp.action === 'patched-draft' || resp.action === 'updated-existing-draft') ? 'Existing draft updated!' : 'New draft version created!';
      toast(actionLabel, 'success');
      if (resp.warning) toast(resp.warning, 'warning');
    } else {
      toast(resp?.error || 'Failed to create draft version.', 'error');
    }
    return resp;
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    return { success: false, error: e.message };
  } finally {
    releaseLock(key);
  }
}

export async function publishNewArticleDraft({ title, summary, sections, taxonomyName, caseNumber }) {
  const key = `new:${JSON.stringify({ title, summary, sections, taxonomyName, caseNumber })}`;
  if (!acquireLock(key)) {
    toast('A publish is already in progress.', 'info');
    return { success: false, error: 'Publish already in progress.' };
  }
  toast('Creating article in ORGCS…', 'info');
  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'PUBLISH_NEW_ARTICLE',
      payload: { title, summary, sections, taxonomyName: taxonomyName || null, caseNumber }
    });
    if (resp?.success) toast('Article created!', 'success');
    else toast(resp?.error || 'Failed to create article.', 'error');
    return resp;
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    return { success: false, error: e.message };
  } finally {
    releaseLock(key);
  }
}
