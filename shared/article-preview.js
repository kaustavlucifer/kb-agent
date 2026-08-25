import { h, modal, spinner, statusPill, richHtmlBox } from './ui.js';
import { escapeHtml } from './markdown.js';

function htmlField(label, html, opts = {}) {
  return h('div', { style: { marginBottom: opts.compact ? '8px' : '12px' } },
    h('div', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' } }, label),
    richHtmlBox(html)
  );
}

function renderArticleColumn(a, opts = {}) {
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

function loadingModal(title) {
  const content = h('div', { style: { minHeight: '120px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '120px' } }, spinner('md'))
  );
  modal(title, content, { wide: true });
  return content;
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

export function showArticlePreview(articleId, meta = {}) {
  const content = loadingModal(meta.articleNumber ? `#${meta.articleNumber}${meta.title ? ' — ' + meta.title : ''}` : 'Article Preview');

  fetchArticlePreviewData(articleId)
    .then(resp => {
      content.textContent = '';
      if (!resp?.success) {
        content.appendChild(h('span', { style: { color: 'var(--error)' } }, resp?.error || 'Failed to load article.'));
        return;
      }
      content.appendChild(renderArticleColumn(resp.article));
    })
    .catch(e => {
      content.textContent = '';
      content.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + e.message));
    });
}

export function showArticleCompare(metaA = {}, metaB = {}) {
  const title = `Compare: #${metaA.articleNumber || ''} vs #${metaB.articleNumber || ''}`;
  const content = loadingModal(title);

  Promise.all([fetchArticlePreviewData(metaA.id), fetchArticlePreviewData(metaB.id)])
    .then(([respA, respB]) => {
      content.textContent = '';
      if (!respA?.success || !respB?.success) {
        content.appendChild(h('span', { style: { color: 'var(--error)' } }, respA?.error || respB?.error || 'Failed to load one or both articles.'));
        return;
      }
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', maxHeight: '70vh', overflow: 'auto' } },
        h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
          h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--border)' } }, `#${respA.article.articleNumber}`),
          renderArticleColumn(respA.article, { compact: true })
        ),
        h('div', { style: { minWidth: '0', overflowWrap: 'break-word' } },
          h('div', { style: { fontSize: '11px', fontWeight: '700', color: 'var(--primary)', textTransform: 'uppercase', marginBottom: '10px', paddingBottom: '6px', borderBottom: '2px solid var(--primary)' } }, `#${respB.article.articleNumber}`),
          renderArticleColumn(respB.article, { compact: true })
        )
      );
      content.appendChild(grid);
    })
    .catch(e => {
      content.textContent = '';
      content.appendChild(h('span', { style: { color: 'var(--error)' } }, 'Error: ' + e.message));
    });
}
