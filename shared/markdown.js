export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseInline(text) {
  const src = String(text == null ? '' : text);
  const tokens = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
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
      tokens.push({ type: 'link', text: tok.slice(1, split), href: tok.slice(split + 2, -1) });
    }
    last = re.lastIndex;
  }
  if (last < src.length) tokens.push({ type: 'text', text: src.slice(last) });
  if (!tokens.length) tokens.push({ type: 'text', text: '' });
  return tokens;
}

export function inlineToHtml(text) {
  return parseInline(text).map(t => {
    switch (t.type) {
      case 'bold': return `<strong>${escapeHtml(t.text)}</strong>`;
      case 'italic': return `<em>${escapeHtml(t.text)}</em>`;
      case 'code': return `<code>${escapeHtml(t.text)}</code>`;
      case 'link': {
        const safeHref = /^(https?:|mailto:)/i.test(t.href) ? t.href : '#';
        return `<a href="${escapeHtml(safeHref)}">${escapeHtml(t.text)}</a>`;
      }
      default: return escapeHtml(t.text);
    }
  }).join('');
}

export function parseBlocks(md) {
  const lines = String(md == null ? '' : md).split('\n');
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

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length &&
        ((ordered && /^\s*\d+\.\s+/.test(lines[i])) || (!ordered && /^\s*[-*]\s+/.test(lines[i])))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|')) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') });
  }

  return blocks;
}

export function htmlToMarkdown(root) {
  const blocks = [];

  const inlineOf = (node) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      const style = (n.getAttribute && n.getAttribute('style')) || '';
      const fontWeight = /font-weight\s*:\s*(bold|[6-9]00)/i.test(style);
      const fontItalic = /font-style\s*:\s*italic/i.test(style);
      if (tag === 'strong' || tag === 'b') s += `**${inlineOf(n).trim()}**`;
      else if (tag === 'em' || tag === 'i') s += `*${inlineOf(n).trim()}*`;
      else if (tag === 'code') s += '`' + n.textContent.replace(/ /g, ' ') + '`';
      else if (tag === 'a') { const href = n.getAttribute('href') || ''; const txt = inlineOf(n).trim(); s += href && href !== '#' ? `[${txt}](${href})` : txt; }
      else if (tag === 'br') s += '\n';
      else if (fontWeight || fontItalic) { const inner = inlineOf(n).trim(); s += inner ? `${fontWeight ? '**' : ''}${fontItalic ? '*' : ''}${inner}${fontItalic ? '*' : ''}${fontWeight ? '**' : ''}` : ''; }
      else s += inlineOf(n);
    }
    return s;
  };

  const tableToMarkdown = (table) => {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return '';
    const rowCells = (tr) => [...tr.children].map(c => inlineOf(c).trim().replace(/\|/g, '\\|'));
    const header = rowCells(rows[0]);
    const bodyRows = rows.slice(1).map(rowCells);
    const sep = header.map(() => '---');
    return [header, sep, ...bodyRows].map(r => `| ${r.join(' | ')} |`).join('\n');
  };

  const listToMarkdown = (listEl, depth) => {
    const ordered = listEl.tagName.toLowerCase() === 'ol';
    const lines = [];
    let idx = 1;
    const indent = '  '.repeat(depth);
    for (const li of listEl.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      const nested = [...li.children].filter(c => /^(ul|ol)$/i.test(c.tagName));
      const own = { childNodes: [...li.childNodes].filter(c => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName))) };
      const marker = ordered ? `${idx++}. ` : '- ';
      lines.push(indent + marker + inlineOf(own).trim());
      for (const sub of nested) lines.push(listToMarkdown(sub, depth + 1));
    }
    return lines.join('\n');
  };

  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { const t = n.nodeValue.replace(/ /g, ' ').trim(); if (t) blocks.push(t); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
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
      } else if (tag === 'div') {
        if (n.querySelector('p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6')) walk(n);
        else { const t = inlineOf(n).trim(); if (t) blocks.push(t); }
      } else if (tag !== 'br') {
        const t = inlineOf(n).trim();
        if (t) blocks.push(t);
      }
    }
  };

  walk(root);
  return blocks.join('\n\n');
}

const REWRITE_SECTION_MARKER = /^##\s+(TITLE|SUMMARY|DESCRIPTION|RESOLUTION)\s*$/i;

export function parseRewriteSections(text) {
  const out = { title: '', summary: '', description: '', resolution: '' };
  const lines = String(text || '').split('\n');
  let current = null;
  const buffers = { title: [], summary: [], description: [], resolution: [] };
  for (const line of lines) {
    const marker = line.match(REWRITE_SECTION_MARKER);
    if (marker) {
      current = marker[1].toLowerCase();
      continue;
    }
    if (current) buffers[current].push(line);
  }
  out.title = buffers.title.join('\n').trim();
  out.summary = buffers.summary.join('\n').trim();
  out.description = buffers.description.join('\n').trim();
  out.resolution = buffers.resolution.join('\n').trim();
  return out;
}

export function serializeRewriteSections({ title, summary, description, resolution }) {
  return `## TITLE\n${title || ''}\n\n## SUMMARY\n${summary || ''}\n\n## DESCRIPTION\n${description || ''}\n\n## RESOLUTION\n${resolution || ''}`;
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
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${b.items.map(it => `<li>${inlineToHtml(it)}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'code':
        out.push(`<pre><code>${escapeHtml(b.code)}</code></pre>`);
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
