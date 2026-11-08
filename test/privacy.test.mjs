import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { scanTree, readDenylist, PATTERNS } from '../tools/publish-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const denylist = process.env.OVERMAP_DENYLIST ? readDenylist(process.env.OVERMAP_DENYLIST) : [];

test('patterns catch the shapes the spec names', () => {
  const hit = (s) => PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name);
  assert.deepEqual(hit('see D:/projects/x'), ['drive-path']); // privacy-ok
  assert.deepEqual(hit('C:\\Users\\someone\\x'), ['drive-path']); // privacy-ok
  assert.deepEqual(hit('host: box.tail1234.ts.net'), ['tailnet-host']); // privacy-ok
  assert.deepEqual(hit('mail me at a.b@example.com'), ['email']);
  assert.deepEqual(hit('Bearer pcp_board_1234567890abcdef'), ['secret']); // privacy-ok
  assert.deepEqual(hit('sk-ant-api03-abcdefghijklmnop'), ['secret']); // privacy-ok
  assert.deepEqual(hit('-----BEGIN PRIVATE KEY-----'), ['secret']); // privacy-ok
  assert.deepEqual(hit('a plain sentence with /usr/local/bin'), []);
});

test('the public tree is clean', () => {
  const findings = scanTree(root, { denylist });
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.name} ${f.excerpt}`), []);
});
