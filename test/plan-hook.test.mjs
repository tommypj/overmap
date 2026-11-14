import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { loadRegistry } from '../registry.mjs';
import { norm } from '../lib/paths.mjs';
import { decide, main, parsePorcelain } from '../hooks/plan-check.mjs';

const H = 3600000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const dir = mkdtempSync(join(tmpdir(), 'planhook-'));
const regFile = join(dir, 'registry.json');
writeFileSync(regFile, JSON.stringify({ projects: {
  a: { name: 'Alpha', home: '/zz/a', repos: ['/zz/a'], worktreesManaged: ['/zz/a-wt'] },
  b: { name: 'Beta', home: '/zz/b', repos: [] },
} }));
const registry = loadRegistry(regFile);

// canned git: dirty = porcelain output, commitAgoMs = age of newest commit (null = no commits)
// args[0] is always --no-optional-locks; planCommitAgoMs answers the `log ... -- PLAN.md ...` call
const mkGit = ({ dirty = false, commitAgoMs = 99 * H, planCommitAgoMs = null } = {}) => (args) => {
  if (args[0] !== '--no-optional-locks') return null;
  if (args[1] === 'status') return dirty ? ' M file.js\n' : '';
  if (args[1] === 'log' && args.includes('--')) return planCommitAgoMs === null ? '' : `${Math.floor((NOW - planCommitAgoMs) / 1000)}\n`;
  if (args[1] === 'log') return commitAgoMs === null ? '' : `${Math.floor((NOW - commitAgoMs) / 1000)}\n`;
  return null;
};
const run = (cwd, o = {}) => decide(
  { cwd, stop_hook_active: o.active ?? false },
  { registry, now: () => NOW, planMtime: () => ('planAgo' in o ? (o.planAgo === null ? null : NOW - o.planAgo) : NOW - 99 * H), git: o.git ?? mkGit(o.g), mtime: () => NOW - (o.fileAgo ?? H), clock: o.clock },
);

test('stop_hook_active allows even with dirty git and no plan', () => {
  assert.deepEqual(run('/zz/a', { active: true, planAgo: null, g: { dirty: true } }), {});
});

test('cwd outside every root allows', () => {
  for (const c of ['/u/someone', '/', '/other', '/zz/ab']) assert.deepEqual(run(c, { g: { dirty: true } }), {});
});

test('deep cwd resolves to its project; worktree resolves to its entry', () => {
  const r = run('/zz/a/src/deep/er', { g: { dirty: true }, planAgo: 5 * H });
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.startsWith('This session changed Alpha'));
  const w = run('/zz/a-wt', { g: { dirty: true }, planAgo: 5 * H });
  assert.ok(w.reason.startsWith('This session changed Alpha'));
});

test('clean repo with old commit allows', () => {
  assert.deepEqual(run('/zz/a', { g: { dirty: false, commitAgoMs: 10 * H }, planAgo: 50 * H }), {});
});

test('modified file 1 h ago: fresh plan allows, 5 h old plan blocks with hours and PLAN.md', () => {
  assert.deepEqual(run('/zz/a', { g: { dirty: true }, planAgo: 10 * 60000 }), {});
  const r = run('/zz/a', { g: { dirty: true }, planAgo: 5 * H });
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.includes('5 h ago'));
  assert.ok(r.reason.includes('PLAN.md'));
  assert.ok(r.reason.includes('Format: docs/hook.md in Overmap, section "PLAN.md".'));
});

test('recent commit: plan older than the commit by more than the grace blocks, newer allows', () => {
  assert.equal(run('/zz/a', { g: { commitAgoMs: 1 * H }, planAgo: 3 * H }).decision, 'block');
  assert.deepEqual(run('/zz/a', { g: { commitAgoMs: 1 * H }, planAgo: 30 * 60000 }), {});
});

test('plan edited 60 s ago, committed 30 s ago, clean tree allows', () => {
  assert.deepEqual(run('/zz/a', { g: { dirty: false, commitAgoMs: 30000 }, planAgo: 60000 }), {});
});

test('plan edited 2 h ago, commit 1 h ago blocks (outside the grace)', () => {
  const r = run('/zz/a', { g: { dirty: false, commitAgoMs: 1 * H }, planAgo: 2 * H });
  assert.equal(r.decision, 'block');
});

test('plan committed after its file mtime (file untouched since) allows', () => {
  assert.deepEqual(run('/zz/a', { g: { commitAgoMs: 10 * 60000, planCommitAgoMs: 5 * 60000 }, planAgo: 3 * H }), {});
});

test('the stale reason names the real plan file, relative to the home', () => {
  const planFile = () => '/zz/a/docs/superpowers/plans/2026-11-03-x.md';
  const r = decide({ cwd: '/zz/a' }, { registry, now: () => NOW, planMtime: () => NOW - 5 * H, planFile, git: mkGit({ dirty: true }), mtime: () => NOW - H });
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.includes('(docs/superpowers/plans/2026-11-03-x.md, last changed 5 h ago)'));
  const none = run('/zz/a', { g: { dirty: true }, planAgo: 5 * H });
  assert.ok(none.reason.includes('(PLAN.md, last changed'));
});

test('worktree plan newer than the home plan allows (real worktree root with a .git file)', () => {
  const wt = join(dir, 'wt');
  mkdirSync(wt);
  writeFileSync(join(wt, '.git'), 'gitdir: elsewhere');
  const wtFile = join(dir, 'registry-wt.json');
  writeFileSync(wtFile, JSON.stringify({ projects: { w: { name: 'Wolf', home: '/zz/w', repos: ['/zz/w'], worktreesManaged: [wt] } } }));
  const reg = loadRegistry(wtFile);
  const planMtime = (h) => (norm(h) === norm(wt) ? NOW - 60000 : NOW - 20 * H);
  const base = { registry: reg, now: () => NOW, planMtime, git: mkGit({ dirty: true }), mtime: () => NOW - H };
  assert.deepEqual(decide({ cwd: wt }, base), {});
  // control: without the worktree's own newer plan the same session blocks
  assert.equal(decide({ cwd: wt }, { ...base, planMtime: () => NOW - 20 * H }).decision, 'block');
});

test('no plan file blocks with the no-plan reason naming the home', () => {
  const r = run('/zz/a', { g: { dirty: true }, planAgo: null });
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'Alpha has no plan file. Create PLAN.md in /zz/a (format: docs/hook.md in Overmap, section "PLAN.md") or a checkbox plan under docs/superpowers/plans/, then stop again.');
});

test('no repos to inspect allows', () => {
  assert.deepEqual(run('/zz/b', { g: { dirty: true }, planAgo: null }), {});
});

test('git null or throwing allows', () => {
  assert.deepEqual(run('/zz/a', { git: () => null, planAgo: null }), {});
  assert.deepEqual(run('/zz/a', { git: () => { throw new Error('boom'); }, planAgo: null }), {});
});

test('old WIP (file modified 3 days ago) is not this session: allows', () => {
  assert.deepEqual(run('/zz/a', { g: { dirty: true }, fileAgo: 72 * H, planAgo: 5 * H }), {});
});

test('status is queried without untracked files', () => {
  const seen = [];
  const git = (args, cwd) => { seen.push(args); return mkGit({ dirty: false, commitAgoMs: H })(args, cwd); };
  assert.deepEqual(run('/zz/a', { git, planAgo: 10 * 60000 }), {});
  assert.ok(seen.some((a) => a[1] === 'status' && a.includes('--untracked-files=no')));
  assert.ok(seen.length > 0 && seen.every((a) => a[0] === '--no-optional-locks'));
  assert.ok(seen.some((a) => a[1] === 'log' && a.includes('--')));
});

test('rename and quoted paths are parsed to the new path', () => {
  const NL = String.fromCharCode(10);
  assert.deepEqual(parsePorcelain(['R  old.js -> new.js', ' M "sp ace.js"', ''].join(NL)), ['new.js', 'sp ace.js']);
});

test('plan under 1 h old is reported as under 1 h ago', () => {
  const r = run('/zz/a', { g: { commitAgoMs: 10 * 60000 }, planAgo: 45 * 60000, fileAgo: 1 });
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.includes('under 1 h ago'));
});

test('out of time budget mid-loop (after a clean first repo) allows', () => {
  const reg2 = new Map(registry);
  reg2.set('c', { ...registry.get('a'), id: 'c', home: '/zz/c', repos: ['/zz/c1', '/zz/c2'], worktreesManaged: [] });
  let ticks = 0;
  // start + c1's two checks read 0; every later check reads 5000 (budget gone)
  const clock = () => (ticks++ < 3 ? 0 : 5000);
  const git = (args, cwd) => (cwd === '/zz/c1' ? mkGit()(args) : mkGit({ dirty: true })(args));
  const r = decide({ cwd: '/zz/c' }, { registry: reg2, now: () => NOW, planMtime: () => NOW - 5 * H, git, mtime: () => NOW - H, clock });
  assert.deepEqual(r, {});
  // control: with ample time the same setup blocks
  const ok = decide({ cwd: '/zz/c' }, { registry: reg2, now: () => NOW, planMtime: () => NOW - 5 * H, git, mtime: () => NOW - H, clock: () => 0 });
  assert.equal(ok.decision, 'block');
});

test('unregistered worktree whose common dir is a registered repo is inspected', () => {
  const calls = [];
  const git = (args, cwd) => {
    calls.push([args, cwd]);
    if (args[1] === 'rev-parse' && args.includes('--git-common-dir')) return '/zz/a/.git\n';
    if (args[1] === 'rev-parse' && args.includes('--show-toplevel')) return '/elsewhere/a-feature\n';
    return mkGit({ dirty: true })(args);
  };
  const base = { registry, now: () => NOW, git, mtime: () => NOW - H };
  const r = decide({ cwd: '/elsewhere/a-feature/src' }, { ...base, planMtime: () => NOW - 5 * H });
  assert.equal(r.decision, 'block');
  assert.ok(r.reason.startsWith('This session changed Alpha'));
  assert.ok(calls.every(([a]) => a[0] === '--no-optional-locks'));
  assert.ok(calls.some(([a, c]) => a[1] === 'status' && c === '/elsewhere/a-feature'));
  // the worktree's own fresh PLAN.md counts
  const pm = (h) => (norm(h) === '/elsewhere/a-feature' ? NOW - 60000 : NOW - 5 * H);
  assert.deepEqual(decide({ cwd: '/elsewhere/a-feature/src' }, { ...base, planMtime: pm }), {});
});

test('worktree discovery: common dir outside every root or git null allows', () => {
  const planMtime = () => NOW - 5 * H;
  const outside = (args) => (args.includes('--git-common-dir') ? '/nowhere/x/.git\n' : args.includes('--show-toplevel') ? '/elsewhere/y\n' : mkGit({ dirty: true })(args));
  assert.deepEqual(decide({ cwd: '/elsewhere/y' }, { registry, now: () => NOW, planMtime, git: outside, mtime: () => NOW - H }), {});
  assert.deepEqual(decide({ cwd: '/elsewhere/y' }, { registry, now: () => NOW, planMtime, git: () => null, mtime: () => NOW - H }), {});
});

const sink = () => { const c = []; return { w: new Writable({ write(ch, _e, cb) { c.push(String(ch)); cb(); } }), out: () => c.join('') }; };

test('main: stdin that is not JSON writes {}', async () => {
  const s = sink();
  await main({ stdin: Readable.from(['not json']), stdout: s.w, registryFile: regFile });
  assert.equal(s.out(), '{}');
});

test('main: empty stdin writes {}', async () => {
  const s = sink();
  await main({ stdin: Readable.from([]), stdout: s.w, registryFile: regFile });
  assert.equal(s.out(), '{}');
});

test('main: missing registry file writes {}', async () => {
  const s = sink();
  await main({ stdin: Readable.from([JSON.stringify({ cwd: '/zz/a' })]), stdout: s.w, registryFile: join(dir, 'nope.json') });
  assert.equal(s.out(), '{}');
});

test('main: reads the registry from the --home folder given in argv', async () => {
  const s = sink();
  await main({ stdin: Readable.from([JSON.stringify({ cwd: '/zz/a/x' })]), stdout: s.w, argv: ['node', 'plan-check.mjs', '--home', dir], git: mkGit({ dirty: true, commitAgoMs: H }), now: () => NOW, planMtime: () => null });
  const out = JSON.parse(s.out());
  assert.equal(out.decision, 'block');
  assert.ok(out.reason.includes('Alpha has no plan file'), out.reason);
});

test('cleanup', () => rmSync(dir, { recursive: true, force: true }));
