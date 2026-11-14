import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';

const B = String.fromCharCode(92);

test('double-quoted scalar is unescaped like JSON', () => {
  const text = ['---', 'path: "D:' + B + B + 'x' + B + B + 'y"', '---', ''].join('\n');
  assert.equal(parseFrontmatter(text).data.path, 'D:' + B + 'x' + B + 'y');
});
test('single-quoted scalar is taken as is', () => {
  const text = ['---', "path: 'D:" + B + "x'", '---', ''].join('\n');
  assert.equal(parseFrontmatter(text).data.path, 'D:' + B + 'x');
});

test('serializeFrontmatter round-trips control chars and punctuation', () => {
  const nl = 'x\ndashboard: false\npath: /elsewhere';
  const plain = 'a'+String.fromCharCode(10)+'b';
  assert.equal(parseFrontmatter(serializeFrontmatter({ p: plain }) + 'x').data.p, plain);
  const odd = 'a: b # c "q" \'s\'';
  const out = parseFrontmatter(serializeFrontmatter({ a: nl, b: odd }) + 'body');
  assert.equal(out.data.a, nl);
  assert.equal(out.data.b, odd);
  assert.deepEqual(Object.keys(out.data), ['a', 'b']);
});

// docs/notes.md is the public contract for a project note: its template must parse with the same reader make-registry uses.
test('the frontmatter template in docs/notes.md parses as a project note', () => {
  const doc = readFileSync(fileURLToPath(new URL('../docs/notes.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const at = doc.indexOf('## Frontmatter');
  const open = doc.indexOf('```yaml\n', at);
  const close = doc.indexOf('\n```', open + 8);
  assert.ok(at >= 0 && open > at && close > open, 'yaml fence under ## Frontmatter');
  const yaml = doc.slice(open + '```yaml\n'.length, close);
  assert.ok(!/ #/.test(yaml), 'no trailing comments in the template');
  const { data } = parseFrontmatter(yaml + '\n');
  assert.equal(data.type, 'project');
  assert.equal(data.dashboard, true);
  assert.equal(data.path, '~/code/my-app');
});
