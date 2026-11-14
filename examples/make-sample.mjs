// Builds the invented "Larkspur Bikes" sample workspace (examples/sample/) into a folder:
//   <dir>/vault/Projects/*.md   six project notes (path placeholders filled in)
//   <dir>/projects/<id>/        plans, test results, graphs; each project is a committed git repo with a
//                               fake origin (no network is ever used); api-worker is a worktree of shop-api
//   <dir>/home/                 instance folder: overmap.config.json and registry.json
// Used by serve.mjs --sample and test/sample.test.mjs. Git identity is passed per command; global config is untouched.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '../make-registry.mjs';
import { norm } from '../lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, 'sample');
const PLACEHOLDER = '@PROJECTS@';
export const PROJECTS = ['storefront', 'shop-api', 'api-worker', 'mobile-app', 'docs-site', 'ops-tool'];
const WORKTREE_OF = 'shop-api';
const WORKTREE = 'api-worker';

// runSync defaults to execFileSync: synchronous, no shell. Each call gets windowsHide and piped stdio.
// It is injectable so a caller can record or replace the git commands.
export async function makeSample(dir, { git = true, runSync = execFileSync } = {}) {
  const vault = join(dir, 'vault');
  const vaultProjectsDir = join(vault, 'Projects');
  const projectsDir = join(dir, 'projects');
  const home = join(dir, 'home');
  for (const d of [vaultProjectsDir, projectsDir, home]) mkdirSync(d, { recursive: true });

  const copyProject = (id) => cpSync(join(SAMPLE, id), join(projectsDir, id), { recursive: true });
  const git_ = (cwd, args) => runSync('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const IDENTITY = ['-c', 'user.name=sample', '-c', 'user.email=sample@example.com'];
  const commitAll = (cwd) => {
    git_(cwd, ['add', '-A']);
    git_(cwd, [...IDENTITY, 'commit', '-q', '-m', 'init']);
  };

  // Static files first. With git, api-worker is left out: `git worktree add` must create its folder.
  for (const id of PROJECTS) if (!(git && id === WORKTREE)) copyProject(id);

  if (git) {
    for (const id of PROJECTS) {
      if (id === WORKTREE) continue;
      const cwd = join(projectsDir, id);
      git_(cwd, ['init', '-q']);
      commitAll(cwd);
      git_(cwd, ['remote', 'add', 'origin', `https://example.com/sample/${id}.git`]);
    }
    const main = join(projectsDir, WORKTREE_OF);
    git_(main, ['worktree', 'add', '-q', join(projectsDir, WORKTREE), '-b', 'worker']);
    // The worktree shares shop-api's repository config, so its origin is inherited (one remote).
    copyProject(WORKTREE);
    commitAll(join(projectsDir, WORKTREE));
  }

  for (const id of PROJECTS) {
    const text = readFileSync(join(SAMPLE, 'notes', `${id}.md`), 'utf8').split(PLACEHOLDER).join(norm(projectsDir));
    writeFileSync(join(vaultProjectsDir, `${id}.md`), text, 'utf8');
  }

  writeFileSync(join(home, 'overmap.config.json'), JSON.stringify({
    vaultProjectsDir: norm(vaultProjectsDir),
    projectsDir: norm(projectsDir),
    allowedLogin: '',
    port: 3210,
    proxyHost: null,
    architectureFile: null,
    mocFile: null,
    memoryRoot: null,
  }, null, 2) + '\n', 'utf8');
  buildRegistry({ vaultProjectsDir, registryFile: join(home, 'registry.json') });

  return { home, vault, projectsDir };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node examples/make-sample.mjs <empty-folder>');
    process.exit(2);
  }
  const { home } = await makeSample(resolve(dir));
  console.log(`sample instance: ${home}`);
}
