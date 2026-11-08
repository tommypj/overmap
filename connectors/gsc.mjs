import { need, needArr, needNum, registryTargets } from '../lib/need.mjs';
import { accessToken } from '../lib/google-oauth.mjs';

const HOST = 'searchconsole.googleapis.com';
const BASE = `https://${HOST}/webmasters/v3/sites`;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
// Day window ending at the latest day present, by UTC date arithmetic on the API's own date strings.
const within = (rows, latest, days) => rows.filter((r) => dayMs(r.day) >= dayMs(latest) - (days - 1) * 86_400_000);
const round1 = (n) => Math.round(n * 10) / 10;

// A new property answers with no `rows` key at all: that is a real zero, not an unknown.
function rowsOf(raw, key) {
  const resp = need(raw, key);
  return resp.rows === undefined ? [] : needArr(raw, `${key}.rows`);
}

export default {
  id: 'gsc',
  every: '1h',
  secrets: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN'],
  required: ['siteUrl'],
  note: 'siteUrl is a Search Console property, e.g. sc-domain:example.com: use the Discover link (Settings, connector row, discover) once Google is connected',
  targets: (registry) => registryTargets(registry, 'gsc', (c) => ({ siteUrl: c.siteUrl ?? null })),
  async fetch(target, ctx) {
    const token = await accessToken(ctx);
    const today = ctx.now();
    const url = `${BASE}/${encodeURIComponent(target.siteUrl)}/searchAnalytics/query`;
    const opts = (body) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), allowHosts: [HOST] });
    const range = { startDate: iso(today - 31 * DAY_MS), endDate: iso(today - DAY_MS) };
    const queryRange = { startDate: iso(today - 28 * DAY_MS), endDate: iso(today - DAY_MS) };
    const byDate = (await ctx.fetchJson(url, opts({ ...range, dimensions: ['date'], rowLimit: 1000 }))).json;
    const byQuery = (await ctx.fetchJson(url, opts({ ...queryRange, dimensions: ['query'], rowLimit: 10 }))).json;
    return { byDate, byQuery };
  },
  async discover(ctx) {
    const token = await accessToken(ctx);
    const json = (await ctx.fetchJson(BASE, { headers: { Authorization: `Bearer ${token}` }, allowHosts: [HOST] })).json;
    if (json === null || typeof json !== 'object') throw new Error('missing siteEntry in response');
    const list = json.siteEntry === undefined ? [] : needArr(json, 'siteEntry');
    return list.map((s) => ({ id: need(s, 'siteUrl'), name: s.siteUrl, permissionLevel: s.permissionLevel ?? null }));
  },
  parse(raw) {
    const dateRows = rowsOf(raw, 'byDate').map((r) => {
      const day = needArr(r, 'keys')[0];
      if (typeof day !== 'string' || !DATE_RE.test(day)) throw new Error('missing date in keys');
      return { day, clicks: needNum(r, 'clicks'), impressions: needNum(r, 'impressions'), position: needNum(r, 'position') };
    }).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const queryRows = rowsOf(raw, 'byQuery').map((r) => {
      const query = needArr(r, 'keys')[0];
      if (typeof query !== 'string') throw new Error('missing query in keys');
      return { query, clicks: needNum(r, 'clicks'), impressions: needNum(r, 'impressions'), position: round1(needNum(r, 'position')) };
    });
    const latest = dateRows.length ? dateRows[dateRows.length - 1].day : null;
    const last = latest ? within(dateRows, latest, 28) : [];
    const clicks = last.reduce((s, r) => s + r.clicks, 0);
    const impressions = last.reduce((s, r) => s + r.impressions, 0);
    const weighted = last.reduce((s, r) => s + r.position * r.impressions, 0);
    return {
      facts: [
        { key: 'gsc.clicks_28d', value: clicks },
        { key: 'gsc.impressions_28d', value: impressions },
        { key: 'gsc.position_28d', value: impressions > 0 ? round1(weighted / impressions) : null },
        { key: 'gsc.top_queries', value: queryRows },
        { key: 'gsc.latest_day', value: latest },
      ],
      series: dateRows.flatMap((r) => [
        { metric: 'gsc.clicks', day: r.day, value: r.clicks },
        { metric: 'gsc.impressions', day: r.day, value: r.impressions },
      ]),
      events: [],
    };
  },
};
