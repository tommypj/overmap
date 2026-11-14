// Live tab: one tile per connector group, fed by api/facts, api/series, api/connectors and api/connectors/config.
import { h, api, enc, ago, pill } from '../ui.js';
import { sparkline } from '../spark.js';
import { GLYPH } from '../events.js';
import { connState, hasGood } from '../devmodel.js';

const NUM = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const MONEY = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const safeHref = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const DAY_MS = 86_400_000;
const unknown = () => h('span', { class: 'unk' }, 'unknown');

// Row spec: [label, key, kind, lowerBoundKey?]. kinds: n, cents, ms, text, status, deploy, queries, pages, statuses.
const CONNECTORS = {
  health: { rows: [['Status', 'health.status', 'status'], ['Response', 'health.ms', 'ms'], ['Reason', 'health.reason', 'text']], series: ['health.ms'] },
  gsc: {
    rows: [['Clicks (28 d)', 'gsc.clicks_28d', 'n'], ['Impressions (28 d)', 'gsc.impressions_28d', 'n'], ['Avg position (28 d)', 'gsc.position_28d', 'n'], ['Top queries', 'gsc.top_queries', 'queries']],
    series: ['gsc.clicks', 'gsc.impressions'], lag: ['gsc.latest_day', 'Search Console data lags 2–3 days; latest day: '],
  },
  ga4: {
    rows: [['Active users, 7 d (daily, summed)', 'ga4.users_7d', 'n'], ['Active users, 28 d (daily, summed)', 'ga4.users_28d', 'n'], ['Sessions (28 d)', 'ga4.sessions_28d', 'n'], ['Top pages', 'ga4.top_pages', 'pages']],
    series: ['ga4.users', 'ga4.sessions'], lag: ['ga4.latest_day', 'latest day: '],
  },
  lemonsqueezy: {
    rows: [['Orders (30 d)', 'orders.30d', 'n', 'orders.truncated'], ['Revenue (30 d)', 'revenue.30d_cents', 'cents', 'orders.truncated'], ['Active subscriptions', 'subscriptions.active', 'n'], ['MRR', 'mrr_cents', 'cents']],
    series: ['revenue.cents'], currencyKey: 'revenue.currency',
  },
  sentry: {
    rows: [['Unresolved issues', 'issues.unresolved', 'n', 'issues.truncated'], ['Events today', 'events.today', 'n'], ['Note', 'sentry.note', 'text']],
    series: ['errors.events'],
  },
  vercel: {
    rows: [['Production', 'deploy.production', 'deploy'], ['Preview', 'deploy.preview', 'deploy'], ['Failed (24 h)', 'deploy.failed_24h', 'n']],
    series: [],
  },
};
const TILES = [
  { title: 'Uptime', conns: ['health'] },
  { title: 'Search (GSC)', conns: ['gsc'] },
  { title: 'Traffic (GA4)', conns: ['ga4'] },
  { title: 'Income (Lemon Squeezy)', conns: ['lemonsqueezy'] },
  { title: 'Messages / sign-ups', conns: [], events: true },
  { title: 'Errors (Sentry)', conns: ['sentry'] },
  { title: 'Deployments (Vercel)', conns: ['vercel'] },
];

export const fmtNum = (v) => (isNum(v) ? NUM.format(v) : null);
// Amounts are cents in the currency the source reported. Unknown currency: EUR, said out loud.
export function fmtCents(v, currency = null) {
  if (!isNum(v)) return null;
  const cur = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur ?? 'EUR' }).format(v / 100) + (cur ? '' : ' (assumed EUR)'); } catch { return `${MONEY.format(v / 100)} ${cur ?? 'EUR (assumed)'}`; }
}
// Cents with no currency symbol, for sources that do not say which currency they use.
export const fmtCentsPlain = (v) => (isNum(v) ? MONEY.format(v / 100) : null);

export function statusClass(s) {
  const t = String(s).toLowerCase();
  if (['up', 'ok', 'healthy', 'ready'].includes(t)) return '';
  if (['down', 'error', 'degraded', 'failed', 'unhealthy'].includes(t)) return 'risk';
  return 'unknown';
}

export function deployNode(v) {
  if (!v || typeof v !== 'object') return unknown();
  const sha = v.sha ? String(v.sha).slice(0, 7) : null;
  const first = typeof v.commit === 'string' ? v.commit.split('\n')[0] : '';
  const text = [v.state ?? 'unknown', v.createdAt ? ago(v.createdAt) : 'unknown', first || sha || 'no commit info'].join(' · ');
  const href = v.url ? safeHref(/^https?:/i.test(v.url) ? v.url : 'https://' + v.url) : null;
  const cls = statusClass(v.state);
  return href
    ? h('a', { class: 'pill link' + (cls === 'risk' ? ' risk' : ''), href, target: '_blank', rel: 'noopener noreferrer' }, text)
    : pill(text, cls);
}

function table(head, rows) {
  if (!Array.isArray(rows)) return unknown();
  if (!rows.length) return h('span', { class: 'muted' }, 'none');
  return h('table', { class: 'mini' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))),
    h('tbody', null, rows.slice(0, 10).map((r) => h('tr', null, r.map((c) => h('td', null, c))))));
}

function valueNode(kind, v, currency = null) {
  if (v === null || v === undefined) return unknown();
  switch (kind) {
    case 'n': return isNum(v) ? NUM.format(v) : unknown();
    case 'cents': return isNum(v) ? fmtCents(v, currency) : unknown();
    case 'centsPlain': return isNum(v) ? fmtCentsPlain(v) : unknown();
    case 'ms': return isNum(v) ? `${NUM.format(v)} ms` : unknown();
    case 'status': return pill(String(v), statusClass(v));
    case 'deploy': return deployNode(v);
    case 'statuses':
      if (!v || typeof v !== 'object' || Array.isArray(v)) return unknown();
      return Object.keys(v).length ? Object.entries(v).map(([k, n]) => pill(`${k}: ${isNum(n) ? NUM.format(n) : 'unknown'}`)) : h('span', { class: 'muted' }, 'none');
    case 'queries': return table(['Query', 'Clicks', 'Impr.', 'Pos.'], Array.isArray(v) ? v.map((r) => [String(r?.query ?? 'unknown'), fmtNum(r?.clicks) ?? 'unknown', fmtNum(r?.impressions) ?? 'unknown', fmtNum(r?.position) ?? 'unknown']) : v);
    case 'pages': return table(['Page', 'Views'], Array.isArray(v) ? v.map((r) => [String(r?.path ?? 'unknown'), fmtNum(r?.views) ?? 'unknown']) : v);
    default: return typeof v === 'string' || isNum(v) || typeof v === 'boolean' ? String(v) : unknown();
  }
}

const SERIES_LABEL = {
  'errors.events': 'Error events', 'ga4.sessions': 'Sessions (daily)', 'ga4.users': 'Active users (daily)',
  'gsc.clicks': 'Search clicks', 'gsc.impressions': 'Search impressions', 'health.ms': 'Response time (ms)', 
  'revenue.cents': 'Revenue',
};
export const seriesLabel = (m) => SERIES_LABEL[m] ?? m;

const lowerBound = () => h('span', { class: 'pill warn', title: 'The connector hit its page limit: the real number is at least this' }, 'lower bound');

// Links row, built from the registry connector config; a link appears only when its field is set.
export function linksFor(cfg) {
  const out = [];
  const add = (label, href) => { if (href && safeHref(href)) out.push({ label, href }); };
  if (cfg?.gsc?.siteUrl) add('Search Console', `https://search.google.com/search-console?resource_id=${enc(cfg.gsc.siteUrl)}`);
  if (cfg?.ga4?.propertyId) add('GA4', `https://analytics.google.com/analytics/web/#/p${enc(cfg.ga4.propertyId)}/reports/intelligenthome`);
  if (cfg?.lemonsqueezy?.storeId) add('Lemon Squeezy', 'https://app.lemonsqueezy.com/orders');
  if (cfg?.sentry?.org) add('Sentry', `https://sentry.io/organizations/${enc(cfg.sentry.org)}/issues/`);
  if (cfg?.vercel?.teamSlug && cfg?.vercel?.project) add('Vercel', `https://vercel.com/${enc(cfg.vercel.teamSlug)}/${enc(cfg.vercel.project)}`);
  return out;
}

function seriesBlock(projectId, metric, currency = null) {
  const body = h('span', { class: 'sparkbody age' }, 'loading…');
  const slot = h('div', { class: 'sparkslot' }, h('span', { class: 'age' }, seriesLabel(metric)), body);
  api(`api/series?id=${enc(projectId)}&metric=${enc(metric)}&days=30`).then((r) => {
    body.replaceChildren();
    if (r.error) { body.className = 'sparkbody'; body.append(h('span', { class: 'unk' }, `unknown (${r.error})`)); return; }
    const pts = (r.data || []).filter((p) => p && typeof p.day === 'string');
    if (!pts.length) { body.className = 'sparkbody age'; body.append('no history yet'); return; }
    const last = [...pts].reverse().find((p) => isNum(p.value));
    const latest = last ? (metric.includes('cents') ? fmtCents(last.value, currency) : NUM.format(last.value)) : null;
    body.className = 'sparkbody';
    body.append(sparkline(pts), h('span', { class: 'age' }, `${pts[0].day} → ${pts[pts.length - 1].day}${latest ? ' · latest ' + latest : ''}`));
  });
  return slot;
}

function connBlock(id, c, multi) {
  const def = CONNECTORS[id];
  const facts = c.facts[id] || {};
  const run = c.runs.get(id);
  const state = connState(facts, run);
  const block = h('div', { class: 'cblock ' + state });
  if (multi) block.append(h('div', { class: 'csub' }, id));
  if (state === 'not_configured') {
    const names = (run.missing || []).map((m) => h('code', null, m));
    block.append(h('p', { class: 'note warn' }, 'Not connected. Missing: ', names.length ? names.flatMap((n, i) => (i ? [', ', n] : [n])) : 'unknown'));
  } else if (state === 'error') {
    const why = run?.error ?? (typeof facts._error?.error === 'string' ? facts._error.error : null) ?? 'no detail';
    block.append(h('p', { class: 'note risk' }, `unknown (${why})`, hasGood(facts) ? h('span', { class: 'age' }, ' — last good values below, greyed') : null));
  } else if (state === 'never') {
    block.append(h('p', { class: 'muted' }, 'Never ran yet.'));
  }
  if (!hasGood(facts) || state === 'never') return block;
  const grey = state === 'error' || state === 'not_configured' || Object.values(facts).some((f) => f.stale);
  const currency = def.currencyKey ? facts[def.currencyKey]?.value ?? null : null;
  const dl = h('dl', { class: 'facts' + (grey ? ' grey' : '') });
  for (const [label, key, kind, lb] of def.rows) {
    const f = facts[key];
    const dd = h('dd', null, f && 'value' in f ? valueNode(kind, f.value, currency) : unknown());
    if (lb && facts[lb]?.value === true) dd.append(' ', lowerBound());
    dl.append(h('dt', null, label), dd);
  }
  block.append(dl);
  if (def.lag) {
    const day = facts[def.lag[0]]?.value;
    block.append(h('p', { class: 'age lagnote' }, def.lag[1] + (typeof day === 'string' ? day : 'unknown')));
  }
  for (const m of def.series) block.append(seriesBlock(c.projectId, m, currency));
  return block;
}

function newestAt(conns, facts) {
  let best = null;
  for (const id of conns) {
    for (const [k, f] of Object.entries(facts[id] || {})) {
      if (k === '_error') continue;
      const t = Date.parse(f.at);
      if (!Number.isNaN(t) && (best === null || t > best)) best = t;
    }
  }
  return best;
}

function eventsBlock(c) {
  const body = h('div', { class: 'cblock ok' });
  if (c.eventsError) return body.appendChild(h('p', { class: 'note risk' }, `unknown (${c.eventsError})`)) && body;
  if (!c.events.length) return body.appendChild(h('p', { class: 'muted' }, 'No messages, claims or orders in the last 7 days.')) && body;
  body.append(h('ul', { class: 'feedlist' }, c.events.slice(0, 8).map((e) => {
    const href = safeHref(e.url);
    const t = e.title || e.kind;
    return h('li', { class: 'feedrow' }, h('span', { class: 'age feedtime', title: e.at }, ago(e.at)), h('span', { class: 'glyph', title: e.kind }, GLYPH[e.kind] ?? '•'),
      href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t) : t);
  })));
  return body;
}

function tileFor(def, c) {
  const rel = def.conns.filter((id) => c.cfg[id] !== undefined || Object.keys(c.facts[id] || {}).length > 0);
  if (def.events) {
    if (!c.events.length && !c.eventsError) return null;
  } else if (!rel.length) return null;
  const upd = def.events ? null : newestAt(rel, c.facts);
  const tile = h('section', { class: 'tile' },
    h('h3', null, def.title, upd == null ? null : h('span', { class: 'age', title: new Date(upd).toISOString() }, `updated ${ago(upd)}`)));
  if (def.events) tile.append(eventsBlock(c));
  else for (const id of rel) tile.append(connBlock(id, c, rel.length > 1));
  return tile;
}

export async function renderLive(el, sub) {
  const { p, ctx } = sub;
  const id = p.id;
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const [facts, conns, cfg, evs] = await Promise.all([
    api(`api/facts?id=${enc(id)}`), api('api/connectors'), api(`api/connectors/config?id=${enc(id)}`),
    api(`api/events?id=${enc(id)}&kinds=message,claim,order&since=${enc(since)}&limit=20`),
  ]);
  if (ctx.stale()) return;
  if (facts.error) { el.append(h('p', { class: 'note risk' }, `unknown (${facts.error})`)); return; }
  const runs = new Map();
  for (const cn of conns.data || []) {
    const mine = (cn.projects || []).find((x) => x.project === id);
    if (mine) runs.set(cn.id, mine);
  }
  const c = { projectId: id, facts: facts.data || {}, cfg: cfg.data || {}, runs, events: evs.data || [], eventsError: evs.error };
  const links = linksFor(c.cfg);
  if (links.length) el.append(h('div', { class: 'row linksrow' }, h('span', { class: 'k' }, 'Open'), links.map((l) => h('a', { class: 'pill link', href: l.href, target: '_blank', rel: 'noopener noreferrer' }, l.label + ' ↗'))));
  if (cfg.error) el.append(h('p', { class: 'note warn' }, `Connector configuration unknown (${cfg.error}); links and unconfigured tiles are hidden`));
  if (conns.error) el.append(h('p', { class: 'note warn' }, `Connector status unknown (${conns.error})`));
  const tiles = TILES.map((d) => tileFor(d, c)).filter(Boolean);
  if (!tiles.length && cfg.error) return;
  if (!tiles.length) { el.append(h('p', { class: 'muted' }, 'No live connectors are configured for this project. Add them under connectors in registry.json.')); return; }
  el.append(h('p', { class: 'muted small' }, 'Money is shown in EUR as stored; nothing is converted.'), h('div', { class: 'tiles' }, tiles));
}
