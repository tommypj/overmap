import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { runConnector, sanitiseError } from '../lib/connector.mjs';
import { fetchJson, HttpError } from '../lib/http.mjs';
import health from '../connectors/health.mjs';
import { createApp, startConnectorScheduler } from '../serve.mjs';

const NOW = Date.parse('2026-10-31T10:00:00Z');
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-fix1-'));
  const db = openDb(join(dir, 'c.db'));
  return { dir, db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const stub = (over = {}) => ({
  id: 'stub', every: '5m', secrets: [], required: [], targets: () => [], fetch: async () => ({}),
  parse: () => ({ facts: [{ key: 'a', value: 1 }], series: [{ metric: 'm', day: '2026-10-30', value: 3 }], events: [] }),
  ...over,
});
const ctx = (extra = {}) => ({ getSecret: () => undefined, fetchJson, now: () => NOW, ...extra });

// ---- 1. generic masking of stored strings ----
test('a health probe whose fetch throws a credentialed URL stores a reason without the password', async () => {
  const { db, done } = tmpDb();
  try {
    const c = ctx({ fetchJson: async () => { throw new Error('Request cannot be constructed from a URL that includes credentials: https://u:pw123456@x/y'); } });
    const r = await runConnector(health, { project: 'A', url: 'https://x/y' }, c, db);
    assert.equal(r.status, 'ok');
    const reason = JSON.parse(db.prepare("SELECT json FROM facts WHERE key = 'health.reason'").get().json);
    assert.ok(!reason.includes('pw123456'), reason);
    assert.match(reason, /down|credentials/);
  } finally { done(); }
});

test('event titles and any *.error fact string are masked before storage', async () => {
  const { db, done } = tmpDb();
  try {
    const c = stub({ secrets: ['TOK'], parse: () => ({
      facts: [{ key: 'sync.error', value: 'failed with Bearer abcd1234efgh' }],
      series: [],
      events: [{ kind: 'k', at: '2026-10-30T00:00:00Z', title: 'leak zzSECRETVALUE99', url: null, external_id: 'e' }],
    }) });
    await runConnector(c, { project: 'P' }, ctx({ getSecret: () => 'zzSECRETVALUE99' }), db);
    const all = JSON.stringify([db.prepare('SELECT * FROM facts').all(), db.prepare('SELECT * FROM events').all()]);
    assert.ok(!all.includes('abcd1234efgh'));
    assert.ok(!all.includes('zzSECRETVALUE99'));
  } finally { done(); }
});

// ---- 2. sanitiseError shapes ----
test('sanitiseError masks every secret shape', () => {
  const cases = {
    bearer: 'x bearer abc123def456 y',
    basic: 'Authorization: BASIC dXNlcjpwYXNz',
    query: 'GET /x?foo=1&api_key=SUPERSECRETKEY&b=2',
    query2: 'https://h/p?token=TOPSECRET123',
    userinfo: 'fetch https://user:hunter22@example.com/path failed',
    google: 'token ya29.a0AfH6SMBxyz-123_456',
    refresh: 'refresh 1//0gAbCdEf-GhIj',
    sentry: 'key sntrys_eyABCDEF12345 and sntryu_abc123def',
    jwt: 'jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', // privacy-ok
  };
  const secrets = ['SUPERSECRETKEY', 'TOPSECRET123', 'hunter22', 'ya29.a0AfH6SMBxyz-123_456', '1//0gAbCdEf-GhIj', 'abc123def456', 'dXNlcjpwYXNz', 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', 'sntrys_eyABCDEF12345', 'sntryu_abc123def']; // privacy-ok
  for (const [name, text] of Object.entries(cases)) {
    const out = sanitiseError(text);
    for (const s of secrets) assert.ok(!out.includes(s), `${name}: ${out}`);
    assert.ok(out.includes('\u2039secret\u203A'), `${name}: ${out}`);
  }
});

test('sanitiseError masks a truncated echo of a long literal secret (first 12 chars)', () => {
  const out = sanitiseError('upstream said key abcd1234efgh was bad', ['abcd1234efghmnopqrstuvwxyz']);
  assert.ok(!out.includes('abcd1234efgh'), out);
});

test('HttpError masks the body BEFORE cutting it to 200 chars', async () => {
  const body = 'x'.repeat(190) + ' Bearer ABCDEFGHIJKLMNOP';
  await assert.rejects(
    fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: async () => new Response(body, { status: 500 }) }),
    (e) => e instanceof HttpError && !e.bodySnippet.includes('ABCDEF') && !e.message.includes('ABCDEF') && !/Bearer\s+A/.test(e.message),
  );
});

// ---- 3. per-run timeout ----
test('a never-resolving fetch times out the run as error (returns, so the scheduler guard is released)', async () => {
  const { db, done } = tmpDb();
  try {
    const r = await runConnector(stub({ fetch: () => new Promise(() => {}) }), { project: 'P' }, ctx({ timeoutMs: 50 }), db);
    assert.equal(r.status, 'error');
    assert.match(r.error, /timed out/);
  } finally { done(); }
});

// ---- 5. stale on not_configured ----
test('not_configured marks the existing facts stale (kept) and records the run', async () => {
  const { db, done } = tmpDb();
  try {
    await runConnector(stub(), { project: 'P' }, ctx(), db);
    const need = stub({ required: ['url'] });
    const r = await runConnector(need, { project: 'P', url: null }, ctx(), db);
    assert.equal(r.status, 'not_configured');
    const f = db.prepare('SELECT status, json FROM facts').get();
    assert.equal(f.status, 'stale');
    assert.equal(f.json, '1');
    assert.equal(db.prepare('SELECT status FROM connector_runs').get().status, 'not_configured');
  } finally { done(); }
});

// ---- 7. rollback after BEGIN ----
test('a throw after BEGIN (series statement fails) rolls back to just the _error row', async () => {
  const { db, done } = tmpDb();
  try {
    const flaky = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (/INTO series/.test(sql)) throw new Error('disk exploded');
        return db.prepare(sql);
      },
    };
    const r = await runConnector(stub(), { project: 'P' }, ctx(), flaky);
    assert.equal(r.status, 'error');
    assert.match(r.error, /disk exploded/);
    assert.deepEqual(db.prepare('SELECT key FROM facts').all().map((x) => x.key), ['_error']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  } finally { done(); }
});

// ---- 8. unknown cadence ----
test('an unknown cadence is logged and not scheduled', () => {
  const timeouts = [];
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    const s = startConnectorScheduler({ home: 'no-such-home' }, {
      connectors: [stub({ id: 'odd', every: '3h' }), stub({ id: 'fine' })], db: {},
      setTimeoutFn: (fn, ms) => { timeouts.push(ms); return { unref() {} }; }, setIntervalFn: () => ({ unref() {} }),
    });
    s.stop();
  } finally { console.error = orig; }
  assert.deepEqual(errs, ['connector odd: unknown cadence 3h, skipped']);
  assert.equal(timeouts.length, 1);
});

// ---- 10. http rules ----
test('fetchJson: non-http schemes rejected, host compared lowercased, oversized body rejected', async () => {
  await assert.rejects(fetchJson('file:///etc/passwd', { allowHosts: [''], fetchImpl: async () => new Response('x') }), /scheme not allowed/);
  await assert.rejects(fetchJson('ftp://a.example/x', { allowHosts: ['a.example'], fetchImpl: async () => new Response('x') }), /scheme not allowed/);
  const ok = await fetchJson('https://A.Example/x', { allowHosts: ['A.EXAMPLE'], fetchImpl: async () => new Response('{}') });
  assert.equal(ok.status, 200);
  const big = 'x'.repeat(5 * 1024 * 1024 + 1);
  await assert.rejects(fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: async () => new Response(big) }), (e) => e instanceof HttpError && /too large/.test(e.message));
});

// ---- 11. event at normalised ----
test('event at is normalised to ISO; an unparseable at is a parse error with no writes', async () => {
  const { db, done } = tmpDb();
  try {
    const ev = (at) => stub({ parse: () => ({ facts: [], series: [], events: [{ kind: 'k', at, title: 't', url: null, external_id: 'e' }] }) });
    await runConnector(ev('2026-10-30T12:00:00+02:00'), { project: 'P' }, ctx(), db);
    assert.equal(db.prepare('SELECT at FROM events').get().at, '2026-10-30T10:00:00.000Z');
    const r = await runConnector(ev('not a date'), { project: 'Q' }, ctx(), db);
    assert.equal(r.status, 'error');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE project = 'Q'").get().n, 0);
  } finally { done(); }
});

// ---- API: 4, 9, 11 ----
const NOMINAL = 45873;
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'x@example.com', port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };
async function withApp(extra, fn, registry) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-fix1api-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry ?? { version: 1, projects: {} }));
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
  try { await fn({ get, paths }); } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp cleanup */ }
  }
}

test('discover that throws gives 502 with a masked message', async () => {
  const bad = { ...health, id: 'bad', discover: async () => { throw new Error('boom Bearer ZZZTOPSECRET99'); } };
  await withApp({ connectors: [bad] }, async ({ get }) => {
    const r = await get('/api/connectors/discover?id=bad');
    assert.equal(r.status, 502);
    assert.ok(!r.body.includes('ZZZTOPSECRET99'));
    assert.match(r.body, /boom/);
  });
});

test('/api/events rejects since outside 1970-2100', async () => {
  await withApp({}, async ({ get }) => {
    assert.equal((await get('/api/events?since=1969-12-31T00:00:00Z')).status, 400);
    assert.equal((await get('/api/events?since=2101-01-01T00:00:00Z')).status, 400);
    assert.equal((await get('/api/events?since=2026-01-01T00:00:00Z')).status, 200);
  });
});

test('registry entries with health.url null appear as not_configured with the missing field, and stale facts are flagged', async () => {
  await withApp({}, async ({ get, paths }) => {
    const r = JSON.parse((await get('/api/connectors')).body);
    assert.deepEqual(r[0].projects[0], { project: 'T', status: 'not_configured', at: null, error: null, missing: ['connectors.health.url'] });
    const db = openDb(paths.dbFile);
    db.prepare("INSERT INTO facts(project, source, key, at, status, json) VALUES ('T','health','health.status','2026-10-30T00:00:00Z','stale','\"up\"')").run();
    db.close();
    const f = JSON.parse((await get('/api/facts?id=T')).body);
    assert.deepEqual(f.health['health.status'], { at: '2026-10-30T00:00:00Z', value: 'up', stale: true });
  }, { version: 1, projects: { T: { home: '/zz-t', connectors: { health: { url: null } } } } });
});
