import { SAFE_URL_RE, markdownToHtml, htmlToMarkdown, parseRewriteSections, serializeRewriteSections } from './markdown.js';
import { SCORE_HIGH_THRESHOLD, SCORE_MID_THRESHOLD } from './config.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'class') {
        el.className = v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function uniqueSortedValues(items, field) {
  return [...new Set(items.map(item => item[field]).filter(Boolean))].sort();
}

export function statusPill(status, opts = {}) {
  if (!status) return null;
  const variant = status === 'Online' ? 'success' : status === 'Draft' ? 'warning' : 'neutral';
  const style = { fontSize: opts.fontSize || '10px' };
  if (opts.padding) style.padding = opts.padding;
  return h('span', { class: `pill pill--${variant}`, style }, status);
}

const SAFE_HTML_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel', 'colspan', 'rowspan', 'start', 'width', 'height', 'scope', 'headers', 'name', 'type', 'value', 'align', 'valign', 'border', 'cellpadding', 'cellspacing']);


function sanitizeHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,style,iframe,object,embed,form,input,link,meta,base').forEach(el => el.remove());
  div.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (!SAFE_HTML_ATTRS.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
    if (el.hasAttribute('href') && !SAFE_URL_RE.test(el.getAttribute('href'))) el.removeAttribute('href');
    if (el.hasAttribute('src') && !SAFE_URL_RE.test(el.getAttribute('src'))) el.removeAttribute('src');
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
    if (el.hasAttribute('style')) {
      const style = el.getAttribute('style');
      if (/expression|javascript|url\s*\(/i.test(style)) el.removeAttribute('style');
    }
  });
  return div.innerHTML;
}

export function richHtmlBox(html, opts = {}) {
  const box = h('div', {
    class: 'rich-html-box',
    style: {
      fontSize: '12px', lineHeight: '1.6',
      border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '8px 10px',
      ...(opts.tall ? { maxHeight: '260px', overflow: 'auto' } : null)
    }
  });
  box.innerHTML = html ? sanitizeHtml(html) : '<span style="color:var(--text-muted)">(empty)</span>';
  return box;
}

export function chip(state, label, opts = {}) {
  const el = h('div', { class: `chip chip--${state}`, title: opts.title || '' },
    h('span', { class: 'chip__dot' }),
    h('span', { class: 'chip__label' }, label)
  );
  if (opts.onClick) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', opts.onClick);
  }
  return el;
}

export function toast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = h('div', { id: 'toast-container', class: 'toast-container' });
    document.body.appendChild(container);
  }
  const t = h('div', { class: `toast toast--${type}` }, message);
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--visible'));
  setTimeout(() => {
    t.classList.remove('toast--visible');
    setTimeout(() => t.remove(), 300);
  }, duration);
}

const _modalStack = [];

function onModalKeydown(e) {
  if (e.key === 'Escape' && _modalStack.length) _modalStack[_modalStack.length - 1].close();
}

export function modal(title, contentEl, opts = {}) {
  if (!opts.stack) while (_modalStack.length) _modalStack[_modalStack.length - 1].close();

  const backdrop = h('div', { class: 'modal-backdrop' });
  const box = h('div', { class: `modal ${opts.wide ? 'modal--wide' : ''}` },
    h('div', { class: 'modal__header' },
      h('h2', { class: 'modal__title' }, title),
      h('button', { class: 'modal__close', onClick: close }, '×')
    ),
    h('div', { class: 'modal__body' }, contentEl),
    opts.footer || h('div', { class: 'modal__footer' },
      h('button', { class: 'btn btn--secondary', onClick: close }, 'Close'),
      opts.primaryAction
        ? h('button', { class: 'btn btn--primary', onClick: opts.primaryAction.handler }, opts.primaryAction.label)
        : null
    )
  );
  backdrop.appendChild(box);
  let pressedOnBackdrop = false;
  backdrop.addEventListener('mousedown', e => { pressedOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', e => { if (pressedOnBackdrop && e.target === backdrop) close(); pressedOnBackdrop = false; });
  document.body.appendChild(backdrop);

  const instance = { close, backdrop, box };
  if (!_modalStack.length) document.addEventListener('keydown', onModalKeydown);
  _modalStack.push(instance);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const idx = _modalStack.indexOf(instance);
    if (idx !== -1) _modalStack.splice(idx, 1);
    if (!_modalStack.length) document.removeEventListener('keydown', onModalKeydown);
    if (opts.onClose) opts.onClose();
  }
  return instance;
}

export function confirmModal(title, message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const content = h('div', { style: { fontSize: '13px', lineHeight: '1.5' } }, message);
    const footer = h('div', { class: 'modal__footer' },
      h('button', { class: 'btn btn--secondary', onClick: () => { decided = true; resolve(false); ref.close(); } }, cancelLabel),
      h('button', { class: 'btn btn--primary', onClick: () => { decided = true; resolve(true); ref.close(); } }, confirmLabel)
    );
    const ref = modal(title, content, { footer, stack: true, onClose: () => { if (!decided) resolve(false); } });
  });
}

export function progressBar(pct, variant = 'default', animated = false) {
  return h('div', { class: 'progress' },
    h('div', { class: `progress__fill progress__fill--${variant}${animated ? ' progress__fill--animated' : ''}`, style: { width: `${pct}%` } }),
    h('span', { class: 'progress__label' }, `${Math.round(pct)}%`)
  );
}

export function spinner(size = 'md') {
  return h('div', { class: `spinner spinner--${size}` });
}

export function streamingStatus(el, message) {
  if (!el) return;
  el.textContent = '';
  el.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0' } },
    spinner('sm'),
    h('span', { style: { fontSize: '12px', color: 'var(--primary)' } }, message)
  ));
}

export function markdownStreamThrottle(elId, throttleMs, isStale) {
  let throttle = null;
  return (full) => {
    if (throttle || isStale()) return;
    throttle = setTimeout(() => { throttle = null; }, throttleMs);
    const el = document.getElementById(elId);
    if (el) { el.textContent = ''; el.appendChild(renderMarkdown(full)); }
  };
}

export function swapButtonWithLink(btnId, opts = {}) {
  const btn = document.getElementById(btnId);
  if (btn) {
    const openBtn = opts.url
      ? h('button', { class: 'btn btn--primary btn--sm', onClick: () => chrome.tabs.create({ url: opts.url }) }, opts.label || 'Open in ORGCS ↗')
      : h('button', { class: 'btn btn--primary btn--sm', disabled: true }, opts.disabledLabel || 'Draft Created ✓');
    btn.replaceWith(openBtn);
  }
  (opts.removeIds || []).forEach(id => document.getElementById(id)?.remove());
}

export function streamingDots() {
  return h('span', { class: 'streaming-dots' },
    h('span', { class: 'streaming-dots__dot' }),
    h('span', { class: 'streaming-dots__dot' }),
    h('span', { class: 'streaming-dots__dot' })
  );
}

export function emptyState(icon, text) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-state__icon' }, icon),
    h('div', { class: 'empty-state__text' }, text)
  );
}

export function stickyScrollLayout(container) {
  const sticky = h('div', { class: 'main__sticky' });
  const scroll = h('div', { class: 'main__scroll' });
  container.appendChild(sticky);
  container.appendChild(scroll);
  return { sticky, scroll };
}

export function scoreColor(score) {
  return score >= SCORE_HIGH_THRESHOLD ? 'success' : score >= SCORE_MID_THRESHOLD ? 'warning' : 'error';
}

export function crossScopeToggle({ label, title, checked, onChange }) {
  const checkbox = h('input', { type: 'checkbox' });
  checkbox.checked = checked;
  checkbox.addEventListener('change', e => onChange(e.target.checked));
  return h('label', { style: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }, title: title || '' }, checkbox, label);
}

export function requestToken() {
  let current = 0;
  return {
    next() { return ++current; },
    isCurrent(id) { return id === current; }
  };
}

export function paginationBar({ page, totalPages, pageStart, pageCount, total, noun, prefix = '', onPage }) {
  const label = noun
    ? `${prefix}${totalPages > 1 ? `Showing ${pageStart + 1}–${pageStart + pageCount} of ${total} ${noun} (Page ${page + 1}/${totalPages})` : `${total} ${noun}`}`
    : (total ? `${prefix}Showing ${pageStart + 1}–${pageStart + pageCount} of ${total} (Page ${page + 1}/${totalPages})` : '');
  return h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', marginTop: '12px', fontSize: '12px' } },
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: page === 0, onClick: () => onPage(page - 1) }, '← Prev') : null,
    h('span', { style: { color: 'var(--text-secondary)' } }, label),
    totalPages > 1 ? h('button', { class: 'btn btn--ghost btn--sm', disabled: page >= totalPages - 1, onClick: () => onPage(page + 1) }, 'Next →') : null
  );
}

export function fieldLabel(text, style = {}) {
  return h('div', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', ...style } }, text);
}

export function asyncModal(title, load, render, opts = {}) {
  const content = h('div', { style: { minHeight: '120px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '120px' } }, spinner('md'))
  );
  const instance = modal(title, content, opts);
  load()
    .then(result => {
      content.style.minHeight = '';
      content.textContent = '';
      content.appendChild(render(result));
    })
    .catch(e => {
      content.style.minHeight = '';
      content.textContent = '';
      content.appendChild(h('div', { style: { color: 'var(--error)', fontSize: '12px' } }, 'Error: ' + e.message));
    });
  return instance;
}

export function createSorter(defaultCol, defaultDir = 'asc') {
  let col = defaultCol;
  let dir = defaultDir;
  return {
    get col() { return col; },
    get dir() { return dir; },
    toggle(c) {
      if (col === c) dir = dir === 'asc' ? 'desc' : 'asc';
      else { col = c; dir = 'asc'; }
    },
    set(c, d) { col = c; dir = d; },
    indicator(c) { return col === c ? (dir === 'asc' ? ' ↑' : ' ↓') : ''; },
    compare(va, vb) {
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    }
  };
}

export function renderMarkdown(text) {
  const container = h('div', { class: 'md-render' });
  if (!text) return container;
  container.innerHTML = sanitizeHtml(markdownToHtml(text, { headingBase: 2 }));
  return container;
}

export function editableRichField({ label, getValue, setValue, plain = false, singleLine = false, rows = 8, onRefine = null, editing = false, onEditingChange = null }) {
  const wrap = h('div', { style: { marginBottom: '14px' } });

  const fieldHeader = (actions) => h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
    h('span', { style: { fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
    h('div', { style: { display: 'flex', gap: '6px' } }, ...actions)
  );

  const buildView = () => {
    if (onEditingChange) onEditingChange(false);
    const value = getValue() || '';
    const editBtn = h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => swapToEdit() }, 'Edit');
    const refineBtn = onRefine ? h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px', color: 'var(--primary)' }, onClick: () => onRefine() }, 'Refine') : null;
    const body = plain
      ? h('div', { style: { fontSize: '13px', fontWeight: singleLine ? '600' : '400', lineHeight: '1.5', whiteSpace: 'pre-wrap' } }, value || '(empty)')
      : (value.trim() ? renderMarkdown(value) : h('span', { style: { color: 'var(--text-muted)', fontSize: '12px' } }, '(empty)'));
    wrap.textContent = '';
    wrap.appendChild(fieldHeader([refineBtn, editBtn].filter(Boolean)));
    wrap.appendChild(body);
  };

  const swapToEdit = () => {
    if (onEditingChange) onEditingChange(true);
    const value = getValue() || '';

    if (plain) {
      const input = singleLine
        ? h('input', { type: 'text', class: 'input', style: { width: '100%', fontSize: '13px', fontWeight: '600' } })
        : h('textarea', { class: 'input', rows: String(rows), style: { width: '100%', fontSize: '12px', lineHeight: '1.6', resize: 'vertical' } });
      input.value = value;
      const done = h('button', { class: 'btn btn--primary btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => { setValue(input.value); buildView(); } }, 'Done');
      const cancel = h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => buildView() }, 'Cancel');
      wrap.textContent = '';
      wrap.appendChild(fieldHeader([cancel, done]));
      wrap.appendChild(input);
      input.focus();
      return;
    }

    const editor = h('div', {
      class: 'kb-richtext',
      contenteditable: 'true',
      style: { minHeight: `${rows * 20}px`, maxHeight: '360px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', fontSize: '12px', lineHeight: '1.6', outline: 'none' }
    });
    editor.innerHTML = markdownToHtml(value, { headingBase: 1 });

    const applyCmd = (cmd, arg) => { editor.focus(); try { document.execCommand('styleWithCSS', false, false); } catch {} document.execCommand(cmd, false, arg); };
    const toolBtn = (labelTxt, cmd, arg, title) => h('button', { class: 'btn btn--ghost btn--sm', title: title || labelTxt, style: { padding: '2px 8px', fontSize: '12px', minWidth: '28px', fontWeight: cmd === 'bold' ? '700' : '400', fontStyle: cmd === 'italic' ? 'italic' : 'normal' }, onMouseDown: (e) => { e.preventDefault(); applyCmd(cmd, arg); } }, labelTxt);
    const linkBtn = h('button', { class: 'btn btn--ghost btn--sm', title: 'Insert link', style: { padding: '2px 8px', fontSize: '11px' }, onMouseDown: (e) => { e.preventDefault(); const url = prompt('Link URL:'); if (url) applyCmd('createLink', url); } }, '🔗');

    const toolbar = h('div', { style: { display: 'flex', gap: '2px', flexWrap: 'wrap', marginBottom: '6px', padding: '4px', background: 'var(--surface-subtle, rgba(0,0,0,0.03))', borderRadius: 'var(--radius-xs)' } },
      toolBtn('B', 'bold', null, 'Bold'),
      toolBtn('I', 'italic', null, 'Italic'),
      toolBtn('H2', 'formatBlock', '<H2>', 'Heading'),
      toolBtn('H3', 'formatBlock', '<H3>', 'Subheading'),
      toolBtn('¶', 'formatBlock', '<P>', 'Normal text'),
      toolBtn('• List', 'insertUnorderedList', null, 'Bulleted list'),
      toolBtn('1. List', 'insertOrderedList', null, 'Numbered list'),
      linkBtn
    );

    const done = h('button', { class: 'btn btn--primary btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => { setValue(htmlToMarkdown(editor)); buildView(); } }, 'Done');
    const cancel = h('button', { class: 'btn btn--ghost btn--sm', style: { padding: '2px 8px', fontSize: '11px' }, onClick: () => buildView() }, 'Cancel');

    wrap.textContent = '';
    wrap.appendChild(fieldHeader([cancel, done]));
    wrap.appendChild(toolbar);
    wrap.appendChild(editor);
    editor.focus();
  };

  if (editing) swapToEdit(); else buildView();
  return wrap;
}

export function sectionsEditor({ getCachedText, setCachedText, fields, deriveDefaults }) {
  const fieldNames = fields.map(f => f.field);
  function currentSections(key) {
    const parsed = parseRewriteSections(getCachedText(key) || '', fieldNames);
    return deriveDefaults ? deriveDefaults(key, parsed) : parsed;
  }
  function commitSection(key, field, value) {
    const sections = currentSections(key);
    sections[field] = value.trim();
    setCachedText(key, serializeRewriteSections(sections, fieldNames));
  }
  function renderSection(key, field, label, opts = {}) {
    return editableRichField({
      label,
      getValue: () => currentSections(key)[field] || '',
      setValue: (v) => commitSection(key, field, v),
      plain: !!opts.plain,
      singleLine: opts.singleLine ?? field === 'title',
      rows: opts.rows || 2
    });
  }
  function renderInto(containerEl, key) {
    for (const f of fields) containerEl.appendChild(renderSection(key, f.field, f.label, f));
  }
  return { renderInto };
}

let _openMultiSelect = null;

export function multiSelect(id, label, options, selected, onChange) {
  const wrap = h('div', { class: 'multi-select', id });
  wrap.style.position = 'relative';
  wrap.style.display = 'inline-block';
  let pending = [...selected];

  const trigger = h('div', {
    style: { padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '12px', cursor: 'pointer', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: '6px', minWidth: '140px', justifyContent: 'space-between' }
  },
    h('span', { style: { color: selected.length ? 'var(--text-primary)' : 'var(--text-muted)' } },
      selected.length ? `${label} (${selected.length})` : label
    ),
    h('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, '▼')
  );
  trigger.addEventListener('click', toggleDropdown);
  wrap.appendChild(trigger);

  const dropdown = h('div', { class: 'multi-select__dropdown', style: { display: 'none' } });

  const searchInput = h('input', { type: 'text', placeholder: `Search ${label}…`, style: { width: '100%', padding: '6px 8px', fontSize: '11px', border: 'none', borderBottom: '1px solid var(--border)', outline: 'none', background: 'var(--surface)', boxSizing: 'border-box' } });
  let filterDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(filterDebounce);
    filterDebounce = setTimeout(() => filterOptions(searchInput.value), 120);
  });
  searchInput.addEventListener('click', e => e.stopPropagation());
  dropdown.appendChild(searchInput);

  const listWrap = h('div', { style: { overflowY: 'auto', maxHeight: '240px', padding: '4px' } });

  const checkboxes = [];
  options.forEach(opt => {
    const checked = pending.includes(opt.value);
    const checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = checked;
    checkbox.addEventListener('change', e => {
      e.stopPropagation();
      if (e.target.checked) { if (!pending.includes(opt.value)) pending.push(opt.value); }
      else { pending = pending.filter(v => v !== opt.value); }
    });
    checkboxes.push({ checkbox, value: opt.value, label: opt.label });
    const item = h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: 'var(--radius-xs)' } },
      checkbox,
      h('span', null, opt.label)
    );
    item.addEventListener('click', e => e.stopPropagation());
    listWrap.appendChild(item);
  });
  dropdown.appendChild(listWrap);

  const actionsBar = h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '6px 8px', borderTop: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', bottom: '0' } },
    h('div', { style: { display: 'flex', gap: '10px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }, onClick: e => { e.stopPropagation(); pending = options.map(o => o.value); updateCheckboxes(); } }, 'All'),
      h('div', { style: { fontSize: '11px', color: 'var(--error)', cursor: 'pointer' }, onClick: e => { e.stopPropagation(); pending = []; updateCheckboxes(); } }, 'Clear')
    ),
    h('div', { style: { fontSize: '11px', color: 'var(--primary)', cursor: 'pointer', fontWeight: '600' }, onClick: e => { e.stopPropagation(); closeDropdown(); } }, 'Apply')
  );
  dropdown.appendChild(actionsBar);
  wrap.appendChild(dropdown);

  function filterOptions(query) {
    const q = query.toLowerCase();
    checkboxes.forEach(({ checkbox, label }) => {
      const item = checkbox.closest('label');
      if (item) item.style.display = label.toLowerCase().includes(q) ? 'flex' : 'none';
    });
  }

  function updateCheckboxes() {
    checkboxes.forEach(({ checkbox, value }) => { checkbox.checked = pending.includes(value); });
  }

  let _dismiss = null;

  function removeDismiss() {
    if (_dismiss) { document.removeEventListener('click', _dismiss); _dismiss = null; }
  }

  function closeDropdown() {
    removeDismiss();
    dropdown.style.display = 'none';
    if (_openMultiSelect === closeDropdown) _openMultiSelect = null;
    if (!wrap.isConnected) return;
    const changed = pending.length !== selected.length || pending.some(v => !selected.includes(v));
    if (changed) onChange(pending);
  }

  function toggleDropdown() {
    if (dropdown.style.display === 'flex') { closeDropdown(); return; }
    if (_openMultiSelect) _openMultiSelect();
    if (!wrap.isConnected) return;
    pending = [...selected];
    updateCheckboxes();
    searchInput.value = '';
    filterOptions('');
    dropdown.style.display = 'flex';
    _openMultiSelect = closeDropdown;
    setTimeout(() => searchInput.focus(), 0);
    _dismiss = ev => {
      if (!wrap.isConnected || !wrap.contains(ev.target)) closeDropdown();
    };
    setTimeout(() => document.addEventListener('click', _dismiss), 0);
  }

  return wrap;
}
