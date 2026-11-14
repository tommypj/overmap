import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, rootsOf } from '../registry.mjs';
import { buildRegistry } from '../make-registry.mjs';

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
test('buildRegistry: note with path ~/code/app resolves to an absolute home; extra entries are added; existing ids are never overwritten', () => {
  const d = tmp();
  const vault = join(d, 'vault');
  mkdirSync(vault);
  const note = ['---', 'type: project', 'dashboard: true', 'name: App', 'group: Web', 'path: ~/code/app', 'uses:', '  - db', 'connects:', '  - vercel', '---', '# App', ''];
  writeFileSync(join(vault, 'App.md'), note.join(String.fromCharCode(10)));
  const extra = join(d, 'registry.extra.json');
  writeFileSync(extra, JSON.stringify({ projects: { tool: { name: 'Tool', family: 'Ops', kind: 'tool', home: join(d, 'tool') }, App: { name: 'Clash', home: join(d, 'other') } } }));
  const registryFile = join(d, 'registry.json');
  writeFileSync(registryFile, JSON.stringify({ version: 1, projects: { keep: { name: 'Keep', family: 'F', kind: 'project', home: join(d, 'keep') } } }));
  const r = buildRegistry({ vaultProjectsDir: vault, registryFile, extraFile: extra });
  assert.deepEqual(r.added.sort(), ['App', 'tool']);
  const out = JSON.parse(readFileSync(registryFile, 'utf8')).projects;
  assert.ok(/^([A-Za-z]:)?\//.test(out.App.home), out.App.home); // privacy-ok
  assert.ok(out.App.home.endsWith('/code/app'), out.App.home);
  assert.equal(out.App.family, 'Web');
  assert.deepEqual(out.App.uses, ['db']);
  assert.deepEqual(out.App.connects, ['vercel']);
  assert.equal(out.App.name, 'App');
  assert.equal(out.tool.name, 'Tool');
  assert.deepEqual(out.keep.name, 'Keep');
  assert.ok(out.App.name !== 'Clash');
  assert.deepEqual(out.keep.connects, undefined);
  rmSync(d, { recursive: true, force: true });
});
