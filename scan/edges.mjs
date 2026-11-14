// Links between projects, derived once per scan from the projects' uses, connects and git facts. Pure: no file I/O.
// Edge = { a, b, kind: 'uses' | 'connects' | 'repo', service? }. A uses edge has b = service = serviceId(...).
// Service = { id, name, count }: name is the first raw spelling seen, count the projects using it.
import { norm } from '../lib/paths.mjs';
import { stripCredentials } from './git.mjs';

export const SERVICE_ALIASES = {
  'neon eu': 'neon',
  'neon db': 'neon',
  'neon database': 'neon',
  'vercel.com': 'vercel',
};

// Trims, lower-cases, applies SERVICE_ALIASES, then turns spaces into hyphens.
export function serviceId(name) {
  const s = String(name ?? '').trim().toLowerCase();
  const aliased = Object.hasOwn(SERVICE_ALIASES, s) ? SERVICE_ALIASES[s] : s;
  return aliased.replace(/\s+/g, '-');
}

// The text of a uses/connects entry before any '#' comment, trimmed.
const entryName = (text) => String(text ?? '').split('#')[0].trim();

// Same matching as the web project page's findUsed: case-insensitive id, name or noteId.
function resolveProject(text, projects) {
  const key = entryName(text).toLowerCase();
  if (!key) return undefined;
  return projects.find((p) => p.id.toLowerCase() === key
    || String(p.name ?? '').toLowerCase() === key
    || String(p.noteId ?? '').toLowerCase() === key);
}

const repoKey = (url) => stripCredentials(String(url)).trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
const pathKey = (p) => norm(p).toLowerCase();

// Remote URLs and worktree paths of one project's git facts; errored facts contribute nothing.
function gitIdentity(project) {
  const remotes = new Set();
  const worktrees = new Set();
  for (const r of project.repos ?? []) {
    const v = r?.git?.value;
    if (!v) continue;
    for (const url of v.remotes ?? []) remotes.add(repoKey(url));
    for (const w of v.worktrees ?? []) if (w?.path) worktrees.add(pathKey(w.path));
  }
  return { remotes, worktrees };
}

export function projectEdges(projects) {
  const edges = [];
  const seen = new Set();
  const add = (edge) => {
    const key = [edge.a, edge.b, edge.kind, edge.service ?? ''].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  const services = new Map();
  for (const p of projects) {
    const distinct = new Set();
    for (const text of p.uses ?? []) {
      const target = resolveProject(text, projects);
      if (target) {
        if (target.id !== p.id) add({ a: p.id, b: target.id, kind: 'connects' });
        continue;
      }
      const id = serviceId(entryName(text));
      if (!id) continue;
      if (!services.has(id)) services.set(id, { id, name: entryName(text), count: 0 });
      if (!distinct.has(id)) {
        distinct.add(id);
        services.get(id).count++;
        add({ a: p.id, b: id, kind: 'uses', service: id });
      }
    }
    for (const text of p.connects ?? []) {
      const target = resolveProject(text, projects);
      if (target && target.id !== p.id) add({ a: p.id, b: target.id, kind: 'connects' });
    }
  }

  const identities = new Map(projects.map((p) => [p.id, gitIdentity(p)]));
  const homes = new Map(projects.filter((p) => p.home).map((p) => [p.id, pathKey(p.home)]));
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const p = projects[i];
      const q = projects[j];
      if (p.id === q.id) continue;
      const ip = identities.get(p.id);
      const iq = identities.get(q.id);
      const sharedRemote = [...ip.remotes].some((r) => iq.remotes.has(r));
      const homeInWorktrees = (homes.has(q.id) && ip.worktrees.has(homes.get(q.id)))
        || (homes.has(p.id) && iq.worktrees.has(homes.get(p.id)));
      if (!sharedRemote && !homeInWorktrees) continue;
      const [a, b] = p.id < q.id ? [p.id, q.id] : [q.id, p.id];
      add({ a, b, kind: 'repo' });
    }
  }

  const sortedServices = [...services.values()].sort((x, y) => y.count - x.count || x.id.localeCompare(y.id));
  return { edges, services: sortedServices };
}
