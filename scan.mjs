// Builds <home>/data/projects.json (and ARCHITECTURE.md + the MOC status table) from <home>/registry.json, the vault
// project notes and live facts. Writes only: data/projects.json, data/size-cache.json, config.architectureFile
// and the dashboard block inside config.mocFile. Exit code is 0 even when facts fail.
// Flags: --home <dir> (instance folder, default OVERMAP_HOME or ~/.overmap), --no-size (skip the disk walk), --quiet.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { resolveHome, ensureHome } from './lib/home.mjs';
import { norm } from './lib/paths.mjs';
import { loadRegistry, rootsOf } from './registry.mjs';
import { systemSnapshot } from './scan/system.mjs';
import { unmappedFolders } from './scan/refs.mjs';
import { readCodexProjects, readClaudeProjects, unmappedAgentProjects, mergeUnmapped } from './scan/agents.mjs';
import { writeArchitecture } from './scan/architecture.mjs';
import { buildProjectSafe, fail } from './scan/project.mjs';
import { loadSizeCache, saveSizeCache, mocTable, updateMoc, writeIfChanged } from './scan/assemble.mjs';

const SKIP_SIZE = process.argv.includes('--no-size');
const QUIET = process.argv.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

const home = resolveHome();
ensureHome(home);
const config = loadConfig(home);
const dataDir = join(home, 'data');
const registry = loadRegistry(join(home, 'registry.json'));
const cache = loadSizeCache(join(dataDir, 'size-cache.json'));
const started = Date.now();

const snapshot = await systemSnapshot().catch(fail);
const allEntries = [...registry.values()];
const attentionCtx = {
  registeredRoots: allEntries.flatMap((e) => rootsOf(e)),
  toolHomes: allEntries.filter((e) => e.kind === 'tool').map((e) => e.home),
};
const ctx = { snapshot, cache, skipSize: SKIP_SIZE, attentionCtx };

const projects = [];
for (const entry of registry.values()) {
  const t = Date.now();
  projects.push(await buildProjectSafe(entry, ctx));
  log(`${entry.id}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
saveSizeCache(join(dataDir, 'size-cache.json'), cache);

const extraRoots = projects.flatMap((p) => p.repos.flatMap((r) => r.git.value?.worktrees?.map((w) => w.path) ?? []));
const folderUnmapped = unmappedFolders(registry, undefined, extraRoots);
const codex = readCodexProjects();
const claude = readClaudeProjects();
for (const [n, r] of [['codex', codex], ['claude', claude]]) if (r.error) console.error(`agent projects (${n}) not read: ${r.error}`);
const unmappedSources = { codex: codex.error ? { error: codex.error } : { count: codex.value.length }, claude: claude.error ? { error: claude.error } : { count: claude.value.length } };
const agentUnmapped = unmappedAgentProjects(registry, [...(codex.value ?? []), ...(claude.value ?? [])], extraRoots);
const unmapped = mergeUnmapped(folderUnmapped, agentUnmapped);
const scanSeconds = Math.round((Date.now() - started) / 1000);
const out = { generatedAt: new Date().toISOString(), scanSeconds, projects, unmapped, unmappedSources };
writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(out, null, 2));

let archWritten = false, mocWritten = false;
try { writeIfChanged(norm(config.architectureFile), writeArchitecture(projects, registry, config, unmapped)); archWritten = true; } catch (e) { console.error(`ARCHITECTURE.md not written: ${e.message}`); }
try { mocWritten = updateMoc(config.mocFile, mocTable(projects)); } catch (e) { console.error(`MOC not updated: ${e.message}`); }

const risky = projects.filter((p) => p.attention.some((f) => f.level === 'risk')).length;
console.log(`done: ${projects.length} projects in ${scanSeconds}s · ${risky} with risk flags · ${unmapped.length} unmapped · ARCHITECTURE.md ${archWritten ? 'written' : 'FAILED'} · MOC ${mocWritten ? 'refreshed' : 'not found, skipped'}`);
