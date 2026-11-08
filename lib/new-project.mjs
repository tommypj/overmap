// New project: validation (no I/O beyond existence checks) and creation (skeleton, PROJECT.md, vault note, registry).
import * as realFs from 'node:fs';
import { slugify } from '../web/slug.js';
import { serializeFrontmatter } from './frontmatter.mjs';

export { slugify };

const FOLDERS = ['docs', 'assets', 'outputs', 'exports', 'ops', 'repos'];
const norm = (p) => String(p).replaceAll('\\', '/').replace(/\/+$/, '');

export const noteFileName = (name) => `${String(name).replace(/[\\/:*?"<>|]/g, '-').trim()}.md`;

const CTRL = /\p{Cc}/u;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
// Windows treats `nul.foo` like `nul`: test the part before the first dot
const isReserved = (s) => RESERVED.test(String(s).split('.')[0]);
const len = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.trim().length <= max;

export function validateNewProject(input, { registry, exists = realFs.existsSync, projectsDir, vaultDir }) {
  const i = input ?? {};
  const errors = {};
  const name = typeof i.name === 'string' ? i.name.trim() : '';
  const family = typeof i.family === 'string' ? i.family.trim() : '';
  const purpose = typeof i.purpose === 'string' ? i.purpose.trim() : '';
  for (const [k, v] of [['name', name], ['family', family], ['purpose', purpose]]) if (!errors[k] && CTRL.test(v)) errors[k] = 'no line breaks or control characters';
  if (errors.name) { /* control characters */ } else if (!len(name, 2, 60)) errors.name = 'name must be 2-60 characters';
  if (errors.family) { /* control characters */ } else if (!len(family, 1, 40) || !/^[\p{L}\p{N} _-]+$/u.test(family)) errors.family = 'family must be 1-40 letters, digits, spaces, _ or -';
  if (errors.purpose) { /* control characters */ } else if (!len(purpose, 1, 200)) errors.purpose = 'purpose must be 1-200 characters';
  const branchesOff = i.branchesOff === undefined || i.branchesOff === null || i.branchesOff === '' ? null : i.branchesOff;
  if (branchesOff !== null && !(typeof branchesOff === 'string' && registry.has(branchesOff))) errors.branchesOff = 'unknown project';
  const usesRaw = i.uses === undefined || i.uses === null ? [] : i.uses;
  const usesIn = Array.isArray(usesRaw) ? [...new Set(usesRaw)] : usesRaw;
  if (!Array.isArray(usesRaw) || usesRaw.length > 10) errors.uses = 'uses must be a list of at most 10 projects';
  else if (usesIn.some((u) => typeof u !== 'string' || !registry.has(u))) errors.uses = 'unknown project in uses';
  const slug = errors.name ? '' : slugify(name);
  if (!errors.name && !slug) errors.name = 'name needs letters or digits';
  const dir = norm(projectsDir);
  const home = slug ? `${dir}/${slug}` : '';
  const note = name && slug ? `${norm(vaultDir)}/${noteFileName(name)}` : '';
  if (slug && (isReserved(slug) || isReserved(noteFileName(name).slice(0, -3)))) errors.name = 'reserved name on Windows';
  else if (slug) {
    if (registry.has(slug) || [...registry.values()].some((e) => norm(e.home).toLowerCase() === home.toLowerCase())) errors.name = 'a project with this slug already exists';
    else if (exists(home)) errors.name = 'the project folder already exists';
    else if (exists(note)) errors.name = 'a vault note with this name already exists';
  }
  const ok = Object.keys(errors).length === 0;
  return { ok, errors, value: ok ? { slug, name, family, purpose, branchesOff, uses: usesIn, home, note } : null };
}

export function createProject(value, { now = Date.now, registryFile, fs = realFs } = {}) {
  const { slug, name, family, purpose, branchesOff, uses, home, note } = value;
  const created = [];
  const reg = JSON.parse(fs.readFileSync(registryFile, 'utf8')); // before any write: an unreadable registry leaves nothing behind
  try {
    fs.mkdirSync(home); created.push(home);
    for (const f of FOLDERS) { fs.mkdirSync(`${home}/${f}`); created.push(`${home}/${f}`); }
    const body = `# ${name}\n\n${purpose}\n\n## Blockers\n`;
    const day = new Date(now()).toISOString().slice(0, 10);
    fs.writeFileSync(`${home}/PROJECT.md`, serializeFrontmatter({ name, family, status: 'active', summary: purpose, uses, branchesOff: branchesOff ?? undefined, created: day }) + body);
    created.push(`${home}/PROJECT.md`);
    fs.writeFileSync(note, serializeFrontmatter({ type: 'project', status: 'active', path: home, name, group: family, summary: purpose, dashboard: true, tags: ['project'] }) + body);
    created.push(note);
    reg.projects[slug] = { name, family, kind: 'project', home, note, uses, protected: false, ...(branchesOff ? { branchesOff } : {}) };
    fs.writeFileSync(`${registryFile}.tmp`, JSON.stringify(reg, null, 2) + '\n');
    fs.renameSync(`${registryFile}.tmp`, registryFile);
    created.push(registryFile);
  } catch (err) {
    err.created = created;
    throw err;
  }
  return { id: slug, home, note };
}
