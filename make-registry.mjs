// Builds <home>/registry.json from the vault project notes (type: project, dashboard: true), then adds the
// entries of <home>/registry.extra.json. Existing ids and homes are never overwritten.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { ensureHome, resolveHome } from './lib/home.mjs';
import { readNote } from './lib/frontmatter.mjs';
import { norm, expandHome } from './lib/paths.mjs';

const asList = (v) => (Array.isArray(v) ? v : []);

export function buildRegistry({ vaultProjectsDir, registryFile, extraFile = null }) {
  const registry = existsSync(registryFile)
    ? JSON.parse(readFileSync(registryFile, 'utf8'))
    : { version: 1, projects: {} };
  const projects = registry.projects ?? (registry.projects = {});
  const homeOwner = new Map(Object.entries(projects).map(([id, e]) => [norm(e.home).toLowerCase(), id]));
  const added = [];
  const skipped = [];

  function add(id, entry) {
    if (projects[id]) { skipped.push(id); return; } // id already registered
    const owner = homeOwner.get(entry.home.toLowerCase());
    if (owner) { skipped.push(id); return; } // home already owned by another entry
    projects[id] = entry;
    homeOwner.set(entry.home.toLowerCase(), id);
    added.push(id);
  }

  for (const file of readdirSync(vaultProjectsDir).filter((f) => f.endsWith('.md')).sort()) {
    const note = join(vaultProjectsDir, file);
    const { data } = readNote(note);
    if (data.type !== 'project' || data.dashboard !== true || !data.path) continue;
    const id = file.replace(/[.]md$/, '');
    add(id, {
      name: data.name ?? id,
      family: data.group ?? 'Other',
      kind: 'project',
      home: norm(expandHome(String(data.path))),
      repos: asList(data.repos).map((r) => norm(expandHome(String(r)))),
      note: norm(note),
      uses: asList(data.uses),
      connects: asList(data.connects),
    });
  }

  if (extraFile && existsSync(extraFile)) {
    const extra = JSON.parse(readFileSync(extraFile, 'utf8'));
    for (const [id, e] of Object.entries(extra.projects ?? {})) {
      add(id, {
        name: e.name ?? id,
        family: e.family ?? 'Other',
        kind: e.kind ?? 'project',
        home: norm(expandHome(String(e.home))),
        uses: asList(e.uses),
        connects: asList(e.connects),
      });
    }
  }

  writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return { added, skipped };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const home = resolveHome();
  ensureHome(home);
  const config = loadConfig(home);
  const { added, skipped } = buildRegistry({
    vaultProjectsDir: config.vaultProjectsDir,
    registryFile: join(home, 'registry.json'),
    extraFile: join(home, 'registry.extra.json'),
  });
  console.log(`added ${added.length}: ${added.join(', ')}`);
  console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
}
