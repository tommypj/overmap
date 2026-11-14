import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, readDenylist, PATTERNS } from '../tools/publish-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const denylist = process.env.OVERMAP_DENYLIST ? readDenylist(process.env.OVERMAP_DENYLIST) : [];

const hit = (s) => PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name);

// A throwaway tree with the given files (name -> content); returns its root.
function tempTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overmap-privacy-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const names = (findings) => findings.map((f) => f.name).sort();

test('patterns catch the shapes the spec names', () => {
  assert.deepEqual(hit('see D:/projects/x'), ['drive-path']); // privacy-ok
  assert.deepEqual(hit('C:\\Users\\someone\\x'), ['drive-path']); // privacy-ok
  assert.deepEqual(hit('host: box.tail1234.ts.net'), ['tailnet-host']); // privacy-ok
  assert.deepEqual(hit('mail me at a.b@example.com'), ['email']);
  assert.deepEqual(hit('Bearer pcp_board_1234567890abcdef'), ['secret']); // privacy-ok
  assert.deepEqual(hit('sk-ant-api03-abcdefghijklmnop'), ['secret']); // privacy-ok
  assert.deepEqual(hit('-----BEGIN PRIVATE KEY-----'), ['secret']); // privacy-ok
  assert.deepEqual(hit('a plain sentence with /usr/local/bin'), []);
});

test('secret patterns cover Google OAuth client secrets and client_secret JSON keys', () => {
  assert.deepEqual(hit('GOCSPX-abcdefghijklmnopqrstuvwx'), ['secret']); // privacy-ok
  assert.deepEqual(hit('{"client_secret": "abcdefgh1234"}'), ['secret']); // privacy-ok
  assert.deepEqual(hit('"client_secret": ""'), []);
});

test('user-home flags real user folders and exempts the placeholder names', () => {
  assert.deepEqual(hit('/Users/mehdi/x'), ['user-home']); // privacy-ok
  assert.deepEqual(hit('/Users/someone/x'), []);
  assert.deepEqual(hit('/home/me/x'), []);
  assert.deepEqual(hit('/home/alice/x'), ['user-home']); // privacy-ok
});

test('denylist terms match whole terms even when they start or end with punctuation', () => {
  const dl = tempTree({ 'list.txt': 'foo+bar.\n' });
  const tree = tempTree({ 'a.txt': 'run foo+bar. now\n', 'b.txt': 'xfoo+bar.y\n' });
  try {
    const terms = readDenylist(path.join(dl, 'list.txt'));
    const findings = scanTree(tree, { denylist: terms });
    assert.deepEqual(findings.map((f) => `${f.file}:${f.name}`), ['a.txt:denylist']);
  } finally {
    cleanup(dl);
    cleanup(tree);
  }
});

test('positive control: scanTree flags a planted drive path', () => {
  const tree = tempTree({ 'notes.md': 'open D:/projects/alpha now\n' }); // privacy-ok
  try {
    assert.deepEqual(names(scanTree(tree)), ['drive-path']);
  } finally {
    cleanup(tree);
  }
});

test('positive control: scanTree flags a planted denylist term from a temp denylist file', () => {
  const dl = tempTree({ 'list.txt': '# invented\nzorbix\n' });
  const tree = tempTree({ 'notes.md': 'the Zorbix tool\n' });
  try {
    const findings = scanTree(tree, { denylist: readDenylist(path.join(dl, 'list.txt')) });
    assert.deepEqual(names(findings), ['denylist']);
  } finally {
    cleanup(dl);
    cleanup(tree);
  }
});

test('positive control: an example.com address is exempt, a real one is not', () => {
  const ok = tempTree({ 'a.md': 'write me@example.com\n' });
  const bad = tempTree({ 'a.md': 'write someone@gmail.com\n' }); // privacy-ok
  try {
    assert.deepEqual(scanTree(ok), []);
    assert.deepEqual(names(scanTree(bad)), ['email']);
  } finally {
    cleanup(ok);
    cleanup(bad);
  }
});

test('positive control: a privacy-ok line is skipped', () => {
  const tree = tempTree({ 'a.js': "const x = 'D:/projects/alpha'; // privacy-ok\n" }); // privacy-ok
  try {
    assert.deepEqual(scanTree(tree), []);
  } finally {
    cleanup(tree);
  }
});

test('positive control: binary extensions are skipped even with a planted hit', () => {
  const tree = tempTree({ 'shot.png': 'D:/projects/alpha\n' }); // privacy-ok
  try {
    assert.deepEqual(scanTree(tree), []);
  } finally {
    cleanup(tree);
  }
});

test('positive control: machine-local base artifacts are not scanned', () => {
  const tree = tempTree({ 'notes.md': 'clean\n' });
  try {
    for (const dir of ['.base-ast', '.base-ast-cache']) {
      fs.mkdirSync(path.join(tree, dir));
      fs.writeFileSync(path.join(tree, dir, 'x.txt'), 'open D:/projects/alpha now\n'); // privacy-ok
    }
    assert.deepEqual(scanTree(tree), []);
  } finally {
    cleanup(tree);
  }
});

test('the public tree is clean', () => {
  const findings = scanTree(root, { denylist });
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.name} ${f.excerpt}`), []);
});
