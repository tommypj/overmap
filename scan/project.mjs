// Builds one Project from a registry entry + facts. A failure in one project never stops the scan:
// buildProjectSafe returns a minimal "scan failed" project instead.
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { readNote, parseBlockers } from '../lib/frontmatter.mjs';
import { rootsOf } from '../registry.mjs';
import { gitFacts } from './git.mjs';
import { readTestResults } from './tests.mjs';
import { pickReader } from '../plan/reader.mjs';
import { attentionFlags } from './attention.mjs';
import { dirSize, cachedSize, memoryNotes, readCard } from './assemble.mjs';
import { graphFact } from './graph.mjs';

export const fail = (e) => ({ at: new Date().toISOString(), error: e?.message ?? String(e) });
const str = (x) => String(x ?? '');
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ctx = { cache, skipSize, attentionCtx, graphOpts, graph? } (graph defaults to graphFact; graphOpts = { maxBytes })
export async function buildProject(entry, ctx) {
  const home = entry.home;
  const exists = existsSync(home);
  let note = { data: {}, body: '' };
  if (entry.note && existsSync(entry.note)) { try { note = readNote(entry.note); } catch { /* unreadable note */ } }
  const card = exists ? readCard(home) : null;
  const c = card?.data ?? {};

  const repos = [];
  for (const path of entry.repos) {
    repos.push({ path, git: exists || existsSync(path) ? await gitFacts(path).catch(fail) : fail('path missing') });
  }
  const discovered = repos.flatMap((r) => r.git.value?.worktrees?.map((w) => w.path) ?? []);
  const roots = rootsOf(entry, discovered);

  const tests = readTestResults(roots);
  let graph;
  try { graph = await (ctx.graph ?? graphFact)(home, ctx.graphOpts); } catch (e) { graph = { at: new Date().toISOString(), value: null, error: e?.message ?? String(e) }; }

  let plan;
  try { plan = { at: new Date().toISOString(), value: (await pickReader(home)?.read(home)) ?? null }; } catch (e) { plan = fail(e); }

  const family = c.family ?? (entry.family !== 'Other' ? entry.family : note.data.group ?? 'Other');
  const project = {
    id: entry.id,
    noteId: entry.note ? basename(entry.note).replace(/\.md$/, '') : entry.id,
    name: str(c.name ?? entry.name),
    note: entry.note ?? null,
    card: card?.file ?? null,
    status: str(c.status ?? note.data.status ?? (entry.note ? 'undecided' : 'active')),
    group: str(family),
    summary: str(c.purpose ?? note.data.summary),
    path: home,
    deploy: arr(note.data.deploy),
    links: arr(note.data.links),
    stack: arr(note.data.stack),
    blockers: parseBlockers(note.body).filter((b) => !b.done),
    exists,
    size: !exists ? null : ctx.skipSize ? cachedSize(home, ctx.cache) : await dirSize(home, ctx.cache).catch(() => null),
    memory: memoryNotes(arr(note.data.memory).map(str)),
    kind: entry.kind,
    home,
    uses: arr(c.uses ?? entry.uses).map(str),
    connects: arr(note.data.connects ?? entry.connects).map(str),
    roots,
    protected: entry.protected,
    worktreesManaged: entry.worktreesManaged,
    repos, tests, plan, graph,
  };
  project.attention = attentionFlags(project, Date.now(), ctx.attentionCtx);
  return project;
}

export async function buildProjectSafe(entry, ctx) {
  try {
    return await buildProject(entry, ctx);
  } catch (e) {
    return {
      id: entry.id, noteId: entry.note ? basename(entry.note).replace(/\.md$/, '') : entry.id,
      name: str(entry.name), note: entry.note ?? null, card: null, status: 'unknown', group: str(entry.family), summary: '',
      path: entry.home, deploy: [], links: [], stack: [], blockers: [], exists: existsSync(entry.home),
      size: null, memory: [], kind: entry.kind, home: entry.home, uses: [], connects: [], roots: [entry.home], protected: entry.protected,
      worktreesManaged: entry.worktreesManaged ?? [],
      repos: [], tests: null, plan: null, graph: null,
      attention: [{ level: 'risk', text: `scan failed: ${e?.message ?? e}` }],
    };
  }
}
