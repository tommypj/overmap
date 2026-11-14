import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSafe, listDir, indexFiles, kindOf, Forbidden } from '../server/fsapi.mjs';

const base = mkdtempSync(join(tmpdir(), 'fsapi-'));
const root = join(base, 'root');
const outside = join(base, 'outside');
mkdirSync(join(root, 'sub'), { recursive: true });
mkdirSync(join(root, '.git'));
mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, 'sub', 'a.txt'), 'hello');
writeFileSync(join(root, '.git', 'config'), 'x');
writeFileSync(join(root, '.env'), 'S=1');
writeFileSync(join(root, '.env.example'), 'S=');
writeFileSync(join(root, 'node_modules', 'pkg', 'm.png'), 'x');
writeFileSync(join(root, 'sub', 'clip.mp4'), 'x');
writeFileSync(join(root, 'sub', 'plan.docx'), 'x');
writeFileSync(join(root, 'sub', 'notes.md'), 'x');
writeFileSync(join(outside, 'secret.txt'), 'nope');
symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
const roots = [root];

test.after(() => rmSync(base, { recursive: true, force: true }));

test('allows a normal file (forward and back slashes)', () => {
  assert.ok(resolveSafe(roots, 0, 'sub/a.txt').endsWith('a.txt'));
  assert.ok(resolveSafe(roots, 0, 'sub\\a.txt').endsWith('a.txt'));
  assert.ok(resolveSafe(roots, 0, '').length > 0);
});

test('refuses traversal, absolute, bad index, NUL', () => {
  for (const rel of ['../outside/secret.txt', 'sub/../../outside/secret.txt', 'sub\\..\\..\\x', '/etc/passwd', '/Windows', 'a\0b']) {
    assert.throws(() => resolveSafe(roots, 0, rel), Forbidden, rel);
  }
  assert.throws(() => resolveSafe(roots, 1, 'x'), Forbidden);
  assert.throws(() => resolveSafe(roots, -1, 'x'), Forbidden);
  assert.throws(() => resolveSafe(roots, 'a', 'x'), Forbidden);
});

test('refuses .git and secret names, allows .env.example', () => {
  assert.throws(() => resolveSafe(roots, 0, '.git/config'), Forbidden);
  assert.throws(() => resolveSafe(roots, 0, '.GIT'), Forbidden);
  assert.throws(() => resolveSafe(roots, 0, '.env'), Forbidden);
  assert.ok(resolveSafe(roots, 0, '.env.example'));
});

test('refuses a junction pointing outside the root', () => {
  assert.throws(() => resolveSafe(roots, 0, 'link/secret.txt'), Forbidden);
  assert.throws(() => resolveSafe(roots, 0, 'link'), Forbidden);
});

test('a symlink inside a root that points outside is refused with Forbidden(link)', () => {
  const b = mkdtempSync(join(tmpdir(), 'fsapi-link-'));
  try {
    const r = join(b, 'root');
    const sib = join(b, 'sibling');
    mkdirSync(r);
    mkdirSync(sib);
    writeFileSync(join(sib, 'x.txt'), 'x');
    symlinkSync(sib, join(r, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveSafe([r], 0, 'link/x.txt'), (e) => e instanceof Forbidden && e.message === 'link');
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('listDir hides .git and secrets, flags dep dirs, folders first', () => {
  const { entries, truncated } = listDir(root);
  const names = entries.map((e) => e.name);
  assert.equal(truncated, false);
  assert.ok(!names.includes('.git') && !names.includes('.env'));
  assert.ok(names.includes('.env.example'));
  assert.equal(entries.find((e) => e.name === 'node_modules').dep, true);
  assert.equal(entries.find((e) => e.name === 'sub').dep, false);
  const firstFile = entries.findIndex((e) => !e.dir);
  assert.ok(entries.slice(0, firstFile).every((e) => e.dir));
  assert.deepEqual(Object.keys(entries[0]).sort(), ['dep', 'dir', 'kind', 'mtime', 'name', 'size']);
});

test('listDir caps at 2000 with truncated true', () => {
  const big = join(base, 'big');
  mkdirSync(big);
  for (let i = 0; i < 2005; i++) writeFileSync(join(big, `f${i}.txt`), '');
  const r = listDir(big);
  assert.equal(r.entries.length, 2000);
  assert.equal(r.truncated, true);
});

test('indexFiles skips node_modules, .git, junctions; filters by kind', () => {
  const media = indexFiles(roots, 'media');
  assert.deepEqual(media.files.map((f) => f.name), ['clip.mp4']);
  assert.equal(media.files[0].root, 0);
  assert.equal(media.files[0].path, 'sub/clip.mp4');
  const docs = indexFiles(roots, 'docs').files.map((f) => f.name).sort();
  assert.deepEqual(docs, ['notes.md', 'plan.docx']);
  assert.equal(indexFiles(roots, 'media', { cap: 0 }).truncated, true);
});

test('kindOf', () => {
  assert.equal(kindOf('a.mp4'), 'video');
  assert.equal(kindOf('b.docx'), 'office');
  assert.equal(kindOf('c.PNG'), 'image');
  assert.equal(kindOf('d.md'), 'markdown');
  assert.equal(kindOf('e.zzz'), 'other');
  assert.equal(kindOf('Makefile'), 'other');
});

test('refuses NTFS stream and trailing dot/space aliases', () => {
  for (const rel of ['sub/a.txt::$DATA', '.env::$DATA', '.git::$INDEX_ALLOCATION/config', 'x::$DATA', '.env.', '.env ', 'sub./a.txt']) {
    assert.throws(() => resolveSafe(roots, 0, rel), Forbidden, rel);
  }
});

test('refuses 8.3 short-name aliases of hidden entries', { skip: process.platform !== 'win32' && '8.3 short names are Windows-only' }, (t) => {
  const out = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', root], { encoding: 'utf8' });
  const aliases = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /(\S*~\d\S*)\s+(\.env|\.git)\s*$/i.exec(line);
    if (m) aliases.push(m[1]);
  }
  if (aliases.length === 0) return t.skip('no 8.3 names on this volume');
  for (const a of aliases) {
    assert.throws(() => resolveSafe(roots, 0, a), Forbidden, a);
    assert.throws(() => resolveSafe(roots, 0, `${a}/config`), (e) => e instanceof Forbidden || e.name === 'NotFound', a);
  }
});

test('secret-named directories are refused at any depth', () => {
  mkdirSync(join(root, 'secretsdir.bak'));
  writeFileSync(join(root, 'secretsdir.bak', 'inner.txt'), 'x');
  assert.throws(() => resolveSafe(roots, 0, 'secretsdir.bak/inner.txt'), Forbidden);
  assert.throws(() => resolveSafe(roots, 0, 'secretsdir.bak'), Forbidden);
});

test('indexFiles does not follow junctions (outside holds an mp4)', () => {
  writeFileSync(join(outside, 'leak.mp4'), 'x');
  const names = indexFiles(roots, 'media').files.map((f) => f.name);
  assert.ok(!names.includes('leak.mp4'));
  assert.ok(names.includes('clip.mp4'));
});
