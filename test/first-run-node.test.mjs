import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetsFloor, NODE_FLOOR } from '../lib/node-floor.mjs';
import { sampleShutdown, startSample, startScheduler } from '../serve.mjs';
import { makeSample } from '../examples/make-sample.mjs';

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('meetsFloor: 22.13 is the floor', () => {
  assert.equal(NODE_FLOOR, '22.13.0');
  for (const v of ['22.13.0', 'v22.13.1', '22.14.0', '23.0.0', '24.18.0']) assert.equal(meetsFloor(v), true, v);
  for (const v of ['22.12.9', '22.5.1', '20.18.0', 'v18.0.0']) assert.equal(meetsFloor(v), false, v);
});

test('serve.mjs and scan.mjs check the Node version before anything else; db.mjs has no static node:sqlite import', () => {
  for (const f of ['serve.mjs', 'scan.mjs']) {
    const firstImport = src(f).split(/\r?\n/).find((l) => l.startsWith('import '));
    assert.match(firstImport, /^import '\.\/lib\/node-floor\.mjs';/, f);
  }
  assert.ok(!/^import .*node:sqlite/m.test(src('lib/db.mjs')));
});

test('the scheduler runs scans with this Node (process.execPath), not "node" from PATH', async () => {
  const home = mkdtempSync(join(tmpdir(), 'overmap-sched-'));
  mkdirSync(join(home, 'data'));
  const calls = [];
  const s = startScheduler({ home }, { run: async (exe, args) => { calls.push({ exe, args }); }, setIntervalFn: () => null, setTimeoutFn: () => null });
  try {
    await s.scan(false);
    assert.equal(calls[0].exe, process.execPath);
    assert.equal(calls[0].args[0], 'scan.mjs');
  } finally { s.stop(); rmSync(home, { recursive: true, force: true }); }
});

test('make-sample commits without signing, user hooks or verify hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overmap-sample-git-'));
  const commits = [];
  const runSync = (cmd, args, opts) => {
    if (args.includes('commit')) commits.push(args);
    return execFileSync(cmd, args, opts);
  };
  try {
    await makeSample(dir, { runSync });
    assert.ok(commits.length > 0);
    for (const args of commits) {
      const pairs = args.join(' ');
      assert.ok(pairs.includes('-c commit.gpgsign=false'), pairs);
      assert.ok(args.includes('core.hooksPath='), pairs);
      assert.ok(args.includes('--no-verify'), pairs);
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
});

test('sampleShutdown closes the server, removes the sample folder and exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overmap-sample-stop-'));
  writeFileSync(join(dir, 'x.txt'), 'x');
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let closed = false;
  server.on('close', () => { closed = true; });
  const exited = new Promise((resolve) => {
    const stop = sampleShutdown({ server, dir, exit: resolve });
    stop();
    stop(); // a second signal is ignored
  });
  assert.equal(await exited, 0);
  assert.equal(closed, true);
  assert.equal(existsSync(dir), false);
});

test('startSample: a stop signal (SIGINT, SIGTERM; a test event here) closes the server and its db and removes the sample folder', async () => {
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let server;
  try {
    let exitCode;
    const exited = new Promise((resolve) => { exitCode = resolve; });
    server = await startSample({ port: 0, noSchedule: true, signals: ['overmap-test-stop'], exit: exitCode });
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    const dir = lines.map((l) => l.match(/sample workspace in (.+)/)?.[1]).find(Boolean);
    assert.ok(dir && existsSync(dir));
    let closed = false;
    server.on('close', () => { closed = true; });
    process.emit('overmap-test-stop');
    assert.equal(await exited, 0);
    assert.equal(closed, true);
    assert.equal(existsSync(dir), false);
    // The db file was closed: the folder could be removed, which Windows refuses while it is open.
  } finally {
    console.log = log;
    if (server?.listening) server.close();
  }
});
