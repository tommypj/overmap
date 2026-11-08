// Search Console and GA4 connectors. No network: fetch tests use a fake fetchJson.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import gsc from '../connectors/gsc.mjs';
import ga4 from '../connectors/ga4.mjs';
import { CONNECTORS, byId } from '../connectors/index.mjs';
import { missingFor } from '../lib/connector.mjs';
import { _resetTokenCache } from '../lib/google-oauth.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/connectors/${n}.json`, import.meta.url), 'utf8'));
const facts = (out) => Object.fromEntries(out.facts.map((f) => [f.key, f.value]));
const NOW = Date.parse('2026-10-31T10:00:00Z');
beforeEach(() => _resetTokenCache());

function ctxFor(routes) {
  const calls = [];
  const secrets = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec', GOOGLE_OAUTH_REFRESH_TOKEN: 'rtok' };
  return {
    calls,
    getSecret: (n) => secrets[n],
    now: () => NOW,
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      if (url === 'https://oauth2.googleapis.com/token') return { status: 200, json: fx('google-token'), text: '' };
      for (const [match, body] of routes) if (match(url, opts)) return { status: 200, json: structuredClone(body), text: '' };
      throw new Error(`unrouted ${url}`);
    },
  };
}

test('registered hourly; fixtures cite docs and hold no secrets', () => {
  for (const c of [gsc, ga4]) {
    assert.equal(byId(c.id), c);
    assert.ok(CONNECTORS.includes(c));
    assert.equal(c.every, '1h');
    assert.deepEqual(c.secrets, ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN']);
  }
  for (const n of ['gsc', 'ga4', 'google-token']) {
    const raw = readFileSync(new URL(`./fixtures/connectors/${n}.json`, import.meta.url), 'utf8');
    assert.match(JSON.parse(raw)._source, /^docs: https:\/\//);
    assert.doesNotMatch(raw, /Bearer ya|pcp_board|refresh_token|client_secret/i);
  }
});

test('parse({}) throws /missing/', () => {
  assert.throws(() => gsc.parse({}), /missing/);
  assert.throws(() => ga4.parse({}), /missing/);
});

test('targets and required fields: null siteUrl / propertyId is not_configured', () => {
  const reg = new Map([['P', { connectors: { gsc: { siteUrl: null }, ga4: { propertyId: null } } }], ['Q', { connectors: { gsc: { siteUrl: 'sc-domain:q.com' }, ga4: { propertyId: 123 } } }]]);
  const [p, q] = gsc.targets(reg);
  assert.deepEqual(missingFor(gsc, p, () => 'x'), ['connectors.gsc.siteUrl']);
  assert.deepEqual(missingFor(gsc, q, () => 'x'), []);
  const [gp, gq] = ga4.targets(reg);
  assert.deepEqual(missingFor(ga4, gp, () => 'x'), ['connectors.ga4.propertyId']);
  assert.equal(gq.propertyId, '123');
});

test('gsc parse: weighted position, series keyed on API dates, latest_day = max date', () => {
  const out = gsc.parse(fx('gsc'));
  const f = facts(out);
  assert.equal(f['gsc.clicks_28d'], 60);
  assert.equal(f['gsc.impressions_28d'], 2000);
  // (4*500 + 6*500 + 10*1000) / 2000 = 7.5
  assert.equal(f['gsc.position_28d'], 7.5);
  assert.equal(f['gsc.latest_day'], '2026-10-28');
  assert.deepEqual(f['gsc.top_queries'], [
    { query: 'terapie online', clicks: 40, impressions: 900, position: 3.3 },
    { query: 'psiholog cluj', clicks: 20, impressions: 1100, position: 8 },
  ]);
  const clicks = out.series.filter((s) => s.metric === 'gsc.clicks');
  assert.deepEqual(clicks.map((s) => s.day), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(clicks.map((s) => s.value), [10, 20, 30]);
  assert.ok(!out.series.some((s) => s.day === '2026-10-31'), 'today is absent');
  assert.deepEqual(out.events, []);
});

test('gsc parse: only the last 28 available days are summed', () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ keys: [new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)], clicks: 1, impressions: 10, position: 2 }));
  const out = gsc.parse({ byDate: { rows }, byQuery: {} });
  assert.equal(facts(out)['gsc.clicks_28d'], 28);
  assert.equal(facts(out)['gsc.impressions_28d'], 280);
  assert.equal(out.series.filter((s) => s.metric === 'gsc.clicks').length, 31);
});

test('gsc parse: no rows is a real zero, not unknown', () => {
  const out = gsc.parse({ byDate: {}, byQuery: {} });
  const f = facts(out);
  assert.equal(f['gsc.clicks_28d'], 0);
  assert.equal(f['gsc.impressions_28d'], 0);
  assert.equal(f['gsc.position_28d'], null);
  assert.equal(f['gsc.latest_day'], null);
  assert.deepEqual(f['gsc.top_queries'], []);
  assert.deepEqual(out.series, []);
});

test('gsc parse rejects a changed shape', () => {
  const b = fx('gsc');
  delete b.byDate.rows[0].clicks;
  assert.throws(() => gsc.parse(b), /missing clicks/);
  const c = fx('gsc');
  c.byDate.rows[0].keys = ['28/10/2026'];
  assert.throws(() => gsc.parse(c), /missing date/);
  const d = fx('gsc');
  delete d.byQuery;
  assert.throws(() => gsc.parse(d), /missing byQuery/);
});

test('gsc fetch: token then two POSTs with the right URL, body and allowHosts', async () => {
  const ctx = ctxFor([[(u) => u.includes('/searchAnalytics/query'), fx('gsc').byDate]]);
  const raw = await gsc.fetch({ siteUrl: 'sc-domain:example.com', project: 'T' }, ctx);
  assert.ok(raw.byDate && raw.byQuery);
  const posts = ctx.calls.filter((c) => c.url.includes('searchconsole'));
  assert.equal(posts.length, 2);
  for (const c of posts) {
    assert.equal(c.url, 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    assert.equal(c.opts.method, 'POST');
    assert.deepEqual(c.opts.allowHosts, ['searchconsole.googleapis.com']);
    assert.equal(c.opts.headers.Authorization, 'Bearer ya29.fixture-access-token');
  }
  const [d, q] = posts.map((c) => JSON.parse(c.opts.body));
  assert.deepEqual(d, { startDate: '2026-09-30', endDate: '2026-10-30', dimensions: ['date'], rowLimit: 1000 });
  assert.deepEqual(q, { startDate: '2026-10-03', endDate: '2026-10-30', dimensions: ['query'], rowLimit: 10 });
});

test('gsc discover maps siteEntry', async () => {
  const ctx = ctxFor([[(u) => u === 'https://searchconsole.googleapis.com/webmasters/v3/sites', fx('gsc').sites]]);
  assert.deepEqual(await gsc.discover(ctx), [
    { id: 'sc-domain:example.com', name: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { id: 'https://www.example.org/', name: 'https://www.example.org/', permissionLevel: 'siteFullUser' },
  ]);
  const last = ctx.calls.at(-1);
  assert.equal(last.opts.method, undefined);
  assert.deepEqual(last.opts.allowHosts, ['searchconsole.googleapis.com']);
  const empty = ctxFor([[() => true, {}]]);
  assert.deepEqual(await gsc.discover(empty), []);
});

test('ga4 parse: dates converted, 7-day users from the last 7 rows, sorted', () => {
  const out = ga4.parse(fx('ga4'));
  const f = facts(out);
  assert.equal(f['ga4.users_7d'], 30);
  assert.equal(f['ga4.users_28d'], 30);
  assert.equal(f['ga4.sessions_28d'], 35);
  assert.equal(f['ga4.latest_day'], '2026-10-28');
  assert.deepEqual(f['ga4.top_pages'], [{ path: '/', views: 50 }, { path: '/pricing', views: 20 }]);
  assert.deepEqual(out.series.filter((s) => s.metric === 'ga4.users').map((s) => [s.day, s.value]), [['2026-10-26', 8], ['2026-10-27', 10], ['2026-10-28', 12]]);
  assert.deepEqual(out.series.filter((s) => s.metric === 'ga4.sessions').map((s) => s.value), [9, 11, 15]);
  assert.ok(!out.series.some((s) => s.day === '2026-10-31'));
});

test('ga4 parse: 7d window is the last 7 of many rows', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ dimensionValues: [{ value: `202610${String(i + 1).padStart(2, '0')}` }], metricValues: [{ value: String(i + 1) }, { value: '1' }] }));
  const f = facts(ga4.parse({ byDate: { rows: rows.reverse() }, byPage: {} }));
  assert.equal(f['ga4.users_7d'], 24 + 25 + 26 + 27 + 28 + 29 + 30);
  assert.equal(f['ga4.sessions_28d'], 28);
  assert.equal(f['ga4.users_28d'], (3 + 30) * 28 / 2);
});

test('ga4 parse: no rows is zero; NaN metric and bad date throw', () => {
  const f = facts(ga4.parse({ byDate: {}, byPage: {} }));
  assert.equal(f['ga4.users_7d'], 0);
  assert.equal(f['ga4.latest_day'], null);
  assert.deepEqual(f['ga4.top_pages'], []);
  const bad = fx('ga4');
  bad.byDate.rows[0].metricValues[0].value = 'abc';
  assert.throws(() => ga4.parse(bad), /missing numeric/);
  const bad2 = fx('ga4');
  bad2.byDate.rows[0].dimensionValues[0].value = '2026-10-28';
  assert.throws(() => ga4.parse(bad2), /missing date/);
  const bad3 = fx('ga4');
  delete bad3.byPage.rows[0].metricValues;
  assert.throws(() => ga4.parse(bad3), /missing metricValues/);
});

test('ga4 fetch: two runReport POSTs with the documented bodies', async () => {
  const ctx = ctxFor([[(u) => u.includes(':runReport'), fx('ga4').byDate]]);
  await ga4.fetch({ propertyId: '123456', project: 'A' }, ctx);
  const posts = ctx.calls.filter((c) => c.url.includes('analyticsdata'));
  assert.equal(posts.length, 2);
  for (const c of posts) {
    assert.equal(c.url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport');
    assert.equal(c.opts.method, 'POST');
    assert.deepEqual(c.opts.allowHosts, ['analyticsdata.googleapis.com']);
  }
  const [d, p] = posts.map((c) => JSON.parse(c.opts.body));
  assert.deepEqual(d, { dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }], keepEmptyRows: true });
  assert.deepEqual(p.dimensions, [{ name: 'pagePath' }]);
  assert.deepEqual(p.metrics, [{ name: 'screenPageViews' }]);
  assert.equal(p.limit, 10);
  assert.deepEqual(p.orderBys, [{ metric: { metricName: 'screenPageViews' }, desc: true }]);
});

test('ga4 discover flattens account summaries', async () => {
  const ctx = ctxFor([[(u) => u === 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries', fx('ga4').accountSummaries]]);
  assert.deepEqual(await ga4.discover(ctx), [{ id: '123456', name: 'Acme web', account: 'Acme' }]);
  assert.deepEqual(ctx.calls.at(-1).opts.allowHosts, ['analyticsadmin.googleapis.com']);
});

test('ga4 and gsc 7d/28d are day windows from the latest API day, not row counts', () => {
  const g = (d, u) => ({ dimensionValues: [{ value: d }], metricValues: [{ value: String(u) }, { value: '1' }] });
  const f = facts(ga4.parse({ byDate: { rows: [g('20261020', 5), g('20261021', 6), g('20261028', 7)] }, byPage: {} }));
  assert.equal(f['ga4.users_7d'], 7);
  assert.equal(f['ga4.users_28d'], 18);
  const g2 = facts(gsc.parse({ byDate: { rows: [
    { keys: ['2026-09-30'], clicks: 100, impressions: 100, position: 1 },
    { keys: ['2026-10-01'], clicks: 1, impressions: 10, position: 1 },
    { keys: ['2026-10-28'], clicks: 2, impressions: 10, position: 1 },
  ] }, byQuery: {} }));
  assert.equal(g2['gsc.clicks_28d'], 3); // 2026-09-30 is 28 days before 10-28: outside the window
});

test('ga4 empty metric string throws; discover rejects a non-list propertySummaries', async () => {
  const bad = fx('ga4');
  bad.byDate.rows[0].metricValues[0].value = '';
  assert.throws(() => ga4.parse(bad), /missing/);
  const ctx = ctxFor([[(u) => u.includes('accountSummaries'), { accountSummaries: [{ displayName: 'A', propertySummaries: 'x' }] }]]);
  await assert.rejects(ga4.discover(ctx), /missing/);
});
