import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attentionFlags } from '../scan/attention.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const repo = (value, error) => ({
  path: '/p/a',
  git: error
    ? { at: 'x', error }
    : { at: 'x', value: { worktrees: [], remotes: ['origin'], localOnlyCommits: 0, localOnlyBranches: [], modified: 0, untracked: 0, ...value } },
});
const base = (over = {}) => ({
  id: 'p', kind: 'project', status: 'active', exists: true, home: '/p', worktreesManaged: [], blockers: [],
  repos: [repo({})],
  ...over,
});
const texts = (p, lv) => attentionFlags(p, NOW).filter((f) => !lv || f.level === lv).map((f) => f.text);

test('clean project has no flags', () => assert.deepEqual(attentionFlags(base(), NOW), []));

test('no remote is a risk, unknown remotes is not', () => {
  assert.deepEqual(texts(base({ repos: [repo({ remotes: [] })] }), 'risk'), ['/p/a: no remote']);
  const unknown = attentionFlags(base({ repos: [repo({ remotes: null })] }), NOW);
  assert.equal(unknown.some((f) => /no remote/.test(f.text)), false);
  assert.equal(unknown.some((f) => f.level === 'warn' && /git facts incomplete/.test(f.text)), true);
});

test('kind data/tool with no remote has no no-remote flag', () => {
  assert.equal(texts(base({ kind: 'data', repos: [repo({ remotes: [] })] })).some((t) => /no remote/.test(t)), false);
  assert.equal(texts(base({ kind: 'tool', repos: [repo({ remotes: [] })] })).some((t) => /no remote/.test(t)), false);
});

test('unpushed commits warn with count; uncommitted warns', () => {
  const t = texts(base({ repos: [repo({ localOnlyCommits: 3, modified: 1, untracked: 2 })] }), 'warn');
  assert.ok(t.includes('/p/a: 3 commits not on GitHub'));
  assert.ok(t.includes('/p/a: 3 uncommitted'));
});

test('git error is a risk with the reason', () => {
  assert.deepEqual(texts(base({ repos: [repo(null, 'fatal: dubious ownership')] }), 'risk'), ['/p/a: git unreadable: fatal: dubious ownership']);
});

test('home missing is a risk', () => assert.equal(texts(base({ exists: false }), 'risk').length, 1));

test('archived and terminated have no flags', () => {
  assert.deepEqual(attentionFlags(base({ status: 'archived', exists: false }), NOW), []);
  assert.deepEqual(attentionFlags(base({ status: 'terminated', repos: [repo({ remotes: [] })] }), NOW), []);
});


test('blocker older than 14 days warns; recent does not; done ignored', () => {
  const b = (since, done = false) => ({ since, done, text: 'wait for X' });
  assert.equal(texts(base({ blockers: [b('2026-10-01')] }), 'warn').length, 1);
  assert.equal(texts(base({ blockers: [b('2026-10-25'), b('2026-09-01', true), b(null)] })).length, 0);
});

test('discovered worktree not in worktreesManaged warns', () => {
  const wt = { path: '/p-extra', branch: 'x', modified: 0, untracked: 0 };
  const p = base({ repos: [repo({ worktrees: [{ path: '/p/a', branch: 'main' }, wt] })], worktreesManaged: [] });
  assert.ok(texts(p, 'warn').some((t) => /unmapped worktree \/p-extra/.test(t)));
  assert.equal(texts({ ...p, worktreesManaged: ['/p-extra'] }).some((t) => /unmapped worktree/.test(t)), false);
});

test('worktree rules: .claude/worktrees and registered roots and tool homes are quiet; a sibling warns', () => {
  const wt = (path) => base({ repos: [repo({ worktrees: [{ path, branch: 'x' }] })] });
  const ctx = { registeredRoots: ['/other'], toolHomes: ['/tool-home'] };
  const unmapped = (path) => attentionFlags(wt(path), NOW, ctx).some((f) => /unmapped worktree/.test(f.text));
  assert.equal(unmapped('/p/.claude/worktrees/x'), false);
  assert.equal(unmapped('/other/sub'), false);
  assert.equal(unmapped('/tool-home/worktrees/3ea2/p'), false);
  assert.equal(unmapped('/p-sibling'), true);
});
