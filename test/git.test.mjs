import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitFacts } from '../scan/git.mjs';
import { norm } from '../lib/paths.mjs';

// git reports worktree paths with symlinks and 8.3 short names resolved
const real = (p) => norm(fs.realpathSync.native(p));

const ID = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', windowsHide: true });

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function makeRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "it's a repo-"));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('clean repo', async () => {
  const dir = makeRepo();
  const r = await gitFacts(dir);
  assert.ok(r.at && !r.error);
  const v = r.value;
  assert.equal(v.branch, 'main');
  assert.equal(v.modified, 0);
  assert.equal(v.untracked, 0);
  assert.equal(v.localOnlyCommits, 1);
  assert.deepEqual(v.remotes, []);
  assert.equal(v.isWorktree, false);
  assert.equal(v.lastSubject, 'first');
  assert.equal(v.stashes, 0);
  assert.deepEqual(v.worktrees, []);
});

test('counts modified and untracked', async () => {
  const dir = makeRepo();
  fs.writeFileSync(join(dir, 'a.txt'), 'changed');
  fs.writeFileSync(join(dir, 'new.txt'), 'n');
  const v = (await gitFacts(dir)).value;
  assert.equal(v.modified, 1);
  assert.equal(v.untracked, 1);
});

test('worktree listed under main repo and recognised itself', async () => {
  const dir = makeRepo();
  const wt = dir + '-wt';
  made.push(wt);
  git(dir, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.writeFileSync(join(wt, 'x.txt'), 'x');
  const main = (await gitFacts(dir)).value;
  assert.equal(main.worktrees.length, 1);
  assert.equal(main.worktrees[0].path, real(wt));
  assert.equal(main.worktrees[0].branch, 'feat');
  assert.equal(main.worktrees[0].untracked, 1);
  const w = (await gitFacts(wt)).value;
  assert.equal(w.isWorktree, true);
  assert.equal(w.mainRepo, real(dir));
  assert.equal(w.branch, 'feat');
  assert.deepEqual(w.worktrees.map((x) => x.path), [real(dir)]);
});

test('worktree whose folder is gone reports unknown counts, not zeros', async () => {
  const dir = makeRepo();
  const wt = dir + '-gone';
  made.push(wt);
  git(dir, 'worktree', 'add', '-q', '-b', 'gone', wt);
  const wtReal = real(wt);
  fs.rmSync(wt, { recursive: true, force: true });
  const v = (await gitFacts(dir)).value;
  const e = v.worktrees.find((x) => x.path === wtReal);
  assert.ok(e.error);
  assert.equal(e.modified, null);
  assert.equal(e.untracked, null);
  assert.equal(e.prunable, true);
});

test('detached HEAD gives branch null', async () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '--detach');
  assert.equal((await gitFacts(dir)).value.branch, null);
});

test('remote URL containing a space is kept whole', async () => {
  const dir = makeRepo();
  const other = fs.mkdtempSync(join(os.tmpdir(), 'a remote-'));
  made.push(other);
  git(dir, 'remote', 'add', 'origin', other);
  const v = (await gitFacts(dir)).value;
  assert.deepEqual(v.remotes, [other]); // verbatim, space intact
});

test('credentials stripped from remotes; local-only branches counted', async () => {
  const dir = makeRepo();
  git(dir, 'remote', 'add', 'origin', 'https://u:tok@example.com/x/y.git');
  git(dir, 'checkout', '-q', '-b', 'topic');
  const v = (await gitFacts(dir)).value;
  assert.deepEqual(v.remotes, ['https://example.com/x/y.git']);
  assert.equal(v.localOnlyCommits, 1);
  assert.ok(v.localOnlyBranches.some((b) => b.name === 'main' && b.commits === 1));
});

test('missing path gives error and no value', async () => {
  const r = await gitFacts(join(os.tmpdir(), 'definitely-missing-' + Date.now()));
  assert.ok(r.at);
  assert.ok(r.error);
  assert.equal(r.value, undefined);
});
