import { h, asyncModal, statusPill, richHtmlBox, fieldLabel } from './ui.js';
import { escapeHtml } from './markdown.js';

function htmlField(label, html, opts = {}) {
  return h('div', { style: { marginBottom: opts.compact ? '8px' : '12px' } },
    fieldLabel(label, { marginBottom: '4px' }),
    richHtmlBox(html)
  );
}

export function renderArticleColumn(a, opts = {}) {
  const col = h('div', null);
  col.appendChild(h('div', { style: { fontSize: opts.compact ? '13px' : '15px', fontWeight: '600', marginBottom: opts.compact ? '4px' : '6px' } }, a.title || ''));
  col.appendChild(h('div', { style: { display: 'flex', gap: '6px', marginBottom: opts.compact ? '8px' : '12px', flexWrap: 'wrap', alignItems: 'center' } },
    statusPill(a.publishStatus),
    a.validationStatus ? h('span', { class: 'pill pill--neutral', style: { fontSize: '10px' } }, a.validationStatus) : null
  ));
  if (a.summary) col.appendChild(htmlField('Summary', `<p>${escapeHtml(a.summary)}</p>`, opts));
  col.appendChild(htmlField('Description', a.descriptionHtml, opts));
  col.appendChild(htmlField('Resolution', a.resolutionHtml, opts));
  if (a.stepsHtml) col.appendChild(htmlField('Steps', a.stepsHtml, opts));
  const authorLine = [
    a.createdByName ? `Created by ${a.createdByName}` : null,
    a.lastModifiedByName ? `Last modified by ${a.lastModifiedByName}` : null
  ].filter(Boolean).join(' · ');
  if (authorLine) {
    col.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px', borderTop: '1px solid var(--border)', paddingTop: '8px' } }, authorLine));
  }
  return col;
}

function fetchArticlePreviewData(articleId) {
  return chrome.runtime.sendMessage({ action: 'FETCH_ARTICLE_PREVIEW', articleId });
}

export function previewButton(articleId, meta = {}, opts = {}) {
  return h('button', {
    class: 'btn btn--ghost btn--sm',
    style: opts.style || null,
    title: 'Preview article content locally',
    'aria-label': 'Preview article content',
    onClick: (e) => { e.stopPropagation(); showArticlePreview(articleId, meta); }
  }, '👁');
}

function showArticlePreview(articleId, meta = {}) {
  asyncModal(
    meta.articleNumber ? `#${meta.articleNumber}${meta.title ? ' — ' + meta.title : ''}` : 'Article Preview',
    () => fetchArticlePreviewData(articleId).then(resp => {
      if (!resp?.success) throw new Error(resp?.error || 'Failed to load article.');
      return resp.article;
    }),
    (article) => renderArticleColumn(article),
    { wide: true }
  );
}

export function showArticleCompare(metaA = {}, metaB = {}) {
  const title = `Compare: #${metaA.articleNumber || ''} vs #${metaB.articleNumber || ''}`;
  asyncModal(
    title,
    () => Promise.all([fetchArticlePreviewData(metaA.id), fetchArticlePreviewData(metaB.id)]).then(([respA, respB]) => {
      if (!respA?.success || !respB?.success) throw new Error(respA?.error || respB?.error || 'Failed to load one or both articles.');
      return [respA.article, respB.article];
    }),
    ([articleA, articleB]) => h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', maxHeight: '70vh', overflow: 'auto' } },
      h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--border)' } }, `#${articleA.articleNumber}`),
        renderArticleColumn(articleA, { compact: true })
      ),
      h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
        h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--primary)' } }, `#${articleB.articleNumber}`),
        renderArticleColumn(articleB, { compact: true })
      )
    ),
    { wide: true }
  );
}
