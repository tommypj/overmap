// Final fix wave of Stage 2: registry reload, masking, baseline, currency, secrets, discover pre-check, parallel fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../serve.mjs';
import { maskText } from '../lib/mask.mjs';
import { openDb } from '../lib/db.mjs';
import { runConnector, connectorOverview } from '../lib/connector.mjs';
import { getSecret, secretsHealth, _resetSecretsCache } from '../lib/secrets.mjs';
import { baselineFor, readBaseline, saveBaseline, clearBaseline, leaveOverview, notePendingVisit, persistPendingVisit } from '../web/events.js';
import { fmtCents, fmtCentsPlain } from '../web/pages/live.js';
import ls from '../connectors/lemonsqueezy.mjs';
import health from '../connectors/health.mjs';

const NOMINAL = 45881;
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'x@example.com', port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };

async function withApp(extra, reg, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-ff-'));
  writeFileSync(join(dir, 'reg.json'), JSON.stringify(reg));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ generatedAt: '2026-10-31T10:00:00Z', projects: [] }));
  const env = { DASH_PORT: String(NOMINAL), DASH_NO_SCHEDULE: '1', DASH_DB: join(dir, 'c.db'), DASH_REGISTRY: join(dir, 'reg.json'), DASH_DATA: join(dir, 'projects.json') };
  const server = createApp(config, env, extra);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${NOMINAL}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
  try { await fn({ get, dir }); } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp cleanup only */ }
  }
}

test('registry.json edits show up without a restart', async () => {
  const reg = (extra = {}) => ({ version: 1, projects: { A: { home: '/zz-a', connectors: { health: { url: 'https://a.example/h' } } }, ...extra } });
  await withApp({}, reg(), async ({ get, dir }) => {
    const ids = async () => JSON.parse((await get('/api/connectors')).body)[0].projects.map((p) => p.project);
    assert.deepEqual(await ids(), ['A']);
    writeFileSync(join(dir, 'reg.json'), JSON.stringify(reg({ B: { home: '/zz-b', connectors: { health: { url: null } } } })));
    assert.deepEqual((await ids()).sort(), ['A', 'B']);
  });
});

test('masking: Authorization JSON, quoted/bracketed Bearer and Basic, any case', () => {
  const b64 = Buffer.from('admin:hunter2hunter2').toString('base64');
  for (const s of [`{"Authorization":"Basic ${b64}"}`, `{"auth":"bearer ${b64}"}`, `x=(Basic ${b64})`, `["Bearer ${b64}"]`, `'basic ${b64}'`, `a=BEARER ${b64}`]) {
    assert.ok(!maskText(s).includes(b64), s);
  }
  assert.equal(maskText('Basic auth is on'), 'Basic auth is on'); // short words after basic stay readable
});

test('baselineFor: session baseline wins; "none" is a remembered first visit; else stored; junk is null', () => {
  const A = '2026-10-31T08:00:00.000Z';
  const B = '2026-10-31T09:00:00.000Z';
  assert.equal(baselineFor({ session: A, stored: B }), A);
  assert.equal(baselineFor({ session: null, stored: B }), B);
  assert.equal(baselineFor({ session: 'none', stored: B }), null);
  assert.equal(baselineFor({ session: 'garbage', stored: B }), B);
  assert.equal(baselineFor({ session: null, stored: null }), null);
  assert.equal(baselineFor({ session: undefined, stored: 'garbage' }), null);
});

test('baseline survives a reload (session) and is cleared on leaving; pagehide persists without clearing pending', () => {
  const mk = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  const session = mk();
  const local = mk();
  saveBaseline('2026-10-31T08:00:00.000Z', session);
  assert.equal(readBaseline(session), '2026-10-31T08:00:00.000Z');
  saveBaseline(null, session);
  assert.equal(baselineFor({ session: readBaseline(session), stored: '2026-10-31T09:00:00.000Z' }), null);
  notePendingVisit('2026-10-31T10:00:00.000Z');
  assert.equal(persistPendingVisit(local), true);
  assert.equal(local.m.get('cockpit.lastVisit'), '2026-10-31T10:00:00.000Z');
  assert.equal(readBaseline(session), 'none'); // pagehide leaves the shown baseline alone
  assert.equal(leaveOverview(local, session), true);
  assert.equal(readBaseline(session), null);
  clearBaseline({ removeItem() { throw new Error('blocked'); } }); // never throws
  notePendingVisit(null);
});

test('lemonsqueezy: currency fact and order event links to the dashboard, not the receipt', () => {
  const orders = [{ id: 77, attributes: { created_at: '2026-10-31T09:00:00Z', total: 1000, status: 'paid', currency: 'USD', urls: { receipt: 'https://x/receipt?signature=abcdef123456' } } }];
  const out = ls.parse({ orders, subscriptions: [], now: Date.parse('2026-10-31T10:00:00Z') });
  assert.equal(out.facts.find((f) => f.key === 'revenue.currency').value, 'USD');
  assert.equal(out.events[0].url, 'https://app.lemonsqueezy.com/orders/77');
  const none = ls.parse({ orders: [], subscriptions: [], now: Date.parse('2026-10-31T10:00:00Z') });
  assert.equal(none.facts.find((f) => f.key === 'revenue.currency').value, null);
});

test('fmtCents: real currency, or EUR labelled as assumed; plain keeps no symbol', () => {
  assert.match(fmtCents(12345, 'USD'), /^US\$123\.45$|^\$123\.45$/);
  assert.ok(!fmtCents(12345, 'USD').includes('assumed'));
  assert.match(fmtCents(12345, 'RON'), /123\.45/);
  assert.match(fmtCents(12345), /€123\.45 \(assumed EUR\)/);
  assert.match(fmtCents(12345, 'nope!'), /assumed EUR/);
  assert.equal(fmtCents(null), null);
  assert.equal(fmtCentsPlain(12345), '123.45');
});

test('secrets file that disappears becomes missing, not cached values', () => {
  _resetSecretsCache();
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-ff-sec-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify({ A: 'va' }));
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
    assert.equal(getSecret('A', file), 'va');
    unlinkSync(file);
    assert.equal(getSecret('A', file), undefined);
    assert.equal(secretsHealth(file).file, 'missing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('discover with unset secrets answers 409 naming them, and never calls upstream', async () => {
  let called = false;
  const conn = { ...health, id: 'needs', secrets: ['NEEDS_THIS_SECRET_XYZ'], discover: async () => { called = true; return []; } };
  await withApp({ connectors: [health, conn], getSecret: () => undefined }, { version: 1, projects: {} }, async ({ get }) => {
    const r = await get('/api/connectors/discover?id=needs');
    assert.equal(r.status, 409);
    assert.deepEqual(JSON.parse(r.body), { error: 'not configured', missing: ['NEEDS_THIS_SECRET_XYZ'] });
    assert.equal(called, false);
  });
  const set = { ...conn, discover: async (ctx) => ({ teamId: ctx.teamId }) };
  await withApp({ connectors: [health, set], getSecret: () => 'v' }, { version: 1, projects: { A: { home: '/zz-a', connectors: { vercel: { teamId: 'team_7' } } } } }, async ({ get }) => {
    assert.deepEqual(JSON.parse((await get('/api/connectors/discover?id=needs')).body), { teamId: 'team_7' });
  });
});

test('connector overview carries note and discover flag for Settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-ff-ov-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    const o = connectorOverview({ ...health, note: 'a note', discover: async () => [] }, new Map(), {}, db, () => undefined);
    assert.equal(o.note, 'a note');
    assert.equal(o.discover, true);
    assert.equal('discover' in connectorOverview(health, new Map(), {}, db, () => undefined), false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
