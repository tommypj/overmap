// Master plan reader: PLAN.md in the project home.
// "# " title, "## " milestone, "### " sprint, "- [ ] [~] [!] [x]" items (any indent = leaf items).
// "(due YYYY-MM-DD)" in headings, "#bug #idea #test" tags and "@owner" in items.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { plainTitle } from './checkbox-docs.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const FILE = 'PLAN.md';
const IDEA_TITLE = /^(ideas|backlog|improvements)$/i;
const STATES = { ' ': 'planned', '~': 'in_progress', '!': 'blocked', x: 'done', X: 'done' };
const percentOf = (done, total) => (total === 0 ? 0 : Math.round((done / total) * 100));

function detect(home) {
  return existsSync(join(home, FILE));
}

function splitDue(text) {
  const m = text.match(/\(due:?\s*(\d{4}-\d{2}-\d{2})\)/i);
  const title = text.replace(/\(due:?\s*\d{4}-\d{2}-\d{2}\)/i, ' ');
  return { title: plainTitle(title), due: m ? m[1] : null };
}

function parseItem(text, sprintTitle, milestoneTitle) {
  let kind = null;
  let rest = ` ${text}`.replace(/\s#(bug|idea|test)\b/gi, (_, k) => { kind ??= k.toLowerCase(); return ' '; });
  let owner = null;
  rest = rest.replace(/\s@([\w.-]+)\b/, (_, o) => { owner = o; return ' '; });
  kind ??= [sprintTitle, milestoneTitle].some((t) => IDEA_TITLE.test(t)) ? 'idea' : 'task';
  return { title: plainTitle(rest), kind, owner };
}

async function read(home) {
  const file = join(home, FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = parseFrontmatter(text).body.split(/\r?\n/);
  let title = null;
  const milestones = [];
  let ms = null;
  let sp = null;
  let fence = false;
  const startMilestone = (id, t, due) => { ms = { id, title: t, due, percent: 0, sprints: [] }; milestones.push(ms); sp = null; };
  const startSprint = (t, due, id) => { sp = { id, title: t, due, percent: 0, items: [] }; ms.sprints.push(sp); };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h1 = line.match(/^# (.+)$/);
    if (h1 && title === null) { title = plainTitle(h1[1]); continue; }
    const h = line.match(/^(##|###) (.+)$/);
    if (h) {
      const { title: t, due } = splitDue(h[2]);
      if (h[1] === '##') startMilestone(`${FILE}#${milestones.filter((m) => m.id.startsWith(`${FILE}#`)).length + 1}`, t, due);
      else {
        if (!ms) startMilestone('plan#0', title ?? 'Plan', null);
        startSprint(t, due, `${ms.id}.${ms.sprints.filter((s) => !s.id.endsWith('#0')).length + 1}`);
      }
      continue;
    }
    const m = line.match(/^\s*-\s*\[( |~|!|x|X)\]\s*(.+)$/);
    if (!m) continue;
    if (!ms) startMilestone('plan#0', title ?? 'Plan', null);
    if (!sp) startSprint(ms.title, null, `${ms.id}#0`);
    const it = parseItem(m[2].trim(), sp.title, ms.title);
    sp.items.push({ id: `${sp.id}.${sp.items.length + 1}`, title: it.title, state: STATES[m[1]], kind: it.kind, owner: it.owner });
  }
  let done = 0, total = 0;
  for (const mi of milestones) {
    let d = 0, t = 0;
    for (const s of mi.sprints) {
      // ideas are a backlog, not commitments: they never count toward done / total
      const counted = s.items.filter((i) => i.kind !== 'idea');
      const sd = counted.filter((i) => i.state === 'done').length;
      s.percent = percentOf(sd, counted.length);
      d += sd; t += counted.length;
    }
    mi.percent = percentOf(d, t);
    done += d; total += t;
  }
  return { source: 'master-plan', updatedAt: new Date(statSync(file).mtimeMs).toISOString(), percent: percentOf(done, total), milestones };
}

export default { id: 'master-plan', detect, read };
