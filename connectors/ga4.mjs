import { need, needArr, registryTargets } from '../lib/need.mjs';
import { accessToken } from '../lib/google-oauth.mjs';

const HOST = 'analyticsdata.googleapis.com';
const ADMIN_HOST = 'analyticsadmin.googleapis.com';

const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
// Day window ending at the latest day present, by UTC date arithmetic on the API's own date strings.
const within = (rows, latest, days) => rows.filter((r) => dayMs(r.day) >= dayMs(latest) - (days - 1) * 86_400_000);
// GA4 returns every metric value as a string.
function num(row, i) {
  const raw = need(row, `metricValues.${i}.value`);
  const v = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) throw new Error(`missing numeric metricValues.${i}.value`);
  return v;
}
// A property with no data omits `rows`: a real zero.
function rowsOf(raw, key) {
  const resp = need(raw, key);
  return resp.rows === undefined ? [] : needArr(raw, `${key}.rows`);
}

export default {
  id: 'ga4',
  every: '1h',
  secrets: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
  required: ['propertyId'],
  note: 'propertyId is the numeric GA4 property id: use the Discover link (Settings, connector row, discover) once Google is connected',
  targets: (registry) => registryTargets(registry, 'ga4', (c) => ({ propertyId: c.propertyId == null ? null : String(c.propertyId) })),
  async fetch(target, ctx) {
    const token = await accessToken(ctx);
    const url = `https://${HOST}/v1beta/properties/${encodeURIComponent(target.propertyId)}:runReport`;
    const opts = (body) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), allowHosts: [HOST] });
    const dateRanges = [{ startDate: '30daysAgo', endDate: 'yesterday' }];
    const byDate = (await ctx.fetchJson(url, opts({ dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }], keepEmptyRows: true }))).json;
    const byPage = (await ctx.fetchJson(url, opts({ dateRanges, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], limit: 10, orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }] }))).json;
    return { byDate, byPage };
  },
  async discover(ctx) {
    const token = await accessToken(ctx);
    const json = (await ctx.fetchJson(`https://${ADMIN_HOST}/v1beta/accountSummaries`, { headers: { Authorization: `Bearer ${token}` }, allowHosts: [ADMIN_HOST] })).json;
    if (json === null || typeof json !== 'object') throw new Error('missing accountSummaries in response');
    const accounts = json.accountSummaries === undefined ? [] : needArr(json, 'accountSummaries');
    const out = [];
    for (const a of accounts) {
      for (const p of a.propertySummaries === undefined ? [] : needArr(a, 'propertySummaries')) {
        out.push({ id: String(need(p, 'property')).replace('properties/', ''), name: p.displayName ?? p.property, account: a.displayName ?? null });
      }
    }
    return out;
  },
  parse(raw) {
    const dayRows = rowsOf(raw, 'byDate').map((r) => {
      const d = need(r, 'dimensionValues.0.value');
      if (typeof d !== 'string' || !/^\d{8}$/.test(d)) throw new Error('missing date in dimensionValues');
      return { day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, users: num(r, 0), sessions: num(r, 1) };
    }).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const pages = rowsOf(raw, 'byPage').map((r) => ({ path: String(need(r, 'dimensionValues.0.value')), views: num(r, 0) }));
    const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
    const latest = dayRows.length ? dayRows[dayRows.length - 1].day : null;
    const l7 = latest ? within(dayRows, latest, 7) : [];
    const l28 = latest ? within(dayRows, latest, 28) : [];
    return {
      facts: [
        { key: 'ga4.users_7d', value: sum(l7, 'users') },
        { key: 'ga4.users_28d', value: sum(l28, 'users') },
        { key: 'ga4.sessions_28d', value: sum(l28, 'sessions') },
        { key: 'ga4.top_pages', value: pages },
        { key: 'ga4.latest_day', value: latest },
      ],
      series: dayRows.flatMap((r) => [
        { metric: 'ga4.users', day: r.day, value: r.users },
        { metric: 'ga4.sessions', day: r.day, value: r.sessions },
      ]),
      events: [],
    };
  },
};
