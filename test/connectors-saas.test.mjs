// Lemon Squeezy, Sentry and Vercel connectors. No network: fetch tests use a fake fetchJson.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ls from '../connectors/lemonsqueezy.mjs';
import sentry from '../connectors/sentry.mjs';
import vercel from '../connectors/vercel.mjs';
import { CONNECTORS, byId } from '../connectors/index.mjs';
import { registryTargets } from '../lib/need.mjs';
import { missingFor } from '../lib/connector.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/connectors/${n}.json`, import.meta.url), 'utf8'));
const facts = (out) => Object.fromEntries(out.facts.map((f) => [f.key, f.value]));

// A fake ctx: routes a URL to a canned body by predicate; records every call.
function ctxFor(routes, nowMs) {
  const calls = [];
  return {
    calls,
    getSecret: (n) => `secret-${n}`,
    now: () => nowMs,
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      for (const [match, body] of routes) if (match(url)) return { status: 200, json: structuredClone(body), text: '' };
      throw new Error(`unrouted ${url}`);
    },
  };
}

test('registered with the right cadence', () => {
  for (const [c, every] of [[ls, '1h'], [sentry, '15m'], [vercel, '15m']]) {
    assert.equal(byId(c.id), c);
    assert.ok(CONNECTORS.includes(c));
    assert.equal(c.every, every);
  }
});

test('fixtures cite docs and hold no secrets', () => {
  for (const n of ['lemonsqueezy', 'sentry', 'vercel']) {
    const raw = readFileSync(new URL(`./fixtures/connectors/${n}.json`, import.meta.url), 'utf8');
    assert.match(JSON.parse(raw)._source, /^docs: https:\/\//);
    assert.doesNotMatch(raw, /Bearer|pcp_board|sk-[a-z0-9]/i);
  }
});

test('parse({}) throws /missing/ for each connector', () => {
  for (const c of [ls, sentry, vercel]) assert.throws(() => c.parse({}), /missing/, c.id);
});

test('targets and required fields: registry key stays under `project`, connector field renamed', () => {
  const reg = new Map([
    ['A', { connectors: { lemonsqueezy: { storeId: null }, sentry: { org: 'o', project: 'p' }, vercel: { project: 'v', teamId: 'team_1' } } }],
    ['B', { connectors: {} }],
    ['C', { connectors: { sentry: { org: null, project: null }, vercel: { project: null } } }],
  ]);
  assert.deepEqual(ls.targets(reg), [{ project: 'A', storeId: null }]);
  assert.deepEqual(sentry.targets(reg), [{ project: 'A', org: 'o', sentryProject: 'p' }, { project: 'C', org: null, sentryProject: null }]);
  assert.deepEqual(vercel.targets(reg), [{ project: 'A', vercelProject: 'v', teamId: 'team_1' }, { project: 'C', vercelProject: null, teamId: null }]);
  const none = () => 'x';
  assert.deepEqual(missingFor(ls, { storeId: null }, none), ['connectors.lemonsqueezy.storeId']);
  assert.deepEqual(missingFor(sentry, { org: null, sentryProject: null }, none), ['connectors.sentry.org', 'connectors.sentry.project']);
  assert.deepEqual(missingFor(vercel, { vercelProject: null }, none), ['connectors.vercel.project']);
  assert.deepEqual(missingFor(vercel, { vercelProject: 'v' }, none), []);
});

// ---------- Lemon Squeezy
const LS_NOW = Date.parse('2026-10-31T10:00:00Z');
const lsRoutes = () => [
  [(u) => u.includes('/v1/orders') && !u.includes('page%5Bnumber%5D=2'), fx('lemonsqueezy').ordersPage1],
  [(u) => u.includes('/v1/orders') && u.includes('page%5Bnumber%5D=2'), fx('lemonsqueezy').ordersPage2],
  [(u) => u.includes('/v1/subscriptions'), fx('lemonsqueezy').subscriptions],
  [(u) => u.includes('/v1/stores'), fx('lemonsqueezy').stores],
];

test('lemonsqueezy fetch: URLs, headers, host list, follows links.next', async () => {
  const ctx = ctxFor(lsRoutes(), LS_NOW);
  const raw = await ls.fetch({ project: 'S', storeId: 1 }, ctx);
  assert.equal(ctx.calls.length, 3);
  const first = new URL(ctx.calls[0].url);
  assert.equal(first.host, 'api.lemonsqueezy.com');
  assert.equal(first.pathname, '/v1/orders');
  assert.equal(first.searchParams.get('filter[store_id]'), '1');
  assert.equal(first.searchParams.get('page[size]'), '100');
  assert.equal(first.searchParams.get('sort'), '-created_at');
  assert.equal(new URL(ctx.calls[2].url).pathname, '/v1/subscriptions');
  for (const c of ctx.calls) {
    assert.deepEqual(c.opts.allowHosts, ['api.lemonsqueezy.com']);
    assert.equal(c.opts.headers.Authorization, 'Bearer secret-LEMONSQUEEZY_API_KEY');
    assert.equal(c.opts.headers.Accept, 'application/vnd.api+json');
  }
  assert.equal(raw.orders.length, 4);
  assert.equal(raw.ordersComplete, true);
  assert.equal(raw.subscriptions.length, 3);
});

test('lemonsqueezy fetch: at most 5 pages, never leaves the host', async () => {
  const page = (n) => ({ data: [{ id: String(n), attributes: { created_at: '2026-10-30T00:00:00Z', total: 1 } }], links: { next: `https://api.lemonsqueezy.com/v1/orders?page%5Bnumber%5D=${n + 1}` } });
  let n = 0;
  const ctx = { calls: [], getSecret: () => 'k', now: () => LS_NOW, async fetchJson(url) { this.calls.push(url); return { json: url.includes('subscriptions') ? { data: [], links: { next: null } } : page(++n) }; } };
  const raw = await ls.fetch({ storeId: 1 }, ctx);
  assert.equal(raw.orders.length, 5);
  assert.equal(raw.ordersComplete, false);
  const evil = { getSecret: () => 'k', now: () => LS_NOW, async fetchJson() { return { json: { data: [], links: { next: 'https://evil.example/x' } } }; } };
  await assert.rejects(ls.fetch({ storeId: 1 }, evil), /leaves api.lemonsqueezy.com/);
});

test('lemonsqueezy discover lists stores', async () => {
  const ctx = ctxFor(lsRoutes(), LS_NOW);
  assert.deepEqual(await ls.discover(ctx), [{ id: '1', name: 'My Store', slug: 'my-store', currency: 'EUR' }]);
  assert.equal(ctx.calls[0].opts.headers.Authorization, 'Bearer secret-LEMONSQUEEZY_API_KEY');
});

test('lemonsqueezy parse: sums totals across pages, skips refunds, counts only active subscriptions', () => {
  const f = fx('lemonsqueezy');
  const raw = { orders: [...f.ordersPage1.data, ...f.ordersPage2.data], ordersComplete: true, subscriptions: f.subscriptions.data, now: LS_NOW };
  const out = ls.parse(raw);
  assert.deepEqual(facts(out), { 'orders.30d': 3, 'orders.truncated': false, 'revenue.30d_cents': 6700, 'revenue.currency': null, 'subscriptions.active': 2, mrr_cents: null });
  assert.equal(out.series.length, 31);
  assert.deepEqual(out.series[0], { metric: 'revenue.cents', day: '2026-10-01', value: 0 });
  assert.deepEqual(out.series.filter((x) => x.value).map((x) => [x.day, x.value]), [['2026-10-10', 1900], ['2026-10-30', 1900], ['2026-10-31', 2900]]);
  assert.deepEqual(out.events.map((e) => [e.kind, e.external_id, e.title, e.url]), [
    ['order', '1004', 'Ana Pop · €29.00', 'https://app.lemonsqueezy.com/orders/1004'],
    ['order', '1003', 'Ion Rus · €19.00', 'https://app.lemonsqueezy.com/orders/1003'],
  ]);
  assert.equal(out.events[0].at, '2026-10-31T06:30:00.000Z');
});

test('lemonsqueezy: a day whose only order was refunded is rewritten as 0', () => {
  const f = fx('lemonsqueezy');
  const order = f.ordersPage1.data[0];
  const day = order.attributes.created_at.slice(0, 10);
  const before = ls.parse({ orders: [order], ordersComplete: true, subscriptions: [], now: LS_NOW });
  assert.equal(before.series.find((x) => x.day === day).value, 2900);
  const refunded = structuredClone(order); refunded.attributes.status = 'refunded';
  const after = ls.parse({ orders: [refunded], ordersComplete: true, subscriptions: [], now: LS_NOW });
  assert.deepEqual(after.series.find((x) => x.day === day), { metric: 'revenue.cents', day, value: 0 });
});

test('lemonsqueezy: page cap hit -> orders.truncated, only fully covered days emitted', () => {
  const f = fx('lemonsqueezy');
  const orders = [f.ordersPage1.data[1]]; // oldest fetched order on 2026-10-30
  const out = ls.parse({ orders, ordersComplete: false, subscriptions: [], now: LS_NOW });
  assert.equal(facts(out)['orders.truncated'], true);
  assert.deepEqual(out.series.map((x) => x.day), ['2026-10-31']);
});

test('registryTargets: a connector field named project cannot overwrite the registry key', () => {
  assert.deepEqual(registryTargets(new Map([['K', { connectors: { x: { p: 1 } } }]]), 'x', () => ({ project: 'evil', p: 1 })), [{ project: 'K', p: 1 }]);
});

test('lemonsqueezy mrr: null without prices, a sum only when every active subscription has one, 0 with none', () => {
  const f = fx('lemonsqueezy');
  const base = { orders: [], now: LS_NOW };
  const priced = f.subscriptions.data.map((s) => ({ ...s, attributes: { ...s.attributes, first_subscription_item: { price: 1500 } } }));
  assert.equal(facts(ls.parse({ ...base, subscriptions: priced })).mrr_cents, 3000);
  assert.equal(facts(ls.parse({ ...base, subscriptions: [] })).mrr_cents, 0);
  const one = structuredClone(priced); delete one[0].attributes.first_subscription_item;
  assert.equal(facts(ls.parse({ ...base, subscriptions: one })).mrr_cents, null);
});

test('lemonsqueezy parse: an order without a numeric total throws /missing/', () => {
  const f = fx('lemonsqueezy');
  const orders = structuredClone(f.ordersPage1.data); delete orders[0].attributes.total;
  assert.throws(() => ls.parse({ orders, subscriptions: [], now: LS_NOW }), /missing attributes\.total/);
  assert.throws(() => ls.parse({ orders: [], subscriptions: [{ attributes: {} }], now: LS_NOW }), /missing/);
});

// ---------- Sentry
const SN_NOW = Date.parse('2026-10-31T10:00:00Z');
const snFx = fx('sentry');
const snNew = [snFx.issues[0]];
const snRoutes = (issues = snFx.issues) => [
  [(u) => u.includes('firstSeen'), snNew],
  [(u) => /\/projects\/acme\/[a-z]+\/issues\//.test(u), issues],
  [(u) => u.includes('/stats_v2/'), snFx.stats],
  [(u) => u.endsWith('/organizations/acme/projects/'), snFx.projects],
  [(u) => u.endsWith('/organizations/'), snFx.orgs],
];

test('sentry fetch: URLs, headers, project id from the issues response', async () => {
  const ctx = ctxFor(snRoutes(), SN_NOW);
  const raw = await sentry.fetch({ org: 'acme', sentryProject: 'web' }, ctx);
  assert.equal(ctx.calls.length, 3);
  const i = new URL(ctx.calls[0].url);
  assert.equal(i.host, 'sentry.io');
  assert.equal(i.pathname, '/api/0/projects/acme/web/issues/');
  assert.equal(i.searchParams.get('query'), 'is:unresolved');
  assert.equal(i.searchParams.get('statsPeriod'), '24h');
  assert.equal(i.searchParams.get('limit'), '25');
  const n = new URL(ctx.calls[1].url);
  assert.equal(n.searchParams.get('query'), 'is:unresolved firstSeen:-24h');
  assert.equal(n.searchParams.get('sort'), 'new');
  assert.equal(n.searchParams.get('limit'), '25');
  const s = new URL(ctx.calls[2].url);
  assert.equal(s.searchParams.get('outcome'), 'accepted');
  assert.equal(s.pathname, '/api/0/organizations/acme/stats_v2/');
  assert.equal(s.searchParams.get('project'), '77');
  assert.equal(s.searchParams.get('field'), 'sum(quantity)');
  assert.equal(s.searchParams.get('groupBy'), 'category');
  assert.equal(s.searchParams.get('category'), 'error');
  assert.equal(s.searchParams.get('interval'), '1d');
  assert.equal(s.searchParams.get('statsPeriod'), '30d');
  for (const c of ctx.calls) {
    assert.deepEqual(c.opts.allowHosts, ['sentry.io']);
    assert.equal(c.opts.headers.Authorization, 'Bearer secret-SENTRY_AUTH_TOKEN');
  }
  assert.equal(raw.issues.length, 2);
  assert.ok(raw.stats);
});

test('sentry fetch: no issues -> project id resolved from the org project list; unknown slug -> stats null', async () => {
  const ctx = ctxFor(snRoutes([]), SN_NOW);
  const raw = await sentry.fetch({ org: 'acme', sentryProject: 'web' }, ctx);
  assert.equal(ctx.calls.length, 4);
  assert.equal(new URL(ctx.calls[3].url).searchParams.get('project'), '77');
  assert.ok(raw.stats);
  const ctx2 = ctxFor(snRoutes([]), SN_NOW);
  const raw2 = await sentry.fetch({ org: 'acme', sentryProject: 'ghost' }, ctx2);
  assert.equal(raw2.stats, null);
});

test('sentry discover lists org/project pairs with ids', async () => {
  const ctx = ctxFor(snRoutes(), SN_NOW);
  assert.deepEqual(await sentry.discover(ctx), [
    { id: 'acme/web', name: 'Web', org: 'acme', project: 'web', projectId: '77' },
    { id: 'acme/api', name: 'API', org: 'acme', project: 'api', projectId: '78' },
  ]);
});

test('sentry parse: facts, series keyed on the API interval dates, only new issues become events', () => {
  const out = sentry.parse({ issues: snFx.issues, stats: snFx.stats, newIssues: snNew, now: SN_NOW });
  assert.deepEqual(facts(out), { 'issues.unresolved': 2, 'issues.truncated': false, 'events.today': 30, 'sentry.note': null });
  assert.deepEqual(out.series, [
    { metric: 'errors.events', day: '2026-10-29', value: 10 },
    { metric: 'errors.events', day: '2026-10-30', value: 20 },
    { metric: 'errors.events', day: '2026-10-31', value: 30 },
  ]);
  assert.deepEqual(out.events, [{ kind: 'error', at: '2026-10-31T07:00:00.000Z', title: 'TypeError: x is undefined', url: 'https://sentry.io/organizations/acme/issues/4001/', external_id: '4001' }]);
});

test('sentry parse: unknown project id -> null events.today, a note, no series; no groups -> real zeros', () => {
  const out = sentry.parse({ issues: snFx.issues, stats: null, newIssues: [], now: SN_NOW });
  assert.equal(facts(out)['events.today'], null);
  assert.equal(facts(out)['sentry.note'], 'project id not found in org project list (check connectors.sentry.project slug)');
  assert.deepEqual(out.series, []);
  const quiet = sentry.parse({ issues: [], stats: { intervals: snFx.stats.intervals, groups: [] }, newIssues: [], now: SN_NOW });
  assert.equal(facts(quiet)['sentry.note'], null);
  assert.deepEqual(quiet.series.map((s) => s.value), [0, 0, 0]);
  assert.equal(facts(quiet)['events.today'], 0);
});

test('sentry parse: 25 issues flags truncation; malformed shapes throw /missing/', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...snFx.issues[1], id: String(i) }));
  assert.equal(facts(sentry.parse({ issues: many, stats: null, newIssues: [], now: SN_NOW }))['issues.truncated'], true);
  assert.throws(() => sentry.parse({ issues: [{ id: '1', title: 't' }], stats: null, newIssues: [], now: SN_NOW }), /missing firstSeen/);
  assert.throws(() => sentry.parse({ issues: [], newIssues: [], stats: { intervals: ['2026-10-31T00:00:00Z'], groups: [{ series: {} }] }, now: SN_NOW }), /missing/);
  assert.throws(() => sentry.parse({ issues: [], newIssues: [], stats: { intervals: ['2026-10-31T00:00:00Z'], groups: [{ series: { 'sum(quantity)': [1, 2] } }] }, now: SN_NOW }), /missing/);
});

// ---------- Vercel
const VC_NOW = 1761912000000;
const vcFx = fx('vercel');
const vcRoutes = () => [
  [(u) => u.includes('target=production'), vcFx.production],
  [(u) => u.includes('target=preview'), vcFx.preview],
  [(u) => u.includes('/v9/projects'), vcFx.projects],
  [(u) => u.includes('/v2/teams'), { teams: [{ id: 'team_1', slug: 'acme', name: 'Acme Inc' }] }],
];

test('vercel fetch: two requests with projectId, target, limits, optional teamId', async () => {
  const ctx = ctxFor(vcRoutes(), VC_NOW);
  const raw = await vercel.fetch({ vercelProject: 'demo', teamId: null }, ctx);
  const [p, v] = ctx.calls.map((c) => new URL(c.url));
  assert.equal(p.host, 'api.vercel.com');
  assert.equal(p.pathname, '/v6/deployments');
  assert.equal(p.searchParams.get('projectId'), 'demo');
  assert.equal(p.searchParams.get('target'), 'production');
  assert.equal(p.searchParams.get('limit'), '10');
  assert.equal(p.searchParams.get('teamId'), null);
  assert.equal(v.searchParams.get('target'), 'preview');
  assert.equal(v.searchParams.get('limit'), '5');
  for (const c of ctx.calls) {
    assert.deepEqual(c.opts.allowHosts, ['api.vercel.com']);
    assert.equal(c.opts.headers.Authorization, 'Bearer secret-VERCEL_TOKEN');
  }
  assert.ok(raw.production && raw.preview);
  const ctx2 = ctxFor(vcRoutes(), VC_NOW);
  await vercel.fetch({ vercelProject: 'demo', teamId: 'team_9' }, ctx2);
  for (const c of ctx2.calls) assert.equal(new URL(c.url).searchParams.get('teamId'), 'team_9');
});

test('vercel discover lists teams (id, slug, name) and projects, scoped to ctx.teamId', async () => {
  const ctx = ctxFor(vcRoutes(), VC_NOW);
  assert.deepEqual(await vercel.discover(ctx), {
    teams: [{ id: 'team_1', slug: 'acme', name: 'Acme Inc' }],
    projects: [{ id: 'prj_1', name: 'demo', framework: 'nextjs' }, { id: 'prj_2', name: 'other', framework: null }],
  });
  assert.equal(new URL(ctx.calls.find((c) => c.url.includes('/v9/projects')).url).searchParams.get('teamId'), null);
  const ctx2 = ctxFor(vcRoutes(), VC_NOW);
  await vercel.discover({ ...ctx2, teamId: 'team_1' });
  assert.equal(new URL(ctx2.calls.find((c) => c.url.includes('/v9/projects')).url).searchParams.get('teamId'), 'team_1');
});

test('vercel parse: newest production deployment, ERROR count in 24h, stable uid ids', () => {
  const out = vercel.parse({ production: vcFx.production, preview: vcFx.preview, now: VC_NOW });
  const f = facts(out);
  assert.deepEqual(f['deploy.production'], { state: 'READY', createdAt: new Date(1761900000000).toISOString(), url: 'https://demo-new.vercel.app', commit: 'fix checkout', sha: 'bbb222' });
  assert.deepEqual(f['deploy.preview'], { state: 'BUILDING', createdAt: new Date(1761910000000).toISOString(), url: 'https://demo-git-feat.vercel.app', commit: 'wip', sha: 'ccc333' });
  assert.equal(f['deploy.failed_24h'], 1);
  assert.deepEqual(out.series, []);
  assert.deepEqual(out.events.map((e) => e.external_id).sort(), ['dpl_bad', 'dpl_new', 'dpl_prev']);
  const bad = out.events.find((e) => e.external_id === 'dpl_bad');
  assert.deepEqual([bad.kind, bad.title, bad.url], ['deploy', 'production ERROR', 'https://demo-bad.vercel.app']);
  assert.equal(out.events.find((e) => e.external_id === 'dpl_new').title, 'production READY · fix checkout');
  assert.equal(out.events.find((e) => e.external_id === 'dpl_prev').title, 'preview BUILDING · wip');
});

test('vercel parse: no deployments -> null, not zero; missing fields throw /missing/', () => {
  const none = { deployments: [] };
  const f = facts(vercel.parse({ production: none, preview: none, now: VC_NOW }));
  assert.equal(f['deploy.production'], null);
  assert.equal(f['deploy.preview'], null);
  assert.equal(f['deploy.failed_24h'], 0);
  assert.throws(() => vercel.parse({ production: { deployments: [{ uid: 'x' }] }, preview: none, now: VC_NOW }), /missing/);
  assert.throws(() => vercel.parse({ production: none, now: VC_NOW }), /missing/);
});
