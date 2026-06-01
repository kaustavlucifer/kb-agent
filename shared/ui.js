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
