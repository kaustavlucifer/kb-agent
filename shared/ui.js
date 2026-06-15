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

export function modal(title, contentEl, opts = {}) {
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
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);

  function close() {
    backdrop.remove();
    if (opts.onClose) opts.onClose();
  }
  return { close, backdrop, box };
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

// Standard tab layout: a non-scrolling sticky header region + a scrolling body.
// Returns both sections AND appends them to the container in order.
export function stickyScrollLayout(container) {
  const sticky = h('div', { class: 'main__sticky' });
  const scroll = h('div', { class: 'main__scroll' });
  container.appendChild(sticky);
  container.appendChild(scroll);
  return { sticky, scroll };
}

// Sortable-table state factory. Encapsulates the col/dir toggle + arrow indicator
// that every table tab re-implemented identically.
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
    // Compares two values for the active direction. Caller supplies the accessor.
    compare(va, vb) {
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    }
  };
}

// A row of big-number / small-label stat blocks. `stats` is an array of
// { value, label, color? } — color is a CSS value (e.g. 'var(--success)').
export function statsBar(stats) {
  return h('div', { class: 'card stats-bar' },
    h('div', { class: 'stats-bar__row' },
      ...stats.filter(Boolean).map(s => h('div', { class: 'stats-bar__item' },
        h('div', { class: 'stats-bar__value', style: s.color ? { color: s.color } : null }, String(s.value)),
        h('div', { class: 'stats-bar__label' }, s.label)
      ))
    )
  );
}

// Streaming-output modal shell. Opens a modal with a scrollable stream area and a
// "Copy" action, and hands back the stream element + helpers so callers can pump
// deltas in (from streamClaude or a port) without re-implementing the shell.
// onClose is invoked when the modal closes (use it to disconnect ports).
export function streamingModal(title, { header = null, onClose } = {}) {
  const stream = h('div', { class: 'stream-output' });
  stream.appendChild(spinner('md'));
  let raw = '';
  const content = h('div', null, header, stream);
  const ref = modal(title, content, {
    wide: true,
    onClose,
    primaryAction: {
      label: 'Copy',
      handler: () => navigator.clipboard.writeText(raw).then(() => toast('Copied.', 'success'))
    }
  });
  return {
    ...ref,
    stream,
    getRaw: () => raw,
    // Replace the stream content with rendered markdown for the given full text.
    renderFull(text, { scroll = false } = {}) {
      raw = text;
      stream.textContent = '';
      stream.appendChild(renderMarkdown(text));
      if (scroll) stream.scrollTop = stream.scrollHeight;
    },
    setError(message) {
      raw = '';
      stream.textContent = '';
      stream.appendChild(h('span', { style: { color: 'var(--error)', fontSize: '12px' } }, message));
    }
  };
}

export function renderInlineFormatting(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  if (parts.length === 1) return document.createTextNode(text);
  const span = h('span', null);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      span.appendChild(h('strong', { style: { fontWeight: '600' } }, part.slice(2, -2)));
    } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      span.appendChild(h('em', null, part.slice(1, -1)));
    } else if (part.startsWith('`') && part.endsWith('`')) {
      span.appendChild(h('code', { style: { background: 'var(--surface-raised)', padding: '1px 4px', borderRadius: '3px', fontSize: '11px', fontFamily: 'var(--font-mono)' } }, part.slice(1, -1)));
    } else if (part) {
      span.appendChild(document.createTextNode(part));
    }
  }
  return span;
}

export function renderMarkdown(text) {
  if (!text) return h('span', null, '');
  const lines = text.split('\n');
  const container = h('div', { style: { fontSize: '12px', lineHeight: '1.6' } });
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = '';
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (!tableRows.length) return;
    const table = h('table', { class: 'data-table', style: { marginTop: '8px', marginBottom: '12px', width: '100%' } });
    const headerRow = tableRows[0];
    const separatorIdx = tableRows.findIndex(r => /^[\s|:-]+$/.test(r.replace(/\|/g, '').replace(/[-:]/g, '')));
    const dataStart = separatorIdx >= 0 ? separatorIdx + 1 : 1;
    if (headerRow) {
      const cells = headerRow.split('|').map(c => c.trim()).filter(Boolean);
      table.appendChild(h('thead', null, h('tr', null, ...cells.map(c => h('th', { style: { fontSize: '11px', padding: '6px 8px' } }, renderInlineFormatting(c))))));
    }
    const tbody = h('tbody', null);
    for (let i = dataStart; i < tableRows.length; i++) {
      const cells = tableRows[i].split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length) tbody.appendChild(h('tr', null, ...cells.map(c => h('td', { style: { fontSize: '11px', padding: '5px 8px' } }, renderInlineFormatting(c)))));
    }
    table.appendChild(tbody);
    container.appendChild(table);
    tableRows = [];
    inTable = false;
  }

  for (const line of lines) {
    if (!inCodeBlock && /^```(\w*)/.test(line)) {
      if (inTable) flushTable();
      inCodeBlock = true;
      codeLang = line.match(/^```(\w*)/)[1] || '';
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      if (line.startsWith('```')) {
        const pre = h('pre', { style: { background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', fontSize: '11px', fontFamily: 'var(--font-mono)', overflowX: 'auto', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
        if (codeLang) {
          pre.appendChild(h('div', { style: { fontSize: '9px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px', fontWeight: '600' } }, codeLang));
        }
        pre.appendChild(h('code', null, codeLines.join('\n')));
        container.appendChild(pre);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (line.trim().startsWith('|')) { inTable = true; tableRows.push(line.trim()); continue; }
    if (inTable) flushTable();
    if (/^---+$/.test(line.trim())) container.appendChild(h('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' } }));
    else if (line.startsWith('### ')) container.appendChild(h('h4', { style: { fontSize: '12px', fontWeight: '600', marginTop: '6px', marginBottom: '3px' } }, line.slice(4)));
    else if (line.startsWith('## ')) container.appendChild(h('h3', { style: { fontSize: '13px', fontWeight: '600', marginTop: '8px', marginBottom: '4px' } }, line.slice(3)));
    else if (line.startsWith('# ')) container.appendChild(h('h2', { style: { fontSize: '14px', fontWeight: '700', marginTop: '10px', marginBottom: '4px' } }, line.slice(2)));
    else if (line.startsWith('- ') || line.startsWith('* ')) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, renderInlineFormatting('• ' + line.slice(2))));
    else if (/^\d+\.\s/.test(line)) container.appendChild(h('div', { style: { paddingLeft: '12px' } }, renderInlineFormatting(line)));
    else if (line.trim()) container.appendChild(h('p', { style: { margin: '4px 0' } }, renderInlineFormatting(line)));
  }

  if (inTable) flushTable();
  if (inCodeBlock && codeLines.length) {
    const pre = h('pre', { style: { background: 'var(--surface-raised)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xs)', padding: '10px 12px', fontSize: '11px', fontFamily: 'var(--font-mono)', overflowX: 'auto', margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } });
    pre.appendChild(h('code', null, codeLines.join('\n')));
    container.appendChild(pre);
  }

  return container;
}

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

  const dropdown = h('div', { style: { display: 'none', position: 'absolute', top: '100%', left: '0', marginTop: '4px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0', maxHeight: '320px', overflowY: 'hidden', zIndex: '500', minWidth: '220px', boxShadow: 'var(--shadow-md)', display: 'none', flexDirection: 'column' } });

  const searchInput = h('input', { type: 'text', placeholder: `Search ${label}…`, style: { width: '100%', padding: '6px 8px', fontSize: '11px', border: 'none', borderBottom: '1px solid var(--border)', outline: 'none', background: 'var(--surface)', boxSizing: 'border-box' } });
  searchInput.addEventListener('input', () => filterOptions(searchInput.value));
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
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface-raised)'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', e => e.stopPropagation());
    listWrap.appendChild(item);
  });
  dropdown.appendChild(listWrap);

  const actionsBar = h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '6px 8px', borderTop: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', bottom: '0' } },
    h('div', { style: { display: 'flex', gap: '10px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }, onClick: e => { e.stopPropagation(); pending = options.map(o => o.value); updateCheckboxes(); } }, 'All'),
      h('div', { style: { fontSize: '11px', color: 'var(--error)', cursor: 'pointer' }, onClick: e => { e.stopPropagation(); pending = []; updateCheckboxes(); } }, 'Clear')
    ),
    h('div', { style: { fontSize: '11px', color: 'var(--primary)', cursor: 'pointer', fontWeight: '600' }, onClick: e => { e.stopPropagation(); dropdown.style.display = 'none'; onChange(pending); } }, 'Apply')
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

  function toggleDropdown(e) {
    e.stopPropagation();
    const visible = dropdown.style.display === 'flex';
    if (visible) {
      removeDismiss();
      dropdown.style.display = 'none';
      onChange(pending);
    } else {
      pending = [...selected];
      updateCheckboxes();
      searchInput.value = '';
      filterOptions('');
      dropdown.style.display = 'flex';
      setTimeout(() => searchInput.focus(), 0);
      removeDismiss();
      _dismiss = ev => {
        if (!wrap.isConnected) { removeDismiss(); return; }
        if (!wrap.contains(ev.target)) {
          dropdown.style.display = 'none';
          removeDismiss();
          onChange(pending);
        }
      };
      setTimeout(() => document.addEventListener('click', _dismiss), 0);
    }
  }

  return wrap;
}
