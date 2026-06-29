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

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
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
      !/^```/.test(lines[i]) &&
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
