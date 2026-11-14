import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../server/router.mjs';
import { createActionRoutes } from '../server/actions.mjs';
import { createTokens } from '../lib/csrf.mjs';
import { openDb } from '../lib/db.mjs';
import { listAudit } from '../lib/audit.mjs';

const EXE = '/fake/bin/graphify';

// A child that emits its output on the next tick, then closes with `code` (unless close is false).
// kill() flags the child and closes it on the next tick, as a real process would.
function fakeSpawn(chunks, { calls = [], close = true, code = 0 } = {}) {
  return (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    calls.push({ exe, args, opts, child });
    setImmediate(() => {
      for (const c of chunks) child.stdout.emit('data', c);
      if (close) child.emit('close', code);
    });
    return child;
  };
}

function setup({ which = () => EXE, spawn = () => { throw new Error('spawn must not run'); }, timeoutMs, projects, command = 'graphify' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-graph-'));
  const db = openDb(join(dir, 'overmap.db'));
  const home = join(dir, 'demo');
  const list = projects ?? [{ id: 'demo', name: 'Demo', home, graph: { value: { nodeCount: 3 } } }];
  const routes = createActionRoutes({
    getDb: () => db, getRegistry: () => new Map(), tokens: createTokens(), who: () => ({ class: 'laptop', login: '' }),
    askGraph: { which, spawn, command, timeoutMs, readProjects: () => ({ projects: list }) },
  });
  return { dir, db, home, routes };
}

async function withServer(s, fn) {
  const config = { allowedLogin: 'me@example.com', proxyHost: 'host.tail0000.ts.net' }; // privacy-ok
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ config, port, routes: s.routes }));
  const origin = { origin: `http://127.0.0.1:${port}` };
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: origin })).json();
  const post = async (body, headers = origin) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/actions/ask-graph`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const csrf = async () => (await get('/api/csrf')).token;
  try { await fn({ post, csrf, port }); } finally { server.closeAllConnections?.(); server.close(); }
}

const cleanup = (s) => { try { s.db.close(); } catch { /* closed */ } rmSync(s.dir, { recursive: true, force: true }); };
const lastAudit = (s) => listAudit(s.db, { limit: 1 })[0];
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('condition not met in time');
}
const SHIM_MSG = 'graphify not found (.cmd/.bat shims are not supported; install an .exe)';

test('ask-graph: 409 when graphify is missing, nothing spawned, audited refused', async () => {
  const s = setup({ which: () => null });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'what is here?', csrf: await csrf() });
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'graphify not found' });
      const row = lastAudit(s);
      assert.equal(row.action, 'ask-graph');
      assert.equal(row.status, 'refused');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a .cmd shim on PATH is refused with 409 and the shim message, nothing spawned', async () => {
  const s = setup({ which: (cmd, o = {}) => (o.allowShims ? '/x/bin/graphify.cmd' : null) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'what is here?', csrf: await csrf() });
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: SHIM_MSG });
      assert.equal(lastAudit(s).status, 'refused');
    });
  } finally { cleanup(s); }
});

test('ask-graph: an explicit .bat graphifyCommand is refused with 409 before any lookup', async () => {
  const calls = [];
  const s = setup({ command: 'graphify.bat', which: () => { calls.push('which'); return EXE; }, spawn: fakeSpawn([], { calls }) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'hi', csrf: await csrf() });
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: SHIM_MSG });
      assert.deepEqual(calls, []);
      assert.equal(lastAudit(s).status, 'refused');
    });
  } finally { cleanup(s); }
});

test('ask-graph: runs the command with argv and cwd, caps and masks output, kills the child at the cap', async () => {
  const calls = [];
  const big = 'x'.repeat(70 * 1024);
  const s = setup({ spawn: fakeSpawn([Buffer.from(`Answer. Bearer t0k3n-fixture-8731 ${big}`)], { calls }) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'what is here?', csrf: await csrf() });
      assert.equal(r.status, 200);
      assert.equal(r.json.truncated, true);
      assert.equal(r.json.exitCode, null);
      assert.equal(typeof r.json.ms, 'number');
      assert.ok(Buffer.byteLength(r.json.answer) <= 64 * 1024);
      assert.ok(!r.json.answer.includes('t0k3n-fixture-8731'));
      assert.match(r.json.answer, /Answer\./);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].exe, EXE);
      assert.deepEqual(calls[0].args, ['query', 'what is here?']);
      assert.equal(calls[0].opts.cwd, s.home);
      assert.equal(calls[0].opts.shell, false);
      assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(calls[0].opts.windowsHide, true);
      assert.equal(calls[0].child.killed, true);
      const row = lastAudit(s);
      assert.equal(row.status, 'ok');
      assert.equal(row.project, 'demo');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a child killed at the cap reports exitCode null, not the platform kill code', async () => {
  // A child that keeps running until killed, then closes with code 1 (what Windows reports for a kill).
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1)); };
    setImmediate(() => child.stdout.emit('data', Buffer.from('y'.repeat(70 * 1024))));
    return child;
  };
  const s = setup({ spawn });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'big?', csrf: await csrf() });
      assert.equal(r.status, 200);
      assert.equal(r.json.truncated, true);
      assert.equal(r.json.exitCode, null);
      assert.equal(lastAudit(s).status, 'ok');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a non-zero exit answers 200 with exitCode and is audited failed', async () => {
  const s = setup({ spawn: fakeSpawn([Buffer.from('partial')], { code: 3 }) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'hi', csrf: await csrf() });
      assert.equal(r.status, 200);
      assert.equal(r.json.exitCode, 3);
      assert.equal(r.json.answer, 'partial');
      assert.equal(lastAudit(s).status, 'failed');
      assert.equal(lastAudit(s).result.exitCode, 3);
    });
  } finally { cleanup(s); }
});

test('ask-graph: rejects a bad question (including a leading dash) and an unknown or graphless project, nothing spawned', async () => {
  const calls = [];
  const s = setup({
    spawn: fakeSpawn([], { calls }),
    projects: [{ id: 'demo', home: '/x/demo', graph: { value: { nodeCount: 1 } } }, { id: 'bare', home: '/x/bare', graph: { value: null } }],
  });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const token = await csrf();
      for (const question of ['', 'a'.repeat(501), 'line one\nline two', 42, '-rf', '   --help']) {
        const r = await post({ id: 'demo', question, csrf: token });
        assert.equal(r.status, 400, JSON.stringify(question).slice(0, 20));
      }
      assert.equal(lastAudit(s).status, 'refused');
      const unknown = await post({ id: 'nope', question: 'hi', csrf: token });
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.json, { error: 'unknown project' });
      const bare = await post({ id: 'bare', question: 'hi', csrf: token });
      assert.equal(bare.status, 404);
      assert.deepEqual(bare.json, { error: 'no graph' });
      assert.equal(calls.length, 0);
      assert.equal(listAudit(s.db, { limit: 20 }).every((row) => row.status === 'refused'), true);
    });
  } finally { cleanup(s); }
});

test('ask-graph: a bad csrf token is refused before anything else', async () => {
  const calls = [];
  const s = setup({ spawn: fakeSpawn([], { calls }) });
  try {
    await withServer(s, async ({ post }) => {
      const r = await post({ id: 'demo', question: 'hi', csrf: 'nope' });
      assert.equal(r.status, 403);
      assert.equal(calls.length, 0);
      assert.equal(lastAudit(s).status, 'refused');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a run past the timeout is killed, 504, audited failed', async () => {
  const calls = [];
  const s = setup({ timeoutMs: 20, spawn: fakeSpawn([], { calls, close: false }) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'slow?', csrf: await csrf() });
      assert.equal(r.status, 504);
      assert.deepEqual(r.json, { error: 'timed out' });
      assert.equal(calls[0].child.killed, true);
      assert.equal(lastAudit(s).status, 'failed');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a spawn error is audited failed and answers 500', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('error', new Error('spawn EACCES')));
    return child;
  };
  const s = setup({ spawn });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const r = await post({ id: 'demo', question: 'hi', csrf: await csrf() });
      assert.equal(r.status, 500);
      assert.match(r.json.error, /EACCES/);
      assert.equal(lastAudit(s).status, 'failed');
    });
  } finally { cleanup(s); }
});

test('ask-graph: a third concurrent run is refused with 429 busy', async () => {
  const calls = [];
  const s = setup({ spawn: fakeSpawn([], { calls, close: false }) });
  try {
    await withServer(s, async ({ post, csrf }) => {
      const token = await csrf();
      const first = post({ id: 'demo', question: 'one', csrf: token });
      const second = post({ id: 'demo', question: 'two', csrf: token });
      await until(() => calls.length === 2);
      const third = await post({ id: 'demo', question: 'three', csrf: token });
      assert.equal(third.status, 429);
      assert.deepEqual(third.json, { error: 'busy' });
      assert.equal(lastAudit(s).status, 'refused');
      assert.equal(calls.length, 2);
      for (const c of calls) c.child.kill();
      assert.equal((await first).status, 200);
      assert.equal((await second).status, 200);
    });
  } finally { cleanup(s); }
});

test('ask-graph: a client that disconnects kills the child and is audited failed', async () => {
  const calls = [];
  const s = setup({ spawn: fakeSpawn([], { calls, close: false }) });
  try {
    await withServer(s, async ({ port, csrf }) => {
      const body = JSON.stringify({ id: 'demo', question: 'slow?', csrf: await csrf() });
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/actions/ask-graph', method: 'POST', headers: {
        origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
      rq.on('error', () => {});
      rq.end(body);
      await until(() => calls.length === 1);
      rq.destroy();
      await until(() => calls[0].child.killed);
      await until(() => lastAudit(s)?.status === 'failed');
      assert.equal(lastAudit(s).result.error, 'client closed');
    });
  } finally { cleanup(s); }
});
