import { need, needArr, registryTargets, dayOf } from '../lib/need.mjs';

const HOST = 'api.lemonsqueezy.com';
const BASE = `https://${HOST}`;
const DAY_MS = 86_400_000;
const MAX_PAGES = 5;
// Orders in these states are not income.
const NOT_INCOME = new Set(['refunded', 'failed', 'pending']);

const headers = (ctx) => ({ Authorization: `Bearer ${ctx.getSecret('LEMONSQUEEZY_API_KEY')}`, Accept: 'application/vnd.api+json' });

// Follows JSON:API `links.next` (same host only) for at most MAX_PAGES pages; returns the concatenated `data`.
async function pages(ctx, firstUrl, opts, stop) {
  const out = [];
  let url = firstUrl;
  for (let i = 0; i < MAX_PAGES && url; i += 1) {
    if (new URL(url).host !== HOST) throw new Error(`pagination link leaves ${HOST}`);
    const { json } = await ctx.fetchJson(url, opts);
    const data = Array.isArray(json?.data) ? json.data : null;
    if (!data) throw new Error('missing data in response');
    out.push(...data);
    if (stop?.(data)) return { data: out, complete: true };
    url = typeof json.links?.next === 'string' ? json.links.next : null;
  }
  return { data: out, complete: url === null };
}

export default {
  id: 'lemonsqueezy',
  every: '1h',
  secrets: ['LEMONSQUEEZY_API_KEY'],
  required: ['storeId'],
  note: 'storeId: list your stores with the Discover link (Settings, connector row, discover) once the key is set',
  targets: (registry) => registryTargets(registry, 'lemonsqueezy', (c) => ({ storeId: c.storeId ?? null })),
  async fetch(target, ctx) {
    const opts = { headers: headers(ctx), allowHosts: [HOST] };
    const now = ctx.now();
    const cutoff = now - 30 * DAY_MS;
    const q = (extra) => new URLSearchParams({ 'filter[store_id]': String(target.storeId), ...extra }).toString();
    // Newest first: stop paging once a page reaches past the 30-day window.
    const ordersRes = await pages(ctx, `${BASE}/v1/orders?${q({ 'page[size]': '100', sort: '-created_at' })}`, opts, (d) => {
      const last = Date.parse(d[d.length - 1]?.attributes?.created_at);
      return Number.isFinite(last) && last < cutoff;
    });
    const subscriptions = (await pages(ctx, `${BASE}/v1/subscriptions?${q({ 'page[size]': '100' })}`, opts)).data;
    return { orders: ordersRes.data, ordersComplete: ordersRes.complete, subscriptions, now };
  },
  async discover(ctx) {
    const { json } = await ctx.fetchJson(`${BASE}/v1/stores`, { headers: headers(ctx), allowHosts: [HOST] });
    return needArr(json, 'data').map((s) => ({ id: String(need(s, 'id')), name: need(s, 'attributes.name'), slug: s.attributes?.slug ?? null, currency: s.attributes?.currency ?? null }));
  },
  parse(raw) {
    const orders = needArr(raw, 'orders');
    const subs = needArr(raw, 'subscriptions');
    const now = need(raw, 'now');
    for (const o of orders) {
      need(o, 'id');
      need(o, 'attributes.created_at');
      if (!Number.isFinite(Date.parse(o.attributes.created_at))) throw new Error('missing valid attributes.created_at in order');
      if (typeof o.attributes.total !== 'number' || !Number.isFinite(o.attributes.total)) throw new Error(`missing attributes.total in order ${o.id}`);
    }
    for (const s of subs) need(s, 'attributes.status');

    const at = (o) => Date.parse(o.attributes.created_at);
    const paid = orders.filter((o) => !NOT_INCOME.has(o.attributes.status) && at(o) >= now - 30 * DAY_MS && at(o) <= now);
    // Zero-filled for every UTC day of the window: series rows are upserted never deleted, so a day whose only order
    // was refunded must be rewritten as 0. If the page cap cut the history short, only days strictly after the oldest
    // fetched order's day are fully covered; older days are left alone.
    const complete = raw.ordersComplete !== false;
    const oldest = orders.length ? Math.min(...orders.map(at)) : null;
    const firstDay = complete || oldest === null ? dayOf(now - 30 * DAY_MS) : dayOf(oldest + DAY_MS);
    const perDay = new Map();
    for (let t = Date.parse(dayOf(now - 30 * DAY_MS)); t <= Date.parse(dayOf(now)); t += DAY_MS) if (dayOf(t) >= firstDay) perDay.set(dayOf(t), 0);
    for (const o of paid) {
      const d = dayOf(at(o));
      if (perDay.has(d)) perDay.set(d, perDay.get(d) + o.attributes.total);
    }
    const active = subs.filter((s) => s.attributes.status === 'active');
    // Lemon Squeezy subscriptions do not expose a price, so MRR is unknown (null) unless every active subscription
    // happens to carry a numeric first_subscription_item.price (cents, billing interval ignored). The Money page
    // (Stage 5) will compute real MRR from variants. A number is never invented here.
    const prices = active.map((s) => s.attributes.first_subscription_item?.price);
    const mrr = active.length === 0 ? 0 : prices.every((p) => typeof p === 'number' && Number.isFinite(p)) ? prices.reduce((a, b) => a + b, 0) : null;

    return {
      facts: [
        { key: 'orders.30d', value: paid.length },
        { key: 'orders.truncated', value: !complete },
        { key: 'revenue.30d_cents', value: paid.reduce((s, o) => s + o.attributes.total, 0) },
        { key: 'revenue.currency', value: typeof orders[0]?.attributes?.currency === 'string' ? orders[0].attributes.currency : null },
        { key: 'subscriptions.active', value: active.length },
        { key: 'mrr_cents', value: mrr },
      ],
      series: [...perDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, value]) => ({ metric: 'revenue.cents', day, value })),
      events: paid
        .filter((o) => at(o) >= now - DAY_MS)
        .map((o) => ({
          kind: 'order',
          at: new Date(at(o)).toISOString(),
          title: `${o.attributes.user_name ?? 'Customer'} · ${o.attributes.total_formatted ?? (o.attributes.total / 100).toFixed(2)}`,
          url: `https://app.lemonsqueezy.com/orders/${encodeURIComponent(String(o.id))}`, // not the signed receipt URL, which the mask breaks
          external_id: String(o.id),
        })),
    };
  },
};
