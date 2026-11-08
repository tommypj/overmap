// Shared helpers: tiny YAML frontmatter codec (covers the subset used in the vault)
// and the dated-blocker list format used in each project note's "## Blockers" section.
import { readFileSync } from 'node:fs';

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^".*"$/.test(s)) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((v) => scalar(v)) : [];
  }
  return s;
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text, raw: '' };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && key) { (data[key] ||= []).push(scalar(li[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    data[key] = kv[2].trim() === '' ? [] : scalar(kv[2]);
  }
  return { data, body: text.slice(m[0].length), raw: m[0] };
}

function fmtScalar(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return /\p{Cc}/u.test(s) || /[:#\[\]{}'"\\]|^\s|\s$|^$/.test(s) || /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) ? JSON.stringify(s) : s;
}

export function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else { lines.push(`${k}:`); for (const item of v) lines.push(`  - ${fmtScalar(item)}`); }
    } else lines.push(`${k}: ${fmtScalar(v)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// Blockers live in a "## Blockers" section as "- [ ] YYYY-MM-DD — text". Checked items are resolved.
export function parseBlockers(body) {
  const sec = body.match(/^## Blockers\s*\r?\n([\s\S]*?)(?=^## |\Z(?![\s\S]))/m) ?? body.match(/^## Blockers\s*\r?\n([\s\S]*)$/m);
  if (!sec) return [];
  const out = [];
  for (const line of sec[1].split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(?:(\d{4}-\d{2}-\d{2})\s*[—–-]\s*)?(.+)$/);
    if (m) out.push({ done: m[1] !== ' ', since: m[2] ?? null, text: m[3].trim() });
  }
  return out;
}

export function replaceSection(body, heading, content) {
  const re = new RegExp(`^## ${heading}\\s*\\r?\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm');
  const block = `## ${heading}\n${content.trimEnd()}\n\n`;
  return re.test(body) ? body.replace(re, block) : body.trimEnd() + '\n\n' + block;
}

export function readNote(file) {
  return parseFrontmatter(readFileSync(file, 'utf8'));
}
