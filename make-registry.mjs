// Builds registry.json from the vault project notes.
// Existing entries are never overwritten.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { readNote } from './lib/frontmatter.mjs';
import { norm } from './lib/paths.mjs';

const REGISTRY_FILE = fileURLToPath(new URL('./registry.json', import.meta.url));

const config = loadConfig();
const registry = existsSync(REGISTRY_FILE)
  ? JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  : { version: 1, projects: {} };
const projects = registry.projects;
const homeOwner = new Map(Object.entries(projects).map(([id, e]) => [norm(e.home).toLowerCase(), id]));
const added = [];

function add(id, entry) { // returns the owning id when skipped because of a shared home
  const home = norm(entry.home);
  if (projects[id]) { console.log(`skip ${id}: id already registered`); return; }
  const owner = homeOwner.get(home.toLowerCase());
  if (owner) { console.log(`skip ${id}: home already owned by ${owner} (${home})`); return owner; }
  projects[id] = { ...entry, home };
  homeOwner.set(home.toLowerCase(), id);
  added.push(id);
}

for (const file of readdirSync(config.vaultProjectsDir).filter((f) => f.endsWith('.md')).sort()) {
  const { data } = readNote(`${config.vaultProjectsDir}/${file}`);
  if (data.type !== 'project' || data.dashboard !== true || !data.path) continue;
  const id = file.replace(/[.]md$/, '');
  const home = norm(data.path);
  add(id, {
    name: data.name ?? id,
    family: data.group ?? 'Other',
    kind: 'project',
    home,
    note: `${config.vaultProjectsDir}/${file}`,
    uses: Array.isArray(data.uses) ? data.uses : [],
  });
}

writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');
console.log(`added ${added.length}: ${added.join(', ')}`);
console.log(`total ${Object.keys(projects).length}`);
