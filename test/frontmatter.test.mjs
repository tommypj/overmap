import { test } from 'node:test';
import assert from 'node:assert/strict';
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
