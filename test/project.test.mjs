import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { updateMoc } from '../scan/assemble.mjs';
import { buildProject, buildProjectSafe } from '../scan/project.mjs';

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'proj-'));
const fwd = (p) => p.replaceAll('\\', '/');
const ctx = { snapshot: { at: 'x', error: 'none' }, cache: {}, skipSize: true, attentionCtx: { registeredRoots: [], toolHomes: [] }, refs: async () => ({ at: 'x', value: [] }) };
const entry = (home, extra = {}) => ({ id: 'p', name: 'P', family: 'Other', kind: 'project', home, repos: [], worktreesManaged: [], oldPaths: [], protected: false, note: null, uses: [], connectors: {}, ...extra });

test('PROJECT.md with family: 42 and memory: single.md scans without throwing', async () => {
  const d = fwd(tmp());
  fs.writeFileSync(`${d}/PROJECT.md`, '---\nfamily: 42\nstatus: 7\npurpose: 99\nmemory: single.md\nuses: neon\n---\n');
  const p = await buildProject(entry(d), ctx);
  assert.equal(p.group, '42');
  assert.equal(p.summary, '99');
  assert.deepEqual(p.uses, ['neon']);
  assert.ok(Array.isArray(p.memory));
  assert.equal(typeof p.status, 'string');
});

test('a failing project becomes a minimal risk project instead of throwing', async () => {
  const p = await buildProjectSafe(entry('/x', { repos: null }), ctx);
  assert.equal(p.status, 'unknown');
  assert.equal(p.attention[0].level, 'risk');
  assert.match(p.attention[0].text, /^scan failed: /);
  assert.deepEqual(p.repos, []);
  assert.equal(p.plan, null);
});

test('updateMoc leaves the file alone when no marker or heading matches, never creates it', () => {
  const d = tmp();
  const f = join(d, 'moc.md');
  fs.writeFileSync(f, 'nothing here');
  const before = fs.statSync(f).mtimeMs;
  assert.equal(updateMoc(f, 'TABLE'), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'nothing here');
  assert.equal(fs.statSync(f).mtimeMs, before);
  assert.equal(updateMoc(join(d, 'missing.md'), 'TABLE'), false);
  assert.equal(fs.existsSync(join(d, 'missing.md')), false);
});
