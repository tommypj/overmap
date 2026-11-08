import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildResult, fromNodeSummary, fromJestJson, fromJunitXml } from '../tools/test-results-lib.mjs';
import { parseArgs, convert, resolveCommand } from '../tools/test-results.mjs';
import { readTestResults } from '../scan/tests.mjs';

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'tr-tools-'));
// the child must not inherit the parent test runner's context, or node:test refuses to run files
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')));
const HERE = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '..');

test('buildResult: totals default to the sum, skipped/duration/command optional, command cut to 200', () => {
  const r = buildResult({ passed: 3, failed: 1, skipped: 2, durationMs: 1234.6, command: 'x'.repeat(300), at: '2026-11-03T10:00:00Z' });
  assert.deepEqual(r, { at: '2026-11-03T10:00:00Z', passed: 3, failed: 1, skipped: 2, total: 6, durationMs: 1235, command: 'x'.repeat(200) });
  const bare = buildResult({ passed: 1, failed: 0, at: 'T' });
  assert.deepEqual(bare, { at: 'T', passed: 1, failed: 0, total: 1 });
  assert.throws(() => buildResult({ passed: -1, failed: 0 }), /non-negative/);
  assert.throws(() => buildResult({ passed: 1.5, failed: 0 }), /non-negative/);
});

test('fromNodeSummary: cancelled counts as failed, todo as skipped, total from counts.tests', () => {
  const r = fromNodeSummary({ counts: { tests: 10, passed: 6, failed: 1, cancelled: 1, skipped: 1, todo: 1 }, duration_ms: 512.3 }, { at: 'T', command: 'node --test' });
  assert.deepEqual(r, { at: 'T', passed: 6, failed: 2, skipped: 2, total: 10, durationMs: 512, command: 'node --test' });
});

test('fromJestJson: vitest/jest counts, duration from startTime to the last endTime', () => {
  const t0 = Date.UTC(2026, 10, 3, 10);
  const r = fromJestJson({ numTotalTests: 5, numPassedTests: 3, numFailedTests: 1, numPendingTests: 1, startTime: t0, testResults: [{ endTime: t0 + 4000 }, { endTime: t0 + 2000 }] });
  assert.deepEqual(r, { at: '2026-11-03T10:00:00.000Z', passed: 3, failed: 1, skipped: 1, total: 5, durationMs: 4000 });
  assert.throws(() => fromJestJson({ hello: 1 }), /numPassedTests/);
});

test('fromJunitXml: sums suites, errors count as failed, time in seconds', () => {
  const xml = '<?xml version="1.0"?><testsuites><testsuite name="a" tests="4" failures="1" errors="0" skipped="1" time="1.5" timestamp="2026-11-03T10:00:00"></testsuite>'
    + '<testsuite name="b" tests="2" failures="0" errors="1" skipped="0" time="0.25"/></testsuites>';
  const r = fromJunitXml(xml);
  // pytest writes a zone-less local timestamp; it is read as local time, like Date does
  assert.deepEqual(r, { at: new Date('2026-11-03T10:00:00').toISOString(), passed: 3, failed: 2, skipped: 1, total: 6, durationMs: 1750 });
  assert.throws(() => fromJunitXml('<html/>'), /testsuite/);
});

test('parseArgs and convert: format, file, --out, --command; unknown format throws', () => {
  assert.deepEqual(parseArgs(['junit', 'r.xml', '--out', 'o.json', '--command', 'pytest']), { run: false, format: 'junit', file: 'r.xml', out: 'o.json', command: 'pytest', cmd: [] });
  assert.equal(convert('vitest', JSON.stringify({ numPassedTests: 1, numFailedTests: 0 }), { at: 'T' }).passed, 1);
  assert.throws(() => convert('mocha', '{}'), /unknown format/);
});

test('run mode: parseArgs splits at --, npm/npx/node resolve next to this node, other commands pass through', () => {
  const a = parseArgs(['run', 'vitest', 'r.json', '--', 'npm', 'run', 'test', '--', '--reporter=json']);
  assert.deepEqual([a.run, a.format, a.file, a.cmd], [true, 'vitest', 'r.json', ['npm', 'run', 'test', '--', '--reporter=json']]);
  assert.deepEqual(resolveCommand(['node', '-v']), [process.execPath, '-v']);
  assert.deepEqual(resolveCommand(['pytest', '-q']), ['pytest', '-q']);
  const npm = resolveCommand(['npm', 'test']);
  assert.equal(npm[0], process.execPath); assert.match(npm[1], /npm-cli\.js$/);
  assert.throws(() => resolveCommand(['npx', 'x'], '/nowhere/node.exe'), /npx-cli\.js not found/);
});

test('run mode CLI: runs the command, converts its report, exits with the command\'s code', () => {
  const d = tmp();
  const report = join(d, 'r.json');
  // a stand-in test runner: writes a vitest-shaped report with one failure and exits 1
  fs.writeFileSync(join(d, 'fake-runner.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({ numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, startTime: 1, testResults: [{ endTime: 51 }] })); process.exit(1);\n`);
  const cli = join(HERE, 'tools', 'test-results.mjs');
  const r = spawnSync(process.execPath, [cli, 'run', 'vitest', report, '--', 'node', join(d, 'fake-runner.mjs'), report], { cwd: d, encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  const fact = readTestResults([d]);
  assert.deepEqual([fact.value.passed, fact.value.failed, fact.value.durationMs], [2, 1, 50]);
  assert.match(fact.value.command, /fake-runner/);
  assert.equal(spawnSync(process.execPath, [cli, 'run', 'vitest', report], { cwd: d, encoding: 'utf8' }).status, 2); // no command after --
});

test('node-test-reporter: a real node --test run writes a file scan/tests.mjs accepts', () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'a.test.mjs'), "import { test } from 'node:test'; test('ok', () => {}); test('skipped', { skip: true }, () => {}); test('bad', () => { throw new Error('x'); });\n");
  const out = join(d, 'test-results.json');
  const reporter = 'file:///' + join(HERE, 'tools', 'node-test-reporter.mjs').replaceAll('\\', '/');
  const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${out}`, join(d, 'a.test.mjs')], { cwd: d, encoding: 'utf8', timeout: 60000, env });
  assert.equal(r.status, 1, r.stderr); // one failing test
  const fact = readTestResults([d]);
  assert.equal(fact.error, undefined, fact.error);
  assert.deepEqual([fact.value.passed, fact.value.failed, fact.value.skipped, fact.value.total], [1, 1, 1, 3]);
  assert.ok(fact.value.durationMs >= 0 && fact.value.command.includes('--test'));
});

test('CLI: converts a vitest report into test-results.json next to it, exit 0; bad input exit 2', () => {
  const d = tmp();
  fs.writeFileSync(join(d, 'v.json'), JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, startTime: 1762164000000, testResults: [{ endTime: 1762164001000 }] }));
  const cli = join(HERE, 'tools', 'test-results.mjs');
  const ok = spawnSync(process.execPath, [cli, 'vitest', 'v.json', '--command', 'npx vitest run'], { cwd: d, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const fact = readTestResults([d]);
  assert.deepEqual([fact.value.passed, fact.value.failed, fact.value.total, fact.value.durationMs, fact.value.command], [2, 0, 2, 1000, 'npx vitest run']);
  const bad = spawnSync(process.execPath, [cli, 'junit', 'v.json'], { cwd: d, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /testsuite/);
  assert.equal(spawnSync(process.execPath, [cli], { cwd: d, encoding: 'utf8' }).status, 2);
});
