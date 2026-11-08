import { need, needArr, registryTargets } from '../lib/need.mjs';

const HOST = 'api.vercel.com';
const DAY_MS = 86_400_000;

const oneLine = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\r?\n/)[0] : null);
const opts = (ctx) => ({ headers: { Authorization: `Bearer ${ctx.getSecret('VERCEL_TOKEN')}` }, allowHosts: [HOST] });

export default {
  id: 'vercel',
  every: '15m',
  secrets: ['VERCEL_TOKEN'],
  required: ['vercelProject'],
  fieldNames: { vercelProject: 'project' },
  targets: (registry) => registryTargets(registry, 'vercel', (c) => ({ vercelProject: c.project ?? null, teamId: c.teamId ?? null })),
  async fetch(target, ctx) {
    const o = opts(ctx);
    const get = async (tgt, limit) => {
      const q = new URLSearchParams({ projectId: target.vercelProject, limit: String(limit), target: tgt });
      if (target.teamId) q.set('teamId', target.teamId);
      return (await ctx.fetchJson(`https://${HOST}/v6/deployments?${q}`, o)).json;
    };
    return { production: await get('production', 10), preview: await get('preview', 5), now: ctx.now() };
  },
  // { teams, projects }: teams give the id (vercel.teamId) and slug (vercel.teamSlug); projects are scoped to ctx.teamId when set.
  async discover(ctx) {
    const o = opts(ctx);
    const q = new URLSearchParams({ limit: '100' });
    if (ctx.teamId) q.set('teamId', ctx.teamId);
    const [t, p] = await Promise.all([ctx.fetchJson(`https://${HOST}/v2/teams?limit=100`, o), ctx.fetchJson(`https://${HOST}/v9/projects?${q}`, o)]);
    return {
      teams: needArr(t.json, 'teams').map((x) => ({ id: need(x, 'id'), slug: need(x, 'slug'), name: x.name ?? null })),
      projects: needArr(p.json, 'projects').map((x) => ({ id: need(x, 'id'), name: need(x, 'name'), framework: x.framework ?? null })),
    };
  },
  parse(raw) {
    const now = need(raw, 'now');
    const read = (resp, label) =>
      needArr(resp, 'deployments').map((d) => {
        const state = d.state ?? d.readyState;
        if (typeof d.uid !== 'string' || typeof state !== 'string' || typeof d.created !== 'number' || typeof d.url !== 'string') throw new Error(`missing uid/state/created/url in ${label} deployment`);
        return { uid: d.uid, state, created: d.created, url: `https://${d.url}`, commit: oneLine(d.meta?.githubCommitMessage), sha: d.meta?.githubCommitSha ?? null, label };
      });
    const prod = read(raw.production, 'production');
    const prev = read(raw.preview, 'preview');
    const newest = (list) => list.reduce((a, b) => (!a || b.created > a.created ? b : a), null);
    const fact = (d) => (d ? { state: d.state, createdAt: new Date(d.created).toISOString(), url: d.url, commit: d.commit, sha: d.sha } : null);
    const recent = [...prod, ...prev].filter((d) => d.created >= now - DAY_MS);
    return {
      facts: [
        { key: 'deploy.production', value: fact(newest(prod)) },
        { key: 'deploy.preview', value: fact(newest(prev)) },
        { key: 'deploy.failed_24h', value: recent.filter((d) => d.state === 'ERROR').length },
      ],
      series: [],
      events: recent.map((d) => ({
        kind: 'deploy',
        at: new Date(d.created).toISOString(),
        title: d.commit ? `${d.label} ${d.state} · ${d.commit}` : `${d.label} ${d.state}`,
        url: d.url,
        external_id: d.uid,
        json: { state: d.state },
      })),
    };
  },
};
