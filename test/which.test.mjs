import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which } from '../lib/which.mjs';

function dirWith(...names) {
  const dir = mkdtempSync(join(tmpdir(), 'which-'));
  for (const n of names) writeFileSync(join(dir, n), '');
  return dir;
}

test('which finds an executable on PATH and respects PATHEXT on win32', () => {
  const dir = dirWith('tool', 'tool.cmd');
  try {
    const env = { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' }; // lower case: same answer on case-sensitive filesystems
    assert.equal(which('tool', { env, platform: 'win32' }), join(dir, 'tool.cmd'));
    assert.equal(which('tool', { env: { PATH: dir }, platform: 'linux' }), join(dir, 'tool'));
    assert.equal(which('missing', { env, platform: 'win32' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which falls back to the bare name on win32 and skips relative PATH entries', () => {
  const dir = dirWith('plain');
  try {
    assert.equal(which('plain', { env: { PATH: dir, PATHEXT: '.EXE' }, platform: 'win32' }), join(dir, 'plain'));
    assert.equal(which('plain', { env: { PATH: 'relative-dir' }, platform: 'linux' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which uses the default PATHEXT when the env has none', () => {
  const dir = '/fake/dir';
  const seen = [];
  const exists = (p) => { seen.push(p); return p === join(dir, 'tool.EXE'); };
  assert.equal(which('tool', { env: { PATH: dir }, platform: 'win32', exists }), join(dir, 'tool.EXE'));
  assert.deepEqual(seen.slice(0, 2), [join(dir, 'tool.COM'), join(dir, 'tool.EXE')]);
});
