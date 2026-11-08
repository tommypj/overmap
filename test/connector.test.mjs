import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { runConnector, sanitiseError } from '../lib/connector.mjs';
import { fetchJson } from '../lib/http.mjs';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-conn-'));
  const db = openDb(join(dir, 'c.db'));
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const NOW = Date.parse('2026-10-31T10:00:00Z');
const mkCtx = (secrets = {}, fetchImpl = async () => new Response('{}')) => ({
  getSecret: (n) => secrets[n],
  fetchJson: (url, o = {}) => fetchJson(url, { allowHosts: ['api.example.com'], fetchImpl, ...o }),
  now: () => NOW,
});
const stub = (over = {}) => ({
  id: 'stub', every: '5m', secrets: ['STUB_TOKEN'], required: ['url'],
  targets: () => [], fetch: async () => ({}),
  parse: () => ({ facts: [{ key: 'a', value: 1 }], series: [{ metric: 'm', day: '2026-10-30', value: 3 }], events: [{ kind: 'k', at: '2026-10-30T00:00:00Z', title: 't', url: 'u', external_id: 'e1' }] }),
  ...over,
});
const SECRETS = { STUB_TOKEN: 'tok-123456' };

test('not_configured lists the missing secret and the missing field and writes no facts', async () => {
  const { db, done } = tmp();
  try {
    const r = await runConnector(stub(), { project: 'P', url: null }, mkCtx(), db);
    assert.equal(r.status, 'not_configured');
    assert.deepEqual(r.missing, ['STUB_TOKEN', 'connectors.stub.url']);
    assert.equal(count(db, 'facts'), 0);
    assert.equal(count(db, 'series'), 0);
    assert.equal(db.prepare('SELECT status FROM connector_runs').get().status, 'not_configured');
  } finally { done(); }
});

test('an ok run writes facts, series, events and a connector_runs row', async () => {
  const { db, done } = tmp();
  try {
    const r = await runConnector(stub(), { project: 'P', url: 'https://x' }, mkCtx(SECRETS), db);
    assert.equal(r.status, 'ok');
    const f = db.prepare('SELECT * FROM facts').get();
    assert.deepEqual([f.project, f.source, f.key, f.status, f.json, f.at], ['P', 'stub', 'a', 'ok', '1', '2026-10-31T10:00:00.000Z']);
    assert.equal(count(db, 'series'), 1);
    assert.equal(count(db, 'events'), 1);
    assert.equal(db.prepare('SELECT status FROM connector_runs').get().status, 'ok');
  } finally { done(); }
});

test('a parse that throws leaves only the _error fact (transactional write)', async () => {
  const { db, done } = tmp();
  try {
    await runConnector(stub(), { project: 'P', url: 'u' }, mkCtx(SECRETS), db);
    const bad = stub({ parse: () => { throw new Error('missing field "count"'); } });
    const r = await runConnector(bad, { project: 'Q', url: 'u' }, mkCtx(SECRETS), db);
    assert.equal(r.status, 'error');
    assert.match(r.error, /missing field/);
    const q = db.prepare("SELECT * FROM facts WHERE project='Q'").all();
    assert.equal(q.length, 1);
    assert.equal(q[0].key, '_error');
    assert.equal(q[0].status, 'error');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series WHERE project='Q'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE project='Q'").get().n, 0);
  } finally { done(); }
});

test('a half-valid parse result (bad series row) writes nothing but the error', async () => {
  const { db, done } = tmp();
  try {
    const bad = stub({ parse: () => ({ facts: [{ key: 'a', value: 1 }], series: [{ metric: 'm', day: '2026-10-30', value: 'abc' }], events: [] }) });
    const r = await runConnector(bad, { project: 'P', url: 'u' }, mkCtx(SECRETS), db);
    assert.equal(r.status, 'error');
    assert.deepEqual(db.prepare('SELECT key FROM facts').all().map((x) => x.key), ['_error']);
  } finally { done(); }
});

test('a failure inside the write transaction rolls everything back', async () => {
  const { db, done } = tmp();
  try {
    // second event is invalid for the NOT-NULL-free schema? force a throw with a circular json value
    const circ = {}; circ.self = circ;
    const bad = stub({ parse: () => ({ facts: [{ key: 'a', value: 1 }], series: [{ metric: 'm', day: '2026-10-30', value: 2 }], events: [{ kind: 'k', at: 'x', title: 't', url: 'u', external_id: 'e', json: circ }] }) });
    const r = await runConnector(bad, { project: 'P', url: 'u' }, mkCtx(SECRETS), db);
    assert.equal(r.status, 'error');
    assert.deepEqual(db.prepare('SELECT key FROM facts').all().map((x) => x.key), ['_error']);
    assert.equal(count(db, 'series'), 0);
    assert.equal(count(db, 'events'), 0);
  } finally { done(); }
});

test('a later ok run clears the old _error fact', async () => {
  const { db, done } = tmp();
  try {
    const ctx = mkCtx(SECRETS);
    await runConnector(stub({ parse: () => { throw new Error('x'); } }), { project: 'P', url: 'u' }, ctx, db);
    await runConnector(stub(), { project: 'P', url: 'u' }, ctx, db);
    assert.deepEqual(db.prepare('SELECT key FROM facts').all().map((x) => x.key), ['a']);
  } finally { done(); }
});

test('an error message containing a bearer token is stored masked', async () => {
  const { db, done } = tmp();
  try {
    const leaky = stub({ fetch: async () => { throw new Error('proxy echoed Authorization: Bearer pcp_board_abc12345 oops'); } }); // privacy-ok
    const r = await runConnector(leaky, { project: 'P', url: 'u' }, mkCtx(SECRETS), db);
    assert.equal(r.status, 'error');
    assert.ok(!r.error.includes('abc12345'));
    const stored = JSON.stringify([db.prepare('SELECT * FROM facts').all(), db.prepare('SELECT * FROM connector_runs').all()]);
    assert.ok(!stored.includes('abc12345'));
    assert.ok(!stored.includes('pcp_board_'));
  } finally { done(); }
});

test('the connector own secret value is masked even in an unshaped message', async () => {
  const { db, done } = tmp();
  try {
    const leaky = stub({ fetch: async () => { throw new Error('bad key zzSECRETVALUEzz rejected'); } });
    const r = await runConnector(leaky, { project: 'P', url: 'u' }, mkCtx({ STUB_TOKEN: 'zzSECRETVALUEzz' }), db);
    assert.ok(!r.error.includes('zzSECRETVALUEzz'));
    const stored = JSON.stringify([db.prepare('SELECT * FROM facts').all(), db.prepare('SELECT * FROM connector_runs').all()]);
    assert.ok(!stored.includes('zzSECRETVALUEzz'));
  } finally { done(); }
});

test('a 401 gives status error with HTTP 401 and the next target still runs', async () => {
  const { db, done } = tmp();
  try {
    const fetchImpl = async (u) => (String(u).includes('bad') ? new Response('nope', { status: 401 }) : new Response('{"n":7}'));
    const conn = stub({
      fetch: async (t, ctx) => (await ctx.fetchJson(t.url)).json,
      parse: (raw) => ({ facts: [{ key: 'n', value: raw.n }], series: [], events: [] }),
    });
    const ctx = mkCtx(SECRETS, fetchImpl);
    const r1 = await runConnector(conn, { project: 'A', url: 'https://api.example.com/bad' }, ctx, db);
    const r2 = await runConnector(conn, { project: 'B', url: 'https://api.example.com/good' }, ctx, db);
    assert.equal(r1.status, 'error');
    assert.match(r1.error, /HTTP 401/);
    assert.equal(r2.status, 'ok');
    assert.equal(db.prepare("SELECT json FROM facts WHERE project='B' AND key='n'").get().json, '7');
    assert.match(db.prepare("SELECT error FROM connector_runs WHERE project='A'").get().error, /HTTP 401/);
  } finally { done(); }
});

test('events with the same external_id are not duplicated; series and runs upsert', async () => {
  const { db, done } = tmp();
  try {
    const ctx = mkCtx(SECRETS);
    await runConnector(stub(), { project: 'P', url: 'u' }, ctx, db);
    await runConnector(stub(), { project: 'P', url: 'u' }, ctx, db);
    assert.equal(count(db, 'events'), 1);
    assert.equal(count(db, 'series'), 1);
    assert.equal(count(db, 'connector_runs'), 1);
  } finally { done(); }
});

test('series merge "max" keeps the day maximum', async () => {
  const { db, done } = tmp();
  try {
    const ctx = mkCtx(SECRETS);
    const mk = (v) => stub({ parse: () => ({ facts: [], series: [{ metric: 'ms', day: '2026-10-31', value: v, merge: 'max' }], events: [] }) });
    await runConnector(mk(300), { project: 'P', url: 'u' }, ctx, db);
    await runConnector(mk(120), { project: 'P', url: 'u' }, ctx, db);
    assert.equal(db.prepare('SELECT value FROM series').get().value, 300);
    await runConnector(mk(450), { project: 'P', url: 'u' }, ctx, db);
    assert.equal(db.prepare('SELECT value FROM series').get().value, 450);
  } finally { done(); }
});

test('sanitiseError masks and cuts to 300 chars', () => {
  assert.ok(!sanitiseError('Bearer abcdef123').includes('abcdef123'));
  assert.equal(sanitiseError('x'.repeat(1000)).length, 300);
  assert.equal(sanitiseError(new Error('plain')), 'plain');
});
