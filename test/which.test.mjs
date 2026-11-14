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

test('which on win32 resolves .exe, never a .cmd shim unless allowShims', () => {
  const dir = dirWith('tool.exe', 'tool.cmd');
  try {
    const env = { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' }; // lower case: same answer on case-sensitive filesystems
    assert.equal(which('tool', { env, platform: 'win32' }), join(dir, 'tool.exe'));
    assert.equal(which('missing', { env, platform: 'win32' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which on win32: a .cmd shim alone is not returned, but allowShims reports it', () => {
  const dir = dirWith('tool.cmd');
  try {
    const env = { PATH: dir, PATHEXT: '.com;.exe;.bat;.cmd' };
    assert.equal(which('tool', { env, platform: 'win32' }), null);
    assert.equal(which('tool', { env, platform: 'win32', allowShims: true }), join(dir, 'tool.cmd'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which on posix finds the bare name', () => {
  const dir = dirWith('tool');
  try {
    assert.equal(which('tool', { env: { PATH: dir }, platform: 'linux' }), join(dir, 'tool'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which on win32 falls back to the bare name unless it is a shim, and skips relative PATH entries', () => {
  const dir = dirWith('plain');
  try {
    assert.equal(which('plain', { env: { PATH: dir, PATHEXT: '.EXE' }, platform: 'win32' }), join(dir, 'plain'));
    assert.equal(which('plain', { env: { PATH: 'relative-dir' }, platform: 'linux' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('which default PATHEXT resolves .EXE and skips .CMD and .BAT unless allowShims', () => {
  const dir = '/fake/dir';
  const seen = [];
  const exists = (p) => { seen.push(p); return p === join(dir, 'tool.EXE'); };
  assert.equal(which('tool', { env: { PATH: dir }, platform: 'win32', exists }), join(dir, 'tool.EXE'));
  assert.deepEqual(seen.slice(0, 2), [join(dir, 'tool.COM'), join(dir, 'tool.EXE')]);
  const shimOnly = (p) => p === join(dir, 'tool.CMD');
  assert.equal(which('tool', { env: { PATH: dir }, platform: 'win32', exists: shimOnly }), null);
  assert.equal(which('tool', { env: { PATH: dir }, platform: 'win32', exists: shimOnly, allowShims: true }), join(dir, 'tool.CMD'));
});
