// Pure models for the Development tab. No DOM, no imports from ui.js or pages/*.
export const hasGood = (facts) => !!facts && Object.keys(facts).some((k) => k !== '_error');

export function connState(facts, run) {
  if (run?.status === 'not_configured') return 'not_configured';
  if (facts?._error || run?.status === 'error') return 'error';
  return hasGood(facts) ? 'ok' : 'never';
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fv = (src, key) => src?.[key]?.value ?? null;
const numOrNull = (v) => (isNum(v) ? v : null);
const time = (t) => { const n = Date.parse(t ?? ''); return Number.isFinite(n) ? n : 0; };
const newestFirst = (a, b) => time(b.at) - time(a.at);

function* walk(plan) {
  for (const m of plan?.milestones ?? []) {
    for (const s of m.sprints ?? []) {
      const where = /#0$/.test(String(s.id ?? '')) ? m.title : `${m.title} › ${s.title}`;
      for (const it of s.items ?? []) yield { ...it, where, milestone: m.title };
    }
  }
}

export const isMasterPlan = (plan) => plan?.source === 'master-plan';

// Now / Next only mean something for a PLAN.md; checkbox docs have no real state ordering.
export function nowNext(plan, { nextLimit = 5 } = {}) {
  if (!isMasterPlan(plan)) return { supported: false, now: [], blocked: [], next: [], total: 0, done: 0 };
  const all = [...walk(plan)];
  return {
    supported: true,
    now: all.filter((i) => i.state === 'in_progress'),
    blocked: all.filter((i) => i.state === 'blocked'),
    next: all.filter((i) => i.state === 'planned').slice(0, nextLimit),
    total: all.length,
    done: all.filter((i) => i.state === 'done').length,
  };
}

export function itemsOfKind(plan, kind, { openOnly = true } = {}) {
  return [...walk(plan)].filter((i) => i.kind === kind && (!openOnly || i.state !== 'done'));
}

export function testsModel(testsFact, actions) {
  let file = null;
  let fileError = null;
  const v = testsFact?.value;
  if (v && typeof v === 'object') {
    file = {
      at: v.at ?? testsFact.at ?? null, passed: v.passed, failed: v.failed, skipped: v.skipped,
      total: v.total, durationMs: v.durationMs, command: v.command, ok: v.failed === 0,
    };
  } else if (testsFact && typeof testsFact.error === 'string') fileError = testsFact.error;

  const cands = (Array.isArray(actions) ? actions : []).filter((a) => a?.kind === 'run' && a.state && (/\btests?\b/i.test(a.id ?? '') || /\btests?\b/i.test(a.label ?? '')));
  const running = cands.find((a) => a.state.status === 'running');
  const best = running ?? [...cands].sort((a, b) => time(b.state.endedAt) - time(a.state.endedAt))[0] ?? null;
  const run = best ? { id: best.id, label: best.label, state: best.state } : null;

  let verdict = 'unknown';
  if (run?.state.status === 'running') verdict = 'running';
  else {
    const fileT = file ? time(file.at) : -1;
    const runT = run ? time(run.state.endedAt) : -1;
    if (file && (!run || fileT >= runT)) verdict = file.ok ? 'pass' : 'fail';
    else if (run) verdict = run.state.exitCode === 0 ? 'pass' : 'fail';
  }
  return { file, fileError, run, verdict };
}

export function deployModel(facts, run) {
  const v = facts?.vercel;
  return {
    state: connState(v, run),
    production: fv(v, 'deploy.production'),
    preview: fv(v, 'deploy.preview'),
    failed24h: numOrNull(fv(v, 'deploy.failed_24h')),
  };
}

export function bugsModel(facts, run, events, plan) {
  const s = facts?.sentry;
  const state = connState(s, run);
  const base = {
    state, unresolved: numOrNull(fv(s, 'issues.unresolved')), eventsToday: numOrNull(fv(s, 'events.today')),
    truncated: fv(s, 'issues.truncated'),
  };
  if (hasGood(s)) {
    const list = (events ?? []).filter((e) => e.kind === 'error').sort(newestFirst).slice(0, 10);
    return { source: 'sentry', ...base, list };
  }
  const open = isMasterPlan(plan) ? itemsOfKind(plan, 'bug') : [];
  if (open.length) return { source: 'plan', ...base, list: open };
  return { source: 'none', ...base, list: [] };
}

export function ideasModel(plan) {
  const groups = [];
  for (const it of itemsOfKind(plan, 'idea')) {
    let g = groups.find((x) => x.milestone === it.milestone);
    if (!g) groups.push(g = { milestone: it.milestone, items: [] });
    g.items.push(it);
  }
  return { groups, count: groups.reduce((n, g) => n + g.items.length, 0) };
}
