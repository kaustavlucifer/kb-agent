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

export function progressBar(pct, variant = 'default') {
  return h('div', { class: 'progress' },
    h('div', { class: `progress__fill progress__fill--${variant}`, style: { width: `${pct}%` } }),
    h('span', { class: 'progress__label' }, `${Math.round(pct)}%`)
  );
}

export function spinner(size = 'md') {
  return h('div', { class: `spinner spinner--${size}` });
}

export function emptyState(icon, text) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-state__icon' }, icon),
    h('div', { class: 'empty-state__text' }, text)
  );
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
