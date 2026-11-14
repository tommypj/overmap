import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readTestResults } from '../scan/tests.mjs';
import { buildProject, buildProjectSafe } from '../scan/project.mjs';

const BS = String.fromCharCode(92);
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'tests-fact-'));
const ctx = { cache: {}, skipSize: true, attentionCtx: { registeredRoots: [], toolHomes: [] } };
const entry = (home, extra = {}) => ({ id: 'p', name: 'P', family: 'Other', kind: 'project', home, repos: [], worktreesManaged: [], oldPaths: [], protected: false, note: null, uses: [], connectors: {}, ...extra });

test('readTestResults: first root wins, defaults filled, command cut to 200', () => {
  const a = tmp(), b = tmp();
  fs.writeFileSync(join(b, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 12, failed: 1, command: 'x'.repeat(300) }));
  const r = readTestResults([a, b]);
  assert.equal(r.value.file.toLowerCase(), join(b, 'test-results.json').replaceAll(BS, '/').toLowerCase());
  assert.deepEqual([r.value.passed, r.value.failed, r.value.skipped, r.value.total, r.value.durationMs, r.value.command.length], [12, 1, null, 13, null, 200]);
  assert.deepEqual(readTestResults([a]).value, null);
});

test('readTestResults: every malformed shape is an error naming the file, never a throw', () => {
  const cases = [['{', 'not JSON'], ['{"passed":1,"failed":0}', 'missing at'], ['{"at":"yesterday","passed":1,"failed":0}', 'bad at'],
    ['{"at":"2026-11-03T10:00:00Z","failed":0}', 'missing passed'], ['{"at":"2026-11-03T10:00:00Z","passed":-1,"failed":0}', 'passed must be a non-negative integer'],
    ['{"at":"2026-11-03T10:00:00Z","passed":1.5,"failed":0}', 'passed must be a non-negative integer'], ['{"at":"2026-11-03T10:00:00Z","passed":1,"failed":0,"durationMs":"fast"}', 'durationMs must be a non-negative number']];
  for (const [text, why] of cases) {
    const d = tmp(); fs.writeFileSync(join(d, 'test-results.json'), text);
    const r = readTestResults([d]);
    assert.ok(r.error?.endsWith(why), `${text} → ${r.error}`); assert.ok(r.error.includes('test-results.json'));
  }
  const big = tmp(); fs.writeFileSync(join(big, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 1, failed: 0, pad: 'x'.repeat(70000) }));
  assert.ok(readTestResults([big]).error.endsWith('over 64 KiB'));
});

test('readTestResults: valid total and skipped kept, non-string command becomes null', () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 2, failed: 0, skipped: 3, total: 9, durationMs: 1.5, command: 5 }));
  const v = readTestResults([d]).value;
  assert.deepEqual([v.total, v.skipped, v.durationMs, v.command], [9, 3, 1.5, null]);
  fs.writeFileSync(join(d, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 2, failed: 1, skipped: 3, total: -4 }));
  assert.equal(readTestResults([d]).value.total, 6);
});

test('readTestResults: a UTF-8 BOM in the file is tolerated', () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'test-results.json'), '\uFEFF' + JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 3, failed: 0 }));
  const r = readTestResults([d]);
  assert.equal(r.error, undefined);
  assert.equal(r.value.passed, 3);
});

test('readTestResults: secrets in command are masked', () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 1, failed: 0, command: 'curl -H Authorization:Bearer abcdefghijklmnopqrstuvwx1234 && node --test' }));
  const r = readTestResults([d]);
  assert.ok(!r.value.command.includes('abcdefghijklmnopqrstuvwx1234'), r.value.command);
});

test('buildProject carries tests; a missing home gives tests null', async () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'test-results.json'), JSON.stringify({ at: '2026-11-03T10:00:00Z', passed: 1, failed: 0 }));
  const p = await buildProject(entry(d.replaceAll(BS, '/')), ctx);
  assert.equal(p.tests.value.passed, 1);
  const bad = await buildProjectSafe(entry('/x', { repos: null }), ctx);
  assert.equal(bad.tests, null);
});
