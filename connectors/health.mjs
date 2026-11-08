import { maskText } from '../lib/mask.mjs';

// Is the project's health URL answering? A down service is a VALUE (health.status 'down'), not a connector error.
export default {
  id: 'health',
  every: '5m',
  secrets: [],
  required: ['url'],
  targets(registry) {
    const out = [];
    for (const [id, entry] of registry) {
      const cfg = entry.connectors?.health;
      if (cfg) out.push({ project: id, url: cfg.url ?? null });
    }
    return out;
  },
  async fetch(target, ctx) {
    const host = new URL(target.url).host;
    const t0 = Date.now();
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    try {
      await ctx.fetchJson(target.url, { allowHosts: [host], timeoutMs: 10_000 });
      return { up: true, ms: Date.now() - t0, day };
    } catch (e) {
      return { up: false, ms: null, reason: maskText(String(e?.message ?? e)).slice(0, 200), day };
    }
  },
  parse(raw) {
    return {
      facts: [
        { key: 'health.status', value: raw.up ? 'up' : 'down' },
        { key: 'health.ms', value: raw.ms },
        { key: 'health.reason', value: raw.up ? null : (raw.reason ?? 'unknown') },
      ],
      series: raw.up ? [{ metric: 'health.ms', day: raw.day, value: raw.ms, merge: 'max' }] : [],
      events: [],
    };
  },
};
