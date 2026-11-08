import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, rootsOf } from '../registry.mjs';
import { loadConfig } from '../lib/config.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'reg-'));
const writeReg = (dir, projects) => {
  const f = join(dir, 'registry.json');
  writeFileSync(f, JSON.stringify({ version: 1, projects }));
  return f;
};

test('normalises backslashes and fills defaults', () => {
  const d = tmp();
  const reg = loadRegistry(writeReg(d, { a: { name: 'A', family: 'F', kind: 'project', home: ['D:', 'x', 'a', ''].join(String.fromCharCode(92)) } }));
  const e = reg.get('a');
  assert.equal(e.home, 'D:/x/a'); // privacy-ok
  assert.deepEqual(e.repos, []);
  assert.deepEqual(e.uses, []);
  assert.equal(e.protected, false);
  assert.equal(e.note, null);
  assert.deepEqual(e.connectors, {});
});
test('defaults repos to [home] when .git exists', () => {
  const d = tmp();
  mkdirSync(join(d, '.git'));
  const reg = loadRegistry(writeReg(d, { a: { name: 'A', family: 'F', kind: 'project', home: d } }));
  assert.equal(reg.get('a').repos.length, 1);
  assert.equal(reg.get('a').repos[0], reg.get('a').home);
});
test('rejects duplicate homes', () => {
  const d = tmp();
  const f = writeReg(d, {
    a: { name: 'A', family: 'F', kind: 'project', home: 'D:/x/a' }, // privacy-ok
    b: { name: 'B', family: 'F', kind: 'project', home: ['d:', 'X', 'A'].join(String.fromCharCode(92)) },
  });
  assert.throws(() => loadRegistry(f), /duplicate home/);
});
test('rootsOf de-duplicates case-insensitively', () => {
  const e = { home: 'D:/x/a', repos: ['D:/x/a'], worktreesManaged: ['D:/x/wt'] }; // privacy-ok
  assert.deepEqual(rootsOf(e, ['d:/X/WT', 'D:/x/other']), ['D:/x/a', 'D:/x/wt', 'D:/x/other']); // privacy-ok
});
test('loadConfig throws on blank allowedLogin', () => {
  const d = tmp();
  const f = join(d, 'c.json');
  writeFileSync(f, JSON.stringify({ vaultProjectsDir: 'a', mocFile: 'b', allowedLogin: '', port: 1, architectureFile: 'c' }));
  assert.throws(() => loadConfig(f), /allowedLogin/);
  writeFileSync(f, JSON.stringify({ vaultProjectsDir: 'a', mocFile: 'b', allowedLogin: 'x@y', port: 1, architectureFile: 'c' }));
  assert.equal(loadConfig(f).allowedLogin, 'x@y');
  assert.equal(loadConfig(f).memoryRoot, join(process.env.OVERMAP_HOME || homedir(), '.claude', 'projects'));
});
