export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const SAFE_URL_RE = /^(https?:|mailto:)/i;

const LINE_BREAK_RE = /\r\n?|[\u2028\u2029]/g;

function splitLines(text) {
  return String(text == null ? '' : text).replace(LINE_BREAK_RE, '\n').split('\n');
}

export function parseInline(text) {
  const src = String(text == null ? '' : text);
  const tokens = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(!\[[^\]]*\]\([^)\s]+\))|(\[(?!!)[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: src.slice(last, m.index) });
    const tok = m[0];
    if (m[1]) {
      tokens.push({ type: 'code', text: tok.slice(1, -1) });
    } else if (m[2]) {
      tokens.push({ type: 'bold', text: tok.slice(2, -2) });
    } else if (m[3]) {
      tokens.push({ type: 'italic', text: tok.slice(1, -1) });
    } else if (m[4]) {
      const split = tok.indexOf('](');
      tokens.push({ type: 'image', alt: tok.slice(2, split), src: tok.slice(split + 2, -1) });
    } else if (m[5]) {
      const split = tok.indexOf('](');
      tokens.push({ type: 'link', text: tok.slice(1, split), href: tok.slice(split + 2, -1) });
    }
    last = re.lastIndex;
  }
  if (last < src.length) tokens.push({ type: 'text', text: src.slice(last) });
  if (!tokens.length) tokens.push({ type: 'text', text: '' });
  return tokens;
}

function inlineToHtml(text) {
  return parseInline(text).map(t => {
    switch (t.type) {
      case 'bold': return `<strong>${escapeHtml(t.text)}</strong>`;
      case 'italic': return `<em>${escapeHtml(t.text)}</em>`;
      case 'code': return `<code>${escapeHtml(t.text)}</code>`;
      case 'link': {
        const safeHref = SAFE_URL_RE.test(t.href) ? t.href : '#';
        return `<a href="${escapeHtml(safeHref)}">${escapeHtml(t.text)}</a>`;
      }
      case 'image': {
        if (!/^https?:/i.test(t.src)) return '';
        return `<img src="${escapeHtml(t.src)}" alt="${escapeHtml(t.alt)}">`;
      }
      default: return escapeHtml(t.text);
    }
  }).join('');
}

function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

const LIST_ITEM_RE = /^\s*(?:[-*]|\d+\.)\s+/;

function parseListLevel(lines, from, baseIndent) {
  const items = [];
  let ordered = null;
  let start = 1;
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    const ind = indentOf(line);
    if (ind < baseIndent) break;
    if (ind === baseIndent) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
      const orderedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
      if (bulletMatch) {
        if (ordered === true) break;
        ordered = false;
        items.push({ text: bulletMatch[1], children: [] });
        i++;
      } else if (orderedMatch) {
        if (ordered === false) break;
        if (ordered === null) start = Number(line.match(/^\s*(\d+)\./)[1]);
        ordered = true;
        items.push({ text: orderedMatch[1], children: [] });
        i++;
      } else {
        break;
      }
    } else if (!items.length || /^\s*```/.test(line)) {
      break;
    } else if (LIST_ITEM_RE.test(line)) {
      const { list, next } = parseListLevel(lines, i, ind);
      const last = items[items.length - 1];
      if (!list.items.length) {
        last.text += '\n' + line.trim();
        i++;
        continue;
      }
      const prev = last.children[last.children.length - 1];
      if (prev && prev.ordered === list.ordered) prev.items.push(...list.items);
      else last.children.push(list);
      i = next;
    } else {
      items[items.length - 1].text += '\n' + line.trim();
      i++;
    }
  }
  return { list: { type: 'list', ordered: !!ordered, start, items }, next: i };
}

export function parseBlocks(md) {
  const lines = splitLines(md);
  const blocks = [];
  let i = 0;

  const isTableSep = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
  const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^(\s*)```([^\s`]*)\s*$/);
    if (fence) {
      const indent = fence[1];
      const lang = fence[2] || '';
      const stripIndent = new RegExp(`^\\s{0,${indent.length}}`);
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i].replace(stripIndent, '')); i++; }
      i++;
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (LIST_ITEM_RE.test(line)) {
      const { list, next } = parseListLevel(lines, i, indentOf(line));
      if (list.items.length) {
        blocks.push(list);
        i = next;
        continue;
      }
    }

    if (!line.trim()) { i++; continue; }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i]) &&
      !LIST_ITEM_RE.test(lines[i]) &&
      !lines[i].trim().startsWith('|')) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }

  return blocks;
}

const BLOCK_TAG_RE = /^(h[1-6]|p|ul|ol|pre|hr|table|div|blockquote|section|article)$/;

export function htmlToMarkdown(root) {
  const blocks = [];

  const wrapInline = (inner, mark) => {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${[...mark].reverse().join('')}${m[3]}` : m[1] + m[3];
  };

  const inlineOf = (node) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const style = (n.getAttribute && n.getAttribute('style')) || '';
      const fontWeight = /font-weight\s*:\s*(bold|[6-9]00)/i.test(style);
      const fontItalic = /font-style\s*:\s*italic/i.test(style);
      if (tag === 'strong' || tag === 'b') s += wrapInline(inlineOf(n), '**');
      else if (tag === 'em' || tag === 'i') s += wrapInline(inlineOf(n), '*');
      else if (tag === 'code') { const code = n.textContent.replace(/ /g, ' '); s += code ? '`' + code + '`' : ''; }
      else if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        const inner = inlineOf(n);
        const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
        s += href && href !== '#' && m[2] ? `${m[1]}[${m[2]}](${href})${m[3]}` : inner;
      }
      else if (tag === 'img') { const src = n.getAttribute('src') || ''; const alt = n.getAttribute('alt') || ''; s += src ? `![${alt}](${src})` : ''; }
      else if (tag === 'br') s += '\n';
      else if (fontWeight || fontItalic) s += wrapInline(inlineOf(n), `${fontWeight ? '**' : ''}${fontItalic ? '*' : ''}`);
      else s += inlineOf(n);
    }
    return s;
  };

  const tableToMarkdown = (table) => {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return '';
    const rowCells = (tr) => [...tr.children].map(c => inlineOf(c).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|'));
    const header = rowCells(rows[0]);
    const bodyRows = rows.slice(1).map(rowCells);
    const sep = header.map(() => '---');
    return [header, sep, ...bodyRows].map(r => `| ${r.join(' | ')} |`).join('\n');
  };

  const listItemText = (li) => {
    const segments = [];
    let run = [];
    const flush = () => { segments.push(inlineOf({ childNodes: run }).trim()); run = []; };
    for (const c of li.childNodes) {
      const tag = c.nodeType === 1 ? c.tagName.toLowerCase() : '';
      if (tag === 'ul' || tag === 'ol') continue;
      if (tag && BLOCK_TAG_RE.test(tag)) { flush(); segments.push(inlineOf(c).trim()); }
      else run.push(c);
    }
    flush();
    return segments.filter(Boolean).join('\n');
  };

  const listToMarkdown = (listEl, depth) => {
    const ordered = listEl.tagName.toLowerCase() === 'ol';
    const lines = [];
    let idx = ordered ? (Number(listEl.getAttribute('start')) || 1) : 1;
    const indent = '  '.repeat(depth);
    for (const li of listEl.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const nested = [...li.children].filter(c => /^(ul|ol)$/i.test(c.tagName));
      const marker = ordered ? `${idx++}. ` : '- ';
      lines.push(indent + marker + listItemText(li).replace(/\n/g, '\n' + indent + '  '));
      for (const sub of nested) lines.push(listToMarkdown(sub, depth + 1));
    }
    return lines.join('\n');
  };

  const walk = (node) => {
    let run = [];
    const flushRun = () => {
      const t = inlineOf({ childNodes: run }).trim();
      if (t) blocks.push(t);
      run = [];
    };
    for (const n of node.childNodes) {
      const tag = n.nodeType === 1 ? n.tagName.toLowerCase() : '';
      if (n.nodeType === 3 || (n.nodeType === 1 && !BLOCK_TAG_RE.test(tag))) { run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      flushRun();
      if (/^h[1-6]$/.test(tag)) {
        const level = Math.min(6, Number(tag[1]));
        const t = inlineOf(n).replace(/\s*\n\s*/g, ' ').trim();
        if (t) blocks.push('#'.repeat(level) + ' ' + t);
      } else if (tag === 'p') {
        const t = inlineOf(n).trim();
        if (t) blocks.push(t);
      } else if (tag === 'ul' || tag === 'ol') {
        const t = listToMarkdown(n, 0);
        if (t.trim()) blocks.push(t);
      } else if (tag === 'pre') {
        blocks.push('```\n' + n.textContent.replace(/ /g, ' ').replace(/\n$/, '') + '\n```');
      } else if (tag === 'hr') {
        blocks.push('---');
      } else if (tag === 'table') {
        const t = tableToMarkdown(n);
        if (t) blocks.push(t);
      } else if (n.querySelector('p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6')) {
        walk(n);
      } else {
        const t = inlineOf(n).trim();
        if (t) blocks.push(t);
      }
    }
    flushRun();
  };

  walk(root);
  return blocks.join('\n\n');
}

const HTML_BLOCK_RE = /<\/?(p|h[1-6]|ul|ol|li|br|div|table|strong|b|em|pre)\b[^>]*>/i;

export function htmlBodyToMarkdown(text) {
  if (!text || !HTML_BLOCK_RE.test(text)) return text;
  return htmlToMarkdown(new DOMParser().parseFromString(text, 'text/html').body);
}

const DEFAULT_REWRITE_FIELDS = ['title', 'summary', 'description', 'resolution'];

export function parseRewriteSections(text, fields = DEFAULT_REWRITE_FIELDS) {
  const source = `^##\\s+(${fields.map(f => f.toUpperCase()).join('|')})\\s*$`;
  const lines = splitLines(text);
  const strict = new RegExp(source);
  const marker = lines.some(l => strict.test(l)) ? strict : new RegExp(source, 'i');
  const out = {};
  const buffers = {};
  for (const f of fields) { out[f] = ''; buffers[f] = []; }
  const seen = new Set();
  let current = null;
  for (const line of lines) {
    const m = line.match(marker);
    const field = m && m[1].toLowerCase();
    if (field && !seen.has(field)) {
      seen.add(field);
      current = field;
      continue;
    }
    if (current) buffers[current].push(line);
  }
  for (const f of fields) out[f] = buffers[f].join('\n').trim();
  return out;
}

export function serializeRewriteSections(sections, fields = DEFAULT_REWRITE_FIELDS) {
  return fields.map(f => `## ${f.toUpperCase()}\n${sections[f] || ''}`).join('\n\n');
}

function renderListBlockToHtml(b) {
  const tag = b.ordered ? 'ol' : 'ul';
  const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
  return `<${tag}${startAttr}>${b.items.map(it => `<li>${it.text.split('\n').map(inlineToHtml).join('<br>')}${it.children.map(renderListBlockToHtml).join('')}</li>`).join('')}</${tag}>`;
}

export function markdownToHtml(md, { headingBase = 2 } = {}) {
  const blocks = parseBlocks(md);
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const level = Math.min(6, headingBase + b.level - 1);
        out.push(`<h${level}>${inlineToHtml(b.text)}</h${level}>`);
        break;
      }
      case 'paragraph':
        out.push(`<p>${b.text.split('\n').map(inlineToHtml).join('<br>')}</p>`);
        break;
      case 'list':
        out.push(renderListBlockToHtml(b));
        break;
      case 'code':
        out.push(`<pre class="ckeditor_codeblock">${escapeHtml(b.code)}</pre>`);
        break;
      case 'table': {
        const head = `<thead><tr>${b.header.map(c => `<th>${inlineToHtml(c)}</th>`).join('')}</tr></thead>`;
        const body = `<tbody>${b.rows.map(r => `<tr>${r.map(c => `<td>${inlineToHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<table border="1">${head}${body}</table>`);
        break;
      }
      case 'hr':
        out.push('<hr>');
        break;
    }
  }
  return out.join('\n');
}
