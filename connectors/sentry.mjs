import { need, needArr, registryTargets } from '../lib/need.mjs';

const HOST = 'sentry.io';
const BASE = `https://${HOST}/api/0`;
const DAY_MS = 86_400_000;
const LIMIT = 25;

const opts = (ctx) => ({ headers: { Authorization: `Bearer ${ctx.getSecret('SENTRY_AUTH_TOKEN')}` }, allowHosts: [HOST] });

export default {
  id: 'sentry',
  every: '15m',
  secrets: ['SENTRY_AUTH_TOKEN'],
  required: ['org', 'sentryProject'],
  fieldNames: { sentryProject: 'project' },
  note: 'org/project are Sentry slugs: use the Discover link (Settings, connector row, discover) once the token is set',
  targets: (registry) => registryTargets(registry, 'sentry', (c) => ({ org: c.org ?? null, sentryProject: c.project ?? null })),
  async fetch(target, ctx) {
    const o = opts(ctx);
    const org = encodeURIComponent(target.org);
    const project = encodeURIComponent(target.sentryProject);
    const issuesUrl = `${BASE}/projects/${org}/${project}/issues/?${new URLSearchParams({ query: 'is:unresolved', statsPeriod: '24h', limit: String(LIMIT) })}`;
    const issues = (await ctx.fetchJson(issuesUrl, o)).json;
    const newUrl = `${BASE}/projects/${org}/${project}/issues/?${new URLSearchParams({ query: 'is:unresolved firstSeen:-24h', sort: 'new', limit: String(LIMIT) })}`;
    const newIssues = (await ctx.fetchJson(newUrl, o)).json;
    // stats_v2 wants the numeric project id: take it from an issue, else look the slug up in the org's project list.
    let projectId = Array.isArray(issues) ? issues.find((i) => i?.project?.id != null)?.project.id ?? null : null;
    if (projectId == null) {
      const list = (await ctx.fetchJson(`${BASE}/organizations/${org}/projects/`, o)).json;
      projectId = Array.isArray(list) ? list.find((p) => p?.slug === target.sentryProject)?.id ?? null : null;
    }
    let stats = null;
    if (projectId != null) {
      const q = new URLSearchParams({ field: 'sum(quantity)', groupBy: 'category', category: 'error', interval: '1d', statsPeriod: '30d', outcome: 'accepted', project: String(projectId) });
      stats = (await ctx.fetchJson(`${BASE}/organizations/${org}/stats_v2/?${q}`, o)).json;
    }
    return { issues, newIssues, stats, now: ctx.now() };
  },
  async discover(ctx) {
    const o = opts(ctx);
    const orgs = (await ctx.fetchJson(`${BASE}/organizations/`, o)).json;
    if (!Array.isArray(orgs)) throw new Error('missing organizations list in response');
    const out = [];
    for (const org of orgs.slice(0, 10)) {
      const projects = (await ctx.fetchJson(`${BASE}/organizations/${encodeURIComponent(need(org, 'slug'))}/projects/`, o)).json;
      if (!Array.isArray(projects)) throw new Error('missing projects list in response');
      for (const p of projects) out.push({ id: `${org.slug}/${need(p, 'slug')}`, name: p.name ?? p.slug, org: org.slug, project: p.slug, projectId: p.id ?? null });
    }
    return out;
  },
  parse(raw) {
    const issues = needArr(raw, 'issues');
    const now = need(raw, 'now');
    const newIssues = needArr(raw, 'newIssues');
    for (const i of [...issues, ...newIssues]) {
      need(i, 'id');
      need(i, 'title');
      if (!Number.isFinite(Date.parse(need(i, 'firstSeen')))) throw new Error('missing valid firstSeen in issue');
    }
    const facts = [
      { key: 'issues.unresolved', value: issues.length },
      // The issues call is capped at LIMIT; at the cap the count above is a lower bound.
      { key: 'issues.truncated', value: issues.length >= LIMIT },
    ];
    const series = [];
    if (raw.stats == null) {
      facts.push({ key: 'events.today', value: null }, { key: 'sentry.note', value: 'project id not found in org project list (check connectors.sentry.project slug)' });
    } else {
      const intervals = needArr(raw.stats, 'intervals');
      const groups = needArr(raw.stats, 'groups');
      if (!intervals.length) throw new Error('missing intervals in stats response');
      const totals = intervals.map(() => 0);
      for (const g of groups) {
        const s = needArr(g, 'series.sum(quantity)');
        if (s.length !== intervals.length) throw new Error('missing aligned series.sum(quantity) in stats group');
        s.forEach((v, k) => {
          if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('missing numeric series.sum(quantity) value');
          totals[k] += v;
        });
      }
      // Keyed on the API's own interval dates, never on the local clock. With interval=1d the last bucket is the
      // current (partial) day. No groups at all means the API saw no error events: every day is a real zero.
      intervals.forEach((iv, k) => {
        if (typeof iv !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iv)) throw new Error('missing date in stats interval');
        series.push({ metric: 'errors.events', day: iv.slice(0, 10), value: totals[k] });
      });
      facts.push({ key: 'events.today', value: totals[totals.length - 1] }, { key: 'sentry.note', value: null });
    }
    const events = newIssues
      .filter((i) => Date.parse(i.firstSeen) >= now - DAY_MS)
      .map((i) => ({ kind: 'error', at: new Date(i.firstSeen).toISOString(), title: String(i.title), url: i.permalink ?? null, external_id: String(i.id) }));
    return { facts, series, events };
  },
};
