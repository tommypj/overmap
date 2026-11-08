import { isUnder, norm } from '../lib/paths.mjs';

// Attention flags: what needs a human. Unknown (null / missing fact) is never turned into a flag
// about the thing itself; at most a "facts incomplete" warning.
const DAY = 86400000;
const BLOCKER_DAYS = 14;
const BACKUP_HOURS = 36;

// ctx = { registeredRoots, toolHomes } (all registry roots / homes of kind 'tool'), used to decide which discovered
// worktrees are unmapped.
export function attentionFlags(p, now = Date.now(), ctx = { registeredRoots: [], toolHomes: [] }) {
  if (p.status === 'archived' || p.status === 'terminated') return [];
  const flags = [];
  const risk = (text) => flags.push({ level: 'risk', text });
  const warn = (text) => flags.push({ level: 'warn', text });

  if (p.exists === false) risk(`home missing: ${p.home}`);

  const roots = [...(ctx.registeredRoots ?? []), ...(p.worktreesManaged ?? [])];
  const repoPaths = new Set((p.repos ?? []).map((r) => r.path.toLowerCase()));
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
      const key = String(w.path).toLowerCase();
      if (w.prunable || repoPaths.has(key) || key === String(p.home).toLowerCase()) continue;
      if (roots.some((r) => isUnder(w.path, r)) || (ctx.toolHomes ?? []).some((r) => isUnder(w.path, r))) continue;
      if (/(^|\/)\.claude\/worktrees\//i.test(norm(w.path))) continue;
      warn(`${r.path}: unmapped worktree ${w.path}`);
    }
  }

  for (const b of p.blockers ?? []) {
    if (b.done || !b.since) continue;
    const age = (now - Date.parse(b.since)) / DAY;
    if (age > BLOCKER_DAYS) warn(`blocker open ${Math.floor(age)} days: ${b.text}`);
  }

  const backupHost = p.backup?.value?.targets?.find((t) => t.target === 'backup-host' && !t.error);
  if (backupHost) {
    if (backupHost.covered === false) risk('not covered by backup-host backup');
    if (backupHost.finished && now - Date.parse(backupHost.finished) > BACKUP_HOURS * 3600000) warn(`backup-host backup older than ${BACKUP_HOURS} h`);
    if (typeof backupHost.exitCode === 'number' && backupHost.exitCode !== 0 && backupHost.exitCode !== 3) warn(`backup-host backup failed (exit ${backupHost.exitCode})`);
  }
  return flags;
}
