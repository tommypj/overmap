import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { runConnector } from '../lib/connector.mjs';
import { fetchJson } from '../lib/http.mjs';
import health from '../connectors/health.mjs';
import { createApp, startConnectorScheduler } from '../serve.mjs';

const NOW = Date.parse('2026-10-31T10:00:00Z');
const regMap = (o) => new Map(Object.entries(o).map(([id, connectors]) => [id, { id, connectors }]));
const tick = () => new Promise((r) => setImmediate(r));

test('health targets: one per registry entry with connectors.health; null url is kept', () => {
  const t = health.targets(regMap({ A: { health: { url: 'https://a.example/h' } }, B: {}, C: { health: { url: null } } }));
  assert.deepEqual(t, [{ project: 'A', url: 'https://a.example/h' }, { project: 'C', url: null }]);
});

function ctxFor(fetchImpl) {
  return { getSecret: () => undefined, fetchJson: (u, o = {}) => fetchJson(u, { ...o, fetchImpl }), now: () => NOW };
}
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-live-'));
  const db = openDb(join(dir, 'c.db'));
  return { dir, db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('health: up writes status, ms and a series row; a later faster hit keeps the day max', async () => {
  const { db, done } = tmpDb();
  try {
    const target = { project: 'A', url: 'https://a.example/h' };
    const r = await runConnector(health, target, ctxFor(async () => new Response('{"ok":true}')), db);
    assert.equal(r.status, 'ok');
    const f = Object.fromEntries(db.prepare('SELECT key, json FROM facts').all().map((x) => [x.key, JSON.parse(x.json)]));
    assert.equal(f['health.status'], 'up');
    assert.equal(typeof f['health.ms'], 'number');
    assert.equal(f['health.reason'], null);
    const s = db.prepare('SELECT * FROM series').all();
    assert.equal(s.length, 1);
    assert.equal(s[0].day, '2026-10-31');
    db.prepare('UPDATE series SET value = 9999').run();
    await runConnector(health, target, ctxFor(async () => new Response('{}')), db);
    assert.equal(db.prepare('SELECT value FROM series').get().value, 9999);
  } finally { done(); }
});

test('health: a 503 or a thrown fetch is a down VALUE, the run is ok, reason stored', async () => {
  const { db, done } = tmpDb();
  try {
    const target = { project: 'A', url: 'https://a.example/h' };
    const r1 = await runConnector(health, target, ctxFor(async () => new Response('unhealthy', { status: 503 })), db);
    assert.equal(r1.status, 'ok');
    const get = (k) => JSON.parse(db.prepare('SELECT json FROM facts WHERE key = ?').get(k).json);
    assert.equal(get('health.status'), 'down');
    assert.match(get('health.reason'), /HTTP 503/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series').get().n, 0);
    const r2 = await runConnector(health, target, ctxFor(async () => { throw new Error('ECONNREFUSED'); }), db);
    assert.equal(r2.status, 'ok');
    assert.match(get('health.reason'), /ECONNREFUSED/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '_error'").get().n, 0);
  } finally { done(); }
});

test('health: a null url is not_configured with the registry field named', async () => {
  const { db, done } = tmpDb();
  try {
    const r = await runConnector(health, { project: 'C', url: null }, ctxFor(async () => new Response('{}')), db);
    assert.equal(r.status, 'not_configured');
    assert.deepEqual(r.missing, ['connectors.health.url']);
  } finally { done(); }
});

test('scheduler: first run at 60 s, 5 s apart, no overlap, targets run serially', async () => {
  const { dir, db, done } = tmpDb();
  try {
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, projects: {
      A: { home: '/zz-a', connectors: { health: { url: 'https://a.example/h' } } },
      B: { home: '/zz-b', connectors: { health: { url: 'https://b.example/h' } } },
    } }));
    const timeouts = [];
    const intervals = [];
    const pending = [];
    const fetchImpl = (u) => new Promise((r) => { pending.push(() => r({ status: 200, json: {}, text: '{}' })); void u; });
    const s = startConnectorScheduler({ home: dir }, {
      connectors: [health, { ...health, id: 'second' }], db, fetchJsonImpl: fetchImpl,
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; },
      setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
      now: () => NOW,
    });
    assert.deepEqual(timeouts.map((t) => t.ms), [60000, 65000]);
    timeouts[0].fn();
    assert.deepEqual(intervals.map((i) => i.ms), [300000]);
    await tick();
    assert.equal(s.isRunning('health'), true);
    await s.tick(health); // overlap: ignored
    assert.equal(pending.length, 1); // serial: target B has not started
    pending[0]();
    for (let i = 0; i < 50 && pending.length < 2; i++) await tick();
    assert.equal(pending.length, 2);
    pending[1]();
    for (let i = 0; i < 50 && s.isRunning('health'); i++) await tick();
    assert.equal(s.isRunning('health'), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connector_runs WHERE connector='health'").get().n, 2);
    s.stop();
  } finally { done(); }
});

// ---- HTTP API ----
const NOMINAL = 45872;
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'x@example.com', port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };

async function withApp(extra, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-api-'));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, projects: {
    A: { home: '/zz-a', connectors: { health: { url: 'https://a.example/h' } } },
    C: { home: '/zz-c', connectors: { health: { url: null } } },
  } }));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'projects.json'), JSON.stringify({ generatedAt: '2026-10-31T10:00:00Z', projects: [] }));
  const paths = { dbFile: join(dir, 'data', 'overmap.db') };
  const server = createApp({ ...config, home: dir }, process.env, extra);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${NOMINAL}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  try { await fn({ get, dir, paths }); } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir cleanup only */ }
  }
}

test('/api/connectors works before any run: not_configured computed live, else never_ran', async () => {
  await withApp({}, async ({ get }) => {
    const r = await get('/api/connectors');
    assert.equal(r.status, 200);
    const [h] = JSON.parse(r.body);
    assert.equal(h.id, 'health');
    assert.deepEqual(h.projects.find((p) => p.project === 'A'), { project: 'A', status: 'never_ran', at: null, error: null, missing: [] });
    assert.deepEqual(h.projects.find((p) => p.project === 'C').missing, ['connectors.health.url']);
  });
});

test('facts, series, events serve what a run wrote, with no secret in sight', async () => {
  await withApp({}, async ({ get, paths }) => {
    const db = openDb(paths.dbFile);
    const conn = {
      id: 'stub', every: '5m', secrets: ['TOK'], required: [], targets: () => [{ project: 'A' }],
      fetch: async () => { throw new Error('echo Authorization: Bearer pcp_board_abc12345'); }, parse: () => ({}), // privacy-ok
    };
    const ctx = { getSecret: () => 'tok-secretvalue', fetchJson, now: () => Date.now() };
    await runConnector(conn, { project: 'A' }, ctx, db);
    await runConnector({ ...conn, id: 'good', fetch: async () => ({}), parse: () => ({
      facts: [{ key: 'n', value: 5 }],
      series: [{ metric: 'm', day: new Date().toISOString().slice(0, 10), value: 2 }],
      events: [{ kind: 'k', at: new Date(Date.now() - 3600_000).toISOString(), title: 'hello', url: 'https://x', external_id: 'e1' }],
    }) }, { project: 'A' }, ctx, db);
    db.close();
    const facts = JSON.parse((await get('/api/facts?id=A')).body);
    assert.equal(facts.good.n.value, 5);
    assert.match(facts.stub._error.error, /secret/);
    const everything = [await get('/api/facts?id=A'), await get('/api/connectors')].map((r) => r.body).join('');
    assert.ok(!everything.includes('abc12345'));
    assert.ok(!everything.includes('tok-secretvalue'));
    assert.deepEqual(JSON.parse((await get('/api/series?id=A&metric=m&days=30')).body).map((x) => x.value), [2]);
    const ev = JSON.parse((await get('/api/events?id=A&since=2020-01-01T00:00:00Z')).body);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].title, 'hello');
    assert.equal(JSON.parse((await get('/api/events')).body).length, 1);
    assert.equal((await get('/api/events?since=nonsense')).status, 400);
    assert.equal((await get('/api/facts')).status, 400);
  });
});

test('/api/events is bounded to 500 rows, newest first', async () => {
  // Pin the clock: the default window is "last 24 h" and the rows below sit at NOW.
  await withApp({ now: () => NOW + 3_600_000 }, async ({ get, paths }) => {
    const db = openDb(paths.dbFile);
    const ins = db.prepare('INSERT INTO events(project, source, kind, at, title, url, json, external_id) VALUES (?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < 600; i++) ins.run('A', 's', 'k', new Date(NOW + i * 1000).toISOString(), `t${i}`, null, null, `e${i}`);
    db.exec('COMMIT');
    db.close();
    assert.equal(JSON.parse((await get('/api/events?id=A&limit=9999')).body).length, 500);
    assert.equal(JSON.parse((await get('/api/events?id=A&limit=1')).body)[0].title, 't599');
  });
});

test('/api/connectors/discover: 404 without discover, calls it when present', async () => {
  const withDiscover = { ...health, id: 'disc', discover: async (ctx) => ({ ok: typeof ctx.getSecret === 'function' }) };
  await withApp({ connectors: [health, withDiscover] }, async ({ get }) => {
    const none = await get('/api/connectors/discover?id=health');
    assert.equal(none.status, 404);
    assert.match(none.body, /no discovery/);
    const ok = await get('/api/connectors/discover?id=disc');
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true });
    assert.equal((await get('/api/connectors/discover?id=nope')).status, 404);
  });
});
