import { isUnder, norm, canon } from '../lib/paths.mjs';

// Attention flags: what needs a human. Unknown (null / missing fact) is never turned into a flag
// about the thing itself; at most a "facts incomplete" warning.
const DAY = 86400000;
const BLOCKER_DAYS = 14;

// ctx = { registeredRoots, toolHomes } (all registry roots / homes of kind 'tool'), used to decide which discovered
// worktrees are unmapped.
export function attentionFlags(p, now = Date.now(), ctx = { registeredRoots: [], toolHomes: [] }) {
  if (p.status === 'archived' || p.status === 'terminated') return [];
  const flags = [];
  const risk = (text) => flags.push({ level: 'risk', text });
  const warn = (text) => flags.push({ level: 'warn', text });

  if (p.exists === false) risk(`home missing: ${p.home}`);

  const roots = [...(ctx.registeredRoots ?? []), ...(p.worktreesManaged ?? [])];
  const repoPaths = new Set((p.repos ?? []).map((r) => canon(r.path).toLowerCase()));
  const homeKey = p.home ? canon(p.home).toLowerCase() : null;
  // git reports worktree paths canonically; registry paths may be symlinked or 8.3 short forms
  const canonRoots = [...roots, ...(ctx.toolHomes ?? [])].map(canon);
  for (const r of p.repos ?? []) {
    const g = r.git;
    if (!g || g.error || !g.value) { risk(`${r.path}: git unreadable: ${g?.error ?? 'no facts'}`); continue; }
    const v = g.value;
    if (v.remotes === null || v.remotes === undefined) warn(`${r.path}: git facts incomplete`);
    else if (v.remotes.length === 0 && p.kind !== 'data' && p.kind !== 'tool') risk(`${r.path}: no remote`);
    if (v.localOnlyCommits > 0) warn(`${r.path}: ${v.localOnlyCommits} commits not on GitHub`);
    const dirty = (v.modified ?? 0) + (v.untracked ?? 0);
    if (dirty > 0) warn(`${r.path}: ${dirty} uncommitted`);
    for (const w of v.worktrees ?? []) {
      const wp = canon(w.path);
      const key = wp.toLowerCase();
      if (w.prunable || repoPaths.has(key) || key === homeKey) continue;
      if (canonRoots.some((r) => isUnder(wp, r))) continue;
      if (/(^|\/)\.claude\/worktrees\//i.test(norm(w.path))) continue;
      warn(`${r.path}: unmapped worktree ${w.path}`);
    }
  }

  if (p.graph?.error) warn(`graph not read: ${p.graph.error}`);

  for (const b of p.blockers ?? []) {
    if (b.done || !b.since) continue;
    const age = (now - Date.parse(b.since)) / DAY;
    if (age > BLOCKER_DAYS) warn(`blocker open ${Math.floor(age)} days: ${b.text}`);
  }

  return flags;
}
