import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { createApp } from '../serve.mjs';
import { runConnector } from '../lib/connector.mjs';

const NOMINAL = 45873;
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'x@example.com', port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };
const HOUR = 3_600_000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();

async function withApp(seed, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-ev-'));
  const dbFile = join(dir, 'data', 'overmap.db');
  const db = openDb(dbFile);
  seed(db);
  db.close();
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'projects.json'), '{"projects":[]}');
  const paths = { dbFile: join(dir, 'data', 'overmap.db') };
  const server = createApp({ ...config, home: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${NOMINAL}` } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    }).on('error', reject);
  });
  try { await fn(get); } finally { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); }
}

let n = 0;
const ev = (db, project, kind, agoMs, title = 't', ingestedAgoMs = agoMs) => db.prepare('INSERT INTO events(project, source, kind, at, title, url, json, external_id, ingested_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(project, 's', kind, iso(agoMs), title, null, '{}', `e${n++}`, iso(ingestedAgoMs));

test('events: missing since = last 24 h, newest first', async () => {
  await withApp((db) => { ev(db, 'A', 'message', HOUR, 'new'); ev(db, 'A', 'order', 30 * HOUR, 'old'); ev(db, 'B', 'deploy', 2 * HOUR, 'mid'); }, async (get) => {
    const r = await get('/api/events');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((e) => e.title), ['new', 'mid']);
  });
});

test('events: since older than 7 days is clamped to 7 days', async () => {
  await withApp((db) => { ev(db, 'A', 'message', 6 * 24 * HOUR, 'six'); ev(db, 'A', 'message', 8 * 24 * HOUR, 'eight'); }, async (get) => {
    const r = await get('/api/events?since=2026-01-01T00:00:00Z');
    assert.deepEqual(r.body.map((e) => e.title), ['six']);
    const bad = await get('/api/events?since=nonsense');
    assert.equal(bad.status, 400);
  });
});

test('events: a recent since narrows, limit defaults to 200 and is capped at 500', async () => {
  await withApp((db) => { for (let i = 0; i < 520; i++) ev(db, 'A', 'message', 60_000 + i * 1000, `m${i}`); ev(db, 'A', 'order', 5 * 3600_000, 'five'); }, async (get) => {
    assert.equal((await get('/api/events')).body.length, 200);
    assert.equal((await get('/api/events?limit=9999')).body.length, 500);
    assert.equal((await get('/api/events?limit=3')).body.length, 3);
    const recent = await get('/api/events?since=' + encodeURIComponent(iso(4 * HOUR)) + '&limit=500');
    assert.ok(!recent.body.some((e) => e.title === 'five'));
  });
});

test('events: kinds filter validates against the known kinds', async () => {
  await withApp((db) => { ev(db, 'A', 'message', HOUR, 'm'); ev(db, 'A', 'order', HOUR, 'o'); ev(db, 'A', 'error', HOUR, 'e'); }, async (get) => {
    const r = await get('/api/events?kinds=message,error');
    assert.deepEqual(r.body.map((e) => e.title).sort(), ['e', 'm']);
    assert.equal((await get('/api/events?kinds=message,bogus')).status, 400);
    assert.equal((await get('/api/events?kinds=')).status, 400);
  });
});

test('events: before pages strictly older events; project filter still works', async () => {
  await withApp((db) => { ev(db, 'A', 'message', HOUR, 'a1'); ev(db, 'B', 'message', 2 * HOUR, 'b1'); ev(db, 'A', 'message', 3 * HOUR, 'a2'); }, async (get) => {
    const all = await get('/api/events');
    const second = all.body[1].at;
    const r = await get('/api/events?before=' + encodeURIComponent(second));
    assert.deepEqual(r.body.map((e) => e.title), ['a2']);
    assert.deepEqual((await get('/api/events?id=A')).body.map((e) => e.title), ['a1', 'a2']);
    assert.equal((await get('/api/events?before=zzz')).status, 400);
  });
});

test('facts/health: one row per project from source health, key health.status', async () => {
  await withApp((db) => {
    const f = db.prepare('INSERT INTO facts(project, source, key, at, status, json) VALUES (?,?,?,?,?,?)');
    f.run('A', 'health', 'health.status', '2026-10-31T10:00:00Z', 'ok', '"up"');
    f.run('B', 'health', 'health.status', '2026-10-31T10:01:00Z', 'ok', '"down"');
    f.run('B', 'health', 'health.ms', '2026-10-31T10:01:00Z', 'ok', '120');
    f.run('C', 'gsc', 'x', '2026-10-31T10:01:00Z', 'ok', '1');
    f.run('D', 'health', 'health.status', '2026-10-31T10:02:00Z', 'error', '"boom"');
  }, async (get) => {
    const r = await get('/api/facts/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      A: { status: 'up', at: '2026-10-31T10:00:00Z' },
      B: { status: 'down', at: '2026-10-31T10:01:00Z' },
    });
  });
});

test('events: sinceIngested counts a row with old at but fresh ingested_at; since does not', async () => {
  await withApp((db) => { ev(db, 'A', 'deploy', 3 * 24 * HOUR, 'late-arrival', 10 * 60_000); ev(db, 'A', 'message', 5 * HOUR, 'older'); }, async (get) => {
    const s = iso(HOUR);
    assert.deepEqual((await get('/api/events?since=' + encodeURIComponent(s))).body.map((e) => e.title), []);
    assert.deepEqual((await get('/api/events?sinceIngested=' + encodeURIComponent(s))).body.map((e) => e.title), ['late-arrival']);
    assert.equal((await get('/api/events?sinceIngested=nonsense')).status, 400);
    assert.deepEqual((await get('/api/events')).body.map((e) => e.title), ['older']);
    assert.equal((await get('/api/events?sinceIngested=2026-01-01T00:00:00Z')).body.length, 2);
  });
});

test('events: json is returned', async () => {
  await withApp((db) => { ev(db, 'A', 'deploy', HOUR, 'production ERROR'); }, async (get) => {
    assert.equal((await get('/api/events')).body[0].json, '{}');
  });
});

test('events: (at, id) cursor pages three events sharing one timestamp with no skip or duplicate', async () => {
  await withApp((db) => {
    const at = iso(HOUR);
    for (const t of ['x1', 'x2', 'x3']) db.prepare('INSERT INTO events(project, source, kind, at, title, url, json, external_id, ingested_at) VALUES (?,?,?,?,?,?,?,?,?)').run('A', 's', 'message', at, t, null, '{}', t, at);
    ev(db, 'A', 'message', 2 * HOUR, 'older');
  }, async (get) => {
    const p1 = (await get('/api/events?limit=2')).body;
    assert.deepEqual(p1.map((e) => e.title), ['x3', 'x2']);
    const last = p1[1];
    const p2 = (await get(`/api/events?limit=2&before=${encodeURIComponent(last.at)}&beforeId=${last.id}`)).body;
    assert.deepEqual(p2.map((e) => e.title), ['x1', 'older']);
    assert.equal((await get('/api/events?beforeId=3')).status, 400);
    assert.equal((await get(`/api/events?before=${encodeURIComponent(last.at)}&beforeId=abc`)).status, 400);
  });
});

test('events: duplicate kinds are tolerated', async () => {
  await withApp((db) => { ev(db, 'A', 'message', HOUR, 'm'); }, async (get) => {
    assert.equal((await get('/api/events?kinds=message,message')).body.length, 1);
  });
});

test('ingested_at: kept when a re-pull is unchanged, refreshed when title or json changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-ing-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    let title = 'one';
    const conn = { id: 'stub', every: '5m', secrets: [], targets: () => [], fetch: async () => ({}), parse: () => ({ facts: [], series: [], events: [{ kind: 'deploy', at: '2026-10-31T09:00:00Z', title, external_id: 'k1', json: { state: 'READY' } }] }) };
    const run = (t) => runConnector(conn, { project: 'A' }, { getSecret: () => undefined, now: () => Date.parse(t) }, db);
    await run('2026-10-31T10:00:00Z');
    await run('2026-10-31T11:00:00Z');
    assert.equal(db.prepare('SELECT ingested_at FROM events').get().ingested_at, '2026-10-31T10:00:00.000Z');
    title = 'two';
    await run('2026-10-31T12:00:00Z');
    assert.equal(db.prepare('SELECT ingested_at FROM events').get().ingested_at, '2026-10-31T12:00:00.000Z');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('facts/health marks stale rows', async () => {
  await withApp((db) => {
    db.prepare('INSERT INTO facts(project, source, key, at, status, json) VALUES (?,?,?,?,?,?)').run('A', 'health', 'health.status', '2026-10-31T10:00:00Z', 'stale', '"up"');
  }, async (get) => {
    assert.deepEqual((await get('/api/facts/health')).body, { A: { status: 'up', at: '2026-10-31T10:00:00Z', stale: true } });
  });
});
