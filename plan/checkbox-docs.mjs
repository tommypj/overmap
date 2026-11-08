// Stop-gap plan reader: counts "- [ ]" / "- [x]" lines in docs/superpowers/plans/*.md (or docs/plans/*.md).
// One milestone per file, one sprint per "## " / "### " heading below the title.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PLAN_DIRS = ['docs/superpowers/plans', 'docs/plans'];

const percentOf = (done, total) => (total === 0 ? 0 : Math.round((done / total) * 100));

export function planFiles(home) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  };
  for (const d of PLAN_DIRS) walk(join(home, d));
  return out;
}

function detect(home) {
  return planFiles(home).length > 0;
}

function itemKind(text, rel) {
  if (/(^|\/)(ideas|backlog)(\/|$)/i.test(rel)) return 'idea';
  if (/bug|fix/i.test(text)) return 'bug';
  return 'task';
}

// Titles come from markdown; strip inline markup here so every consumer shows plain text.
export function plainTitle(t) {
  const code = [];
  let s = String(t).replace(/`(.+?)`/g, (_, c) => { code.push(c); return `\u0000${code.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/\*(.+?)\*/g, '$1')
    .replace(/\s+/g, ' ').trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

function parseFile(home, file) {
  const rel = relative(home, file).replaceAll('\\', '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let title = null;
  const sprints = [];
  let cur = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h1 = line.match(/^# (.+)$/);
    if (h1 && title === null) { title = plainTitle(h1[1]); continue; }
    const h = line.match(/^#{2,3} (.+)$/);
    if (h) { cur = { id: `${rel}#${sprints.length + 1}`, title: plainTitle(h[1]), percent: 0, items: [] }; sprints.push(cur); continue; }
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/);
    if (m) {
      if (!cur) { cur = { id: `${rel}#0`, title: title ?? rel, percent: 0, items: [] }; sprints.push(cur); }
      const text = m[2].trim();
      cur.items.push({ id: `${cur.id}.${cur.items.length + 1}`, title: plainTitle(text), state: m[1] === ' ' ? 'planned' : 'done', kind: itemKind(text, rel) });
    }
  }
  let done = 0, total = 0;
  for (const s of sprints) {
    const d = s.items.filter((i) => i.state === 'done').length;
    s.percent = percentOf(d, s.items.length);
    done += d; total += s.items.length;
  }
  return { milestone: { id: rel, title: title ?? rel, due: null, percent: percentOf(done, total), sprints }, done, total };
}

async function read(home) {
  const files = planFiles(home);
  if (files.length === 0) return null;
  const milestones = [];
  let done = 0, total = 0, newest = 0;
  for (const f of files) {
    const r = parseFile(home, f);
    milestones.push(r.milestone);
    done += r.done; total += r.total;
    newest = Math.max(newest, statSync(f).mtimeMs);
  }
  return { source: 'checkbox-docs', updatedAt: new Date(newest).toISOString(), percent: percentOf(done, total), milestones };
}

export default { id: 'checkbox-docs', detect, read };
