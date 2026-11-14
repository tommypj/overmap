// Builds <home>/registry.json from the vault project notes (type: project, dashboard: true), then adds the
// entries of <home>/registry.extra.json. A note owns name, family, home, repos, uses, connects and note: those
// are refreshed from the note on every run. Fields only the registry holds (kind, connectors, protected,
// worktreesManaged, oldPaths) are kept. Extra entries never overwrite an existing id or home.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { ensureHome, resolveHome } from './lib/home.mjs';
import { readNote } from './lib/frontmatter.mjs';
import { norm, expandHome } from './lib/paths.mjs';
import { CliError, runCli } from './lib/cli-error.mjs';

const asList = (v) => (Array.isArray(v) ? v : []);

const NOTE_FIELDS = ['name', 'family', 'home', 'repos', 'uses', 'connects', 'note'];

function readJson(file, next) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError(`${file} is not valid JSON. ${next}`);
  }
}

export function buildRegistry({ vaultProjectsDir, registryFile, extraFile = null, configFile = 'overmap.config.json', log = () => {} }) {
  if (!existsSync(vaultProjectsDir)) {
    throw new CliError(`vault folder not found: ${vaultProjectsDir}. Set vaultProjectsDir in ${configFile}, then run: node make-registry.mjs`);
  }
  const registry = existsSync(registryFile)
    ? readJson(registryFile, 'Fix it or delete it, then run: node make-registry.mjs')
    : { version: 1, projects: {} };
  const projects = registry.projects ?? (registry.projects = {});
  const homeOwner = new Map(Object.entries(projects).map(([id, e]) => [norm(e.home).toLowerCase(), id]));
  const added = [];
  const skipped = [];
  const refreshed = [];

  // A note-backed entry: take every note-owned field from the note, keep the rest.
  function refresh(id, entry) {
    const cur = projects[id];
    const key = entry.home.toLowerCase();
    const owner = homeOwner.get(key);
    if (owner && owner !== id) { skipped.push(id); return; } // the new home belongs to another entry
    homeOwner.delete(norm(cur.home).toLowerCase());
    homeOwner.set(key, id);
    for (const f of NOTE_FIELDS) cur[f] = entry[f];
    refreshed.push(id);
  }

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
    if (data.type !== 'project' || data.dashboard !== true) continue;
    if (!data.path) { log(`skipped ${file}: no path`); continue; }
    const id = file.replace(/[.]md$/, '');
    (projects[id]?.note ? refresh : add)(id, {
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
    const extra = readJson(extraFile, 'Fix it, then run: node make-registry.mjs');
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
  return { added, refreshed, skipped };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  runCli(() => {
    const home = resolveHome();
    ensureHome(home);
    const config = loadConfig(home);
    const { added, refreshed, skipped } = buildRegistry({
      vaultProjectsDir: config.vaultProjectsDir,
      registryFile: join(home, 'registry.json'),
      extraFile: join(home, 'registry.extra.json'),
      configFile: join(home, 'overmap.config.json'),
      log: (line) => console.log(line),
    });
    console.log(`added ${added.length}: ${added.join(', ')}`);
    console.log(`refreshed ${refreshed.length}: ${refreshed.join(', ')}`);
    console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
  });
}
