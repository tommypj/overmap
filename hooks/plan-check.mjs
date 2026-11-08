// Claude Code Stop hook: blocks a stop once when the session changed a registered project but its plan was not updated.
// Never blocks by mistake: any error, unknown cwd, no git, git timeout, out of time or stop_hook_active -> {} (exit 0). Read-only toward projects.
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, rootsOf } from '../registry.mjs';
import { isUnder, norm } from '../lib/paths.mjs';
import { planFileMtime, planFilePath } from '../plan/reader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORK_WINDOW_MS = 4 * 3600000;
export const DEADLINE_MS = 6000;
const GIT_TIMEOUT_MS = 2000;
export const GRACE_MS = 30 * 60_000;
const NO_LOCKS = '--no-optional-locks';
const OUT_OF_TIME = Symbol('out-of-time');
const MAX_STAT = 50;
const FORMAT_REF = 'docs/hook.md in Overmap, section "PLAN.md"';
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);
const QT = String.fromCharCode(34);

function match(cwd, registry) {
  let best = null;
  for (const e of registry.values()) {
    for (const root of rootsOf(e)) {
      if (isUnder(cwd, root) && (!best || root.length > best.root.length)) best = { e, root };
    }
  }
  return best;
}

// Paths from `git status --porcelain` (v1): "XY path", rename "R  old -> new" (new wins), quoted paths.
export function parsePorcelain(text) {
  const out = [];
  for (const raw of String(text).split(NL)) {
    const line = raw.split(CR).join('');
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.lastIndexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.length >= 2 && p.startsWith(QT) && p.endsWith(QT)) p = p.slice(1, -1).split(BS + QT).join(QT).split(BS + BS).join(BS);
    out.push(p);
  }
  return out;
}

const realMtime = (p) => {
  try { return statSync(p).mtimeMs; } catch { return null; }
};

// cwd outside every registered root: ask git whether it is a worktree of a registered repo.
function discover(cwd, registry, g) {
  const common = g(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (typeof common !== 'string' || !common.trim()) return null;
  const main = norm(dirname(norm(common.trim())));
  const top = g(['rev-parse', '--show-toplevel'], cwd);
  if (typeof top !== 'string' || !top.trim()) return null;
  const m = match(main, registry);
  if (!m) return null;
  return { e: m.e, root: norm(top.trim()), discovered: true };
}

export function decide(input, deps) {
  try {
    if (!input || input.stop_hook_active === true || !input.cwd) return {};
    const { registry, now, planMtime, git } = deps;
    const planFile = deps.planFile ?? planFilePath;
    const clock = deps.clock ?? Date.now;
    const mtime = deps.mtime ?? realMtime;
    const started = clock();
    const outOfTime = () => DEADLINE_MS - (clock() - started) < GIT_TIMEOUT_MS;
    // every git call is deadline-aware and read-only (no optional locks, so .git/index is never rewritten)
    const g = (args, cwd) => {
      if (outOfTime()) throw OUT_OF_TIME;
      return git([NO_LOCKS, ...args], cwd);
    };
    const cwd = norm(input.cwd);
    const m = match(cwd, registry) ?? discover(cwd, registry, g);
    if (!m) return {};
    const { e, root } = m;
    const repos = m.discovered || existsSync(`${root}/.git`) ? [root] : e.repos;
    if (!repos.length) return {};
    const t = now();
    let evidence = null; // newest time (ms) of work done in the last 4 h
    const note = (ms) => {
      if (Number.isFinite(ms) && t - ms <= WORK_WINDOW_MS && (evidence === null || ms > evidence)) evidence = ms;
    };
    let statted = 0;
    for (const repo of repos) {
      const st = g(['status', '--porcelain', '--untracked-files=no'], repo);
      if (typeof st === 'string') {
        for (const rel of parsePorcelain(st)) {
          if (statted >= MAX_STAT) break;
          statted++;
          note(mtime(join(repo, rel)));
        }
      }
      const lg = g(['log', '-1', '--format=%ct'], repo);
      note(typeof lg === 'string' ? parseInt(lg.trim(), 10) * 1000 : NaN);
    }
    if (evidence === null) return {};
    // plan time: newest of the plan file(s) on disk and the newest commit touching the plan
    let plan = null;
    const bump = (ms) => { if (Number.isFinite(ms) && (plan === null || ms > plan)) plan = ms; };
    bump(planMtime(e.home));
    if (norm(root) !== norm(e.home)) bump(planMtime(root));
    for (const repo of repos) {
      const pc = g(['log', '-1', '--format=%ct', '--', 'PLAN.md', 'docs/superpowers/plans'], repo);
      if (typeof pc === 'string' && pc.trim()) bump(parseInt(pc.trim(), 10) * 1000);
    }
    if (plan === null) {
      return { decision: 'block', reason: `${e.name} has no plan file. Create PLAN.md in ${e.home} (format: ${FORMAT_REF}) or a checkbox plan under docs/superpowers/plans/, then stop again.` };
    }
    if (plan >= evidence - GRACE_MS) return {};
    const hours = Math.floor((t - plan) / 3600000);
    const ago = hours < 1 ? 'under 1 h ago' : `${hours} h ago`;
    let file = 'PLAN.md';
    try {
      const f = planFile(e.home);
      if (typeof f === 'string' && f) {
        const nf = norm(f), nh = norm(e.home);
        file = nf.toLowerCase().startsWith(`${nh.toLowerCase()}/`) ? nf.slice(nh.length + 1) : nf;
      }
    } catch { /* keep the default label */ }
    return { decision: 'block', reason: `This session changed ${e.name} but its plan was not updated (${file}, last changed ${ago}). Tick what you finished or add the next step, then stop again. Format: ${FORMAT_REF}.` };
  } catch {
    return {};
  }
}

const realGit = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch {
    return null;
  }
};

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

export async function main({ stdin = process.stdin, stdout = process.stdout, registryFile = resolve(HERE, '..', 'registry.json'), git = realGit, now = Date.now, planMtime = planFileMtime, planFile = planFilePath } = {}) {
  let result = {};
  try {
    const text = await readAll(stdin);
    const input = text.trim() ? JSON.parse(text) : {};
    result = decide(input, { registry: loadRegistry(registryFile), now, planMtime, planFile, git });
  } catch {
    result = {};
  }
  stdout.write(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().then(() => process.exit(0), () => { process.stdout.write('{}'); process.exit(0); });
}
