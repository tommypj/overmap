import { deployNode } from './live.js';
import { nowNext, testsModel, deployModel, bugsModel, ideasModel } from '../devmodel.js';
import { branchText, h, api, enc, pill, unknownPill, section, bytes, ago, num, winPath, baseName, emptyNote, errorNote, factNote } from '../ui.js';

const SKELETON = ['PROJECT.md', 'docs', 'assets', 'outputs', 'exports', 'ops'];

function pct(n) { return n == null ? 'unknown' : `${n}%`; }

function bar(percent) {
  if (percent == null) return h('span', { class: 'barwrap' }, h('span', { class: 'pct' }, 'unknown'));
  const b = h('progress', { class: 'bar', max: '100', value: String(percent) });
  return h('span', { class: 'barwrap' }, b, h('span', { class: 'pct' }, pct(percent)));
}

const GLYPHS = { planned: '☐', in_progress: '◐', blocked: '⊘', done: '☑' };
const glyph = (state) => h('span', { class: `glyph ${state in GLYPHS ? state : 'planned'}` }, GLYPHS[state] ?? GLYPHS.planned);
const safeHref = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

function nowNextBlocks(plan) {
  const nn = nowNext(plan);
  if (!nn.supported) return [h('p', { class: 'muted' }, 'Now / Next and plan bugs need a PLAN.md.')];
  const group = (title, items, g, cls) => (items.length ? h('div', { class: 'nngroup' },
    h('div', { class: 'k' }, title, ' ', cls ? pill(String(items.length), cls) : null),
    h('ul', { class: 'plain' }, ...items.map((it) => h('li', null, glyph(g), ' ', it.title,
      h('span', { class: 'age' }, ` · ${it.where}`), it.owner ? h('span', { class: 'age' }, ` @${it.owner}`) : null)))) : null);
  return [group('Now', nn.now, 'in_progress'), group('Blocked', nn.blocked, 'blocked', 'risk'), group('Next', nn.next, 'planned')];
}

function planBlock(p) {
  const f = p.plan;
  const body = [];
  if (!f || f.error) body.push(errorNote(f?.error || 'not scanned'));
  else if (f.value === null) body.push(h('p', { class: 'muted' }, 'No plan found. Use a PLAN.md master plan (milestones as headings, items as checkboxes) or checkbox plans under docs/superpowers/plans.'));
  else {
    const plan = f.value;
    const srcFile = plan.source === 'master-plan' ? 'PLAN.md' : (plan.source === 'checkbox-docs' ? 'docs/superpowers/plans' : null);
    body.push(h('p', { class: 'muted' }, `Source: ${plan.source ?? 'unknown'}${srcFile ? ` (${srcFile})` : ''} · plan files updated ${plan.updatedAt ? ago(plan.updatedAt) : 'unknown'}`));
    body.push(...nowNextBlocks(plan));
    body.push(h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Overall'), bar(plan.percent)));
    for (const m of plan.milestones || []) {
      const d = h('details', { class: 'ms' },
        h('summary', null, h('span', { class: 'mtitle' }, m.title), m.due ? pill(`due ${m.due}`) : null, bar(m.percent)));
      for (const s of m.sprints || []) {
        const sd = h('details', { class: 'sprint' }, h('summary', null, h('span', null, s.title), bar(s.percent), h('span', { class: 'age' }, `${(s.items || []).length} items`)));
        let filled = false;
        sd.addEventListener('toggle', () => {
          if (!sd.open || filled) return;
          filled = true;
          const ul = h('ul', { class: 'items' });
          for (const it of s.items || []) {
            const st = it.state in GLYPHS ? it.state : (['done', 'checked', 'complete', 'completed'].includes(String(it.state).toLowerCase()) ? 'done' : 'planned');
            ul.append(h('li', { class: st === 'done' ? 'done' : '' }, glyph(st), ' ', it.title,
              it.kind && it.kind !== 'task' ? h('span', { class: 'age' }, ` ${it.kind}`) : null, it.owner ? h('span', { class: 'age' }, ` @${it.owner}`) : null));
          }
          sd.append((s.items || []).length ? ul : emptyNote('No checkbox items in this section.'));
        });
        d.append(sd);
      }
      body.push(d);
    }
  }
  return section('Plan', f, ...body);
}

function worktreeRow(w) {
  const bits = [];
  if (w.error) return h('li', null, h('span', { class: 'mono' }, winPath(w.path)), ' ', unknownPill(w.error));
  bits.push(w.branch ?? 'unknown');
  bits.push(`${num(w.modified)} modified`, `${num(w.untracked)} untracked`);
  return h('li', null, h('span', { class: 'mono' }, winPath(w.path)), ' ', pill(bits.join(' · '), w.modified || w.untracked ? 'warn' : ''), w.prunable ? pill('prunable', 'warn') : null);
}

function repoBlock(r) {
  const f = r.git;
  const box = h('div', { class: 'repo' }, h('div', { class: 'repohead' }, h('strong', null, baseName(r.path)), h('span', { class: 'mono muted' }, ' ' + winPath(r.path)), factNote(f)));
  if (!f || f.error || !f.value) { box.append(errorNote(f?.error || 'not scanned')); return box; }
  const v = f.value;
  const noRemote = Array.isArray(v.remotes) && v.remotes.length === 0;
  box.append(h('div', { class: 'row' },
    pill(branchText(v), v.branch == null && !v.head ? 'unknown' : ''), pill(`head ${String(v.head ?? '').slice(0, 7) || 'unknown'}`),
    pill(`${num(v.modified)} modified`, v.modified ? 'warn' : ''), pill(`${num(v.untracked)} untracked`, v.untracked ? 'warn' : ''),
    pill(v.stashes == null ? 'stashes unknown' : `${v.stashes} stashes`),
    pill(v.localOnlyCommits == null ? 'unpushed unknown' : `${v.localOnlyCommits} unpushed`, v.localOnlyCommits ? 'warn' : (v.localOnlyCommits == null ? 'unknown' : '')),
    pill(v.defaultBehind == null ? `behind ${v.defaultBranch ?? 'default'}: unknown` : `${v.defaultBehind} behind ${v.defaultBranch ?? 'default'}`),
    v.remotes == null ? h('span', { class: 'muted' }, 'remotes unknown') : (noRemote ? pill('no remote', 'risk') : pill(v.remotes.join(', ')))));
  box.append(h('p', { class: 'muted' }, `Last commit ${v.lastDate ? ago(v.lastDate) : 'unknown'}: ${v.lastSubject ?? 'unknown'}`));
  if (v.isWorktree) box.append(h('p', { class: 'muted' }, 'This path is itself a worktree of ', h('span', { class: 'mono' }, winPath(v.mainRepo ?? 'unknown'))));
  if ((v.localOnlyBranches || []).length) box.append(h('p', null, 'Branches not on a remote: ', ...v.localOnlyBranches.map((b) => pill(`${b.name} (${num(b.commits)})`, 'warn'))));
  const wts = v.worktrees || [];
  if (wts.length) box.append(h('div', { class: 'wts' }, h('div', { class: 'k' }, `${wts.length} worktree${wts.length > 1 ? 's' : ''}`), h('ul', { class: 'plain' }, ...wts.map(worktreeRow))));
  return box;
}

function reposBlock(p) {
  const repos = p.repos || [];
  const ages = repos.map((r) => r.git?.at).filter(Boolean).sort();
  return section('Repos and worktrees', ages.length ? { at: ages[0] } : undefined,
    repos.length ? repos.map(repoBlock) : emptyNote('No git repository found for this project.'));
}

function genericItem(it) {
  const parts = Object.entries(it).filter(([k, v]) => k !== 'name' && k !== 'actions' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')).map(([k, v]) => `${k}: ${v}`);
  return h('li', null, h('strong', null, it.name ?? 'unnamed'), parts.length ? h('span', { class: 'muted' }, ' · ' + parts.join(' · ')) : null);
}

async function structureBlock(p) {
  const rootsList = p.roots || [];
  const homeIdx = Math.max(0, rootsList.findIndex((r) => r === p.home));
  const skel = h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Folder skeleton'), h('span', { class: 'rowbody' }, 'Loading...'));
  const sec = section('Structure', undefined,
    h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Home'), h('span', { class: 'rowbody mono' }, p.home ? winPath(p.home) : 'unknown')),
    h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Roots'), h('span', { class: 'rowbody' }, h('ul', { class: 'plain mono' }, ...(rootsList.length ? rootsList.map((r, i) => h('li', null, `${i}  ${winPath(r)}`)) : [h('li', null, 'unknown')])))),
    skel,
    h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Size'), h('span', { class: 'rowbody' }, p.size ? `code ${bytes(p.size.code)} · deps ${bytes(p.size.deps)}` : unknownPill('size not measured'))));
  const r = await api(`api/ls?id=${enc(p.id)}&root=${homeIdx}&path=`);
  const cell = skel.querySelector('.rowbody');
  cell.replaceChildren();
  if (r.error) cell.append(unknownPill(r.error));
  else {
    const have = new Set(r.data.entries.map((e) => e.name.toLowerCase()));
    for (const s of SKELETON) cell.append(pill(have.has(s.toLowerCase()) ? `${s} present` : `${s} missing`, have.has(s.toLowerCase()) ? '' : 'warn'));
    if (r.data.truncated) cell.append(h('span', { class: 'age' }, 'listing truncated'));
  }
  return sec;
}

function blockersBlock(p) {
  const list = p.blockers || [];
  return section('Blockers', undefined, list.length
    ? h('ul', { class: 'plain' }, ...list.map((b) => h('li', { class: b.done ? 'done' : '' }, h('span', { class: 'since' }, b.since ?? 'undated'), ' ', b.text)))
    : emptyNote('No blockers recorded in the vault note.'));
}

// ---- connector-backed tiles --------------------------------------------------
const tile = (sec) => { sec.classList.add('tile'); return sec; };
const dd = (label, node) => [h('dt', null, label), h('dd', null, node)];
const unk = () => h('span', { class: 'unk' }, 'unknown');
const countNode = (n) => (n == null ? unk() : String(n));

function stateNote(m, run, connError) {
  if (m.state === 'not_configured') {
    const names = (run?.missing || []).map((x) => h('code', null, x));
    return h('p', { class: 'note warn' }, 'Not connected. Missing: ', names.length ? names.flatMap((n, i) => (i ? [', ', n] : [n])) : 'unknown');
  }
  if (m.state === 'error') return h('p', { class: 'note risk' }, `unknown (${run?.error ?? 'no detail'})`);
  if (m.state === 'never') {
    if (run) return h('p', { class: 'muted' }, 'Never ran yet.');
    if (connError) return h('p', { class: 'note risk' }, `unknown (${connError})`);
    return h('p', { class: 'note warn' }, 'Not connected. No connector configured for this project.');
  }
  return null;
}

function eventList(list) {
  return h('ul', { class: 'feedlist' }, list.map((e) => {
    const href = safeHref(e.url);
    const t = e.title || e.kind;
    return h('li', { class: 'feedrow' }, h('span', { class: 'age feedtime', title: e.at }, ago(e.at)), href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t) : t);
  }));
}

function itemList(items) {
  return h('ul', { class: 'plain' }, ...items.map((it) => h('li', null, glyph(it.state), ' ', it.title, h('span', { class: 'age' }, ` · ${it.where}`))));
}

function testsTile(p) {
  const m = testsModel(p.tests, []);
  let fileNode;
  if (m.file) {
    const f = m.file;
    const bits = [`${num(f.passed)} passed`, `${num(f.failed)} failed`, ago(f.at)];
    if (f.durationMs != null) bits.push(`${(f.durationMs / 1000).toFixed(1)} s`);
    fileNode = h('span', null, bits.join(' · '), f.command ? h('div', { class: 'mono muted clip' }, f.command) : null);
  } else if (m.fileError) fileNode = h('span', { class: 'note risk' }, m.fileError);
  else fileNode = h('span', { class: 'muted' }, 'no test-results.json in any root');
  const sec = section('Tests', undefined,
    h('dl', { class: 'facts' }, ...dd('Last file result', fileNode)),
    h('p', { class: 'muted small' }, 'To show results here, write test-results.json in the project after a test run.'));
  sec.querySelector('h3').append(pill(m.verdict, { pass: 'ok', fail: 'risk', running: 'ok', unknown: 'unknown' }[m.verdict]));
  return tile(sec);
}

function deployTile(factsRes, runs, connError) {
  if (factsRes.error) return tile(section('Deployments', undefined, errorNote(factsRes.error)));
  const run = runs.get('vercel');
  const m = deployModel(factsRes.data || {}, run);
  const body = [];
  const note = stateNote(m, run, connError);
  if (note) body.push(note);
  if (m.production || m.preview || m.failed24h != null) {
    body.push(h('dl', { class: 'facts' + (m.state === 'error' ? ' grey' : '') },
      ...dd('Production', deployNode(m.production)), ...dd('Preview', deployNode(m.preview)), ...dd('Failed (24 h)', countNode(m.failed24h))));
  }
  body.push(h('p', { class: 'muted small' }, 'Connect a deployments connector (Vercel is included) to see deployments here.'));
  return tile(section('Deployments', undefined, ...body));
}

function bugsTile(p, factsRes, runs, eventsRes, connError) {
  if (factsRes.error) return tile(section('Bugs', undefined, errorNote(factsRes.error)));
  const run = runs.get('sentry');
  const m = bugsModel(factsRes.data || {}, run, eventsRes.data || [], p.plan?.value);
  const body = [];
  const note = stateNote(m, run, connError);
  if (note) body.push(note);
  if (m.source === 'sentry') {
    body.push(h('dl', { class: 'facts' + (m.state === 'error' ? ' grey' : '') }, ...dd('Unresolved', countNode(m.unresolved)), ...dd('Events today', countNode(m.eventsToday))));
    if (m.truncated === true) body.push(h('p', { class: 'note warn' }, 'truncated: Sentry hit its page limit, so the real count is at least this.'));
    if (eventsRes.error) body.push(errorNote(eventsRes.error));
    else body.push(m.list.length ? eventList(m.list) : emptyNote('No error events recorded.'));
  } else if (m.source === 'plan') {
    body.push(h('p', { class: 'muted' }, (m.state === 'not_configured' || !run) ? 'From the plan (Sentry not configured)' : 'From the plan (no Sentry data)'), itemList(m.list));
  } else body.push(emptyNote(p.plan?.value && p.plan.value.source !== 'master-plan' ? 'No Sentry for this project; plan bugs need a PLAN.md.' : 'No Sentry for this project and no #bug items in the plan.'));
  const count = m.source === 'sentry' ? m.unresolved : (m.source === 'plan' ? m.list.length : null);
  const sec = section('Bugs', undefined, ...body);
  if (count != null) sec.querySelector('h3').append(pill(String(count), count > 0 ? 'risk' : ''));
  return tile(sec);
}

function ideasTile(p) {
  const f = p.plan;
  if (!f || f.error) return tile(section('Ideas', undefined, errorNote(f?.error || 'not scanned')));
  const m = ideasModel(f.value);
  const body = m.count
    ? m.groups.map((g) => h('div', { class: 'nngroup' }, h('div', { class: 'k' }, g.milestone), itemList(g.items)))
    : [emptyNote('No ideas yet. Tag a plan item #idea, or put it in a sprint called Ideas.')];
  const sec = section('Ideas', undefined, ...body);
  sec.querySelector('h3').append(pill(String(m.count)));
  return tile(sec);
}

export async function renderDev(el, { p }) {
  const id = enc(p.id);
  const [factsRes, conns, cfgRes, eventsRes] = await Promise.all([
    api(`api/facts?id=${id}`), api('api/connectors'), api(`api/connectors/config?id=${id}`),
    api(`api/events?id=${id}&kinds=error,approval,run_finished&limit=50`),
  ]);
  const runs = new Map();
  for (const cn of conns.data || []) {
    const mine = (cn.projects || []).find((x) => x.project === p.id);
    if (mine) runs.set(cn.id, mine);
  }
  el.append(planBlock(p),
    h('div', { class: 'tiles devtiles' }, testsTile(p), deployTile(factsRes, runs, conns.error), bugsTile(p, factsRes, runs, eventsRes, conns.error), ideasTile(p)),
    reposBlock(p));
  el.append(await structureBlock(p), blockersBlock(p));
}
