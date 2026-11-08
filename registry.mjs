import { readFileSync, existsSync } from 'node:fs';
import { norm } from './lib/paths.mjs';

const KINDS = new Set(['project', 'shared', 'tool', 'data', 'media']);

export function loadRegistry(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  const homes = new Map();
  for (const [id, e] of Object.entries(raw.projects ?? {})) {
    const home = norm(e.home);
    const key = home.toLowerCase();
    if (homes.has(key)) throw new Error(`duplicate home ${home}: ${homes.get(key)} and ${id}`);
    homes.set(key, id);
    const kind = e.kind ?? 'project';
    if (!KINDS.has(kind)) throw new Error(`${id}: invalid kind ${kind}`);
    const repos = e.repos ? e.repos.map(norm) : existsSync(`${home}/.git`) ? [home] : [];
    map.set(id, {
      id,
      name: e.name ?? id,
      family: e.family ?? 'Other',
      kind,
      home,
      repos,
      worktreesManaged: (e.worktreesManaged ?? []).map(norm),
      oldPaths: (e.oldPaths ?? []).map(norm),
      protected: e.protected === true,
      note: e.note ?? null,
      uses: e.uses ?? [],
      connectors: e.connectors ?? {},
    });
  }
  return map;
}

export function rootsOf(entry, discoveredWorktrees = []) {
  const seen = new Set();
  const out = [];
  for (const p of [entry.home, ...entry.repos, ...entry.worktreesManaged, ...discoveredWorktrees]) {
    const n = norm(p);
    const k = n.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  }
  return out;
}
