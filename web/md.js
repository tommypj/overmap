// Small, safe markdown renderer. All input is HTML-escaped first; only http(s) and relative URLs survive.
// No DOM access: importable from Node tests.

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Returns { kind: 'abs'|'rel', url } or null. Input is the RAW (unescaped) url.
function classifyUrl(raw) {
  const u = raw.trim();
  if (!u || /[\u0000-\u001f\s]/.test(u.replace(/%20/g, ''))) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return /^https?:\/\//i.test(u) ? { kind: 'abs', url: u } : null;
  if (u.startsWith('//') || u.startsWith(String.fromCharCode(92))) return null;
  return { kind: 'rel', url: u };
}

function inline(src, opts) {
  const stash = [];
  const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let s = String(src);
  // code spans first (content escaped, not further processed)
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${escapeHtml(code.trim())}</code>`));
  // images and links work on raw text, then everything left is escaped
  const link = (re, build) => { s = s.replace(re, (...m) => keep(build(...m))); };
  link(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
    const c = classifyUrl(url);
    if (!c) return escapeHtml(alt);
    if (c.kind === 'abs') return `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || c.url)}</a>`;
    const src2 = opts.resolveRel ? opts.resolveRel(c.url) : c.url;
    return `<img src="${escapeHtml(src2)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  });
  link(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => {
    const c = classifyUrl(url);
    const label = emphasis(escapeHtml(text));
    if (!c) return label;
    const href = c.kind === 'rel' && opts.resolveRel ? opts.resolveRel(c.url) : c.url;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = emphasis(escapeHtml(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function emphasis(s) {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};
const isSep = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(text, opts = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const cls = fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2], opts)}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const al = (k) => (aligns[k] ? ` class="al-${aligns[k]}"` : '');
      out.push('<table><thead><tr>' + head.map((c, k) => `<th${al(k)}>${inline(c, opts)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? '', opts)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(q.join('\n'), opts)}</blockquote>`);
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tasks = items.some((t) => /^\[[ xX]\]\s/.test(t));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${tasks ? ' class="tasks"' : ''}>` + items.map((t) => {
        const tm = t.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) return `<li><input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> ${inline(tm[2], opts)}</li>`;
        return `<li>${inline(t, opts)}</li>`;
      }).join('') + `</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST_RE.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isSep(lines[i + 1]))) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    out.push(`<p>${inline(para.join('\n'), opts).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}
