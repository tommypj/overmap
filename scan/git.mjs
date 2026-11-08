// Worktree-aware git facts. A failing git call is data, not an exception,
// and an unreadable value is null, never a fabricated 0 / [] / false.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { norm } from '../lib/paths.mjs';

const run = promisify(execFile);

async function git(repo, args) {
  const { stdout } = await run('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

// Only for reads where failure is a normal state (unborn branch, no origin/HEAD, ...)
// or where the caller maps null to "unknown".
const tryGit = (repo, args) => git(repo, args).catch(() => null);

const firstLine = (e) => String(e.stderr || e.message || e).trim().split('\n')[0];

export function stripCredentials(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

async function statusCounts(path) {
  const out = await git(path, ['status', '--porcelain=v1']);
  let modified = 0;
  let untracked = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('??')) untracked++;
    else modified++;
  }
  return { modified, untracked };
}

function parseWorktrees(porcelain) {
  const entries = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: norm(line.slice(9)), branch: null, prunable: false };
      entries.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  return entries;
}

function parseRemotes(remoteV) {
  return [...new Set(
    remoteV
      .split('\n')
      .filter((l) => l.endsWith('(fetch)'))
      .map((l) => stripCredentials(l.split('\t').slice(1).join('\t').replace(/\s\(fetch\)$/, ''))),
  )];
}

async function collect(repo) {
  const top = norm(await git(repo, ['rev-parse', '--show-toplevel']));
  const [gitDir, commonDir] = (
    await git(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  ).split('\n').map(norm);
  const isWorktree = gitDir.toLowerCase() !== commonDir.toLowerCase();
  const entries = parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']));
  const mainRepo = entries.length ? entries[0].path : top;

  const rawBranch = await tryGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null; // 'HEAD' = detached
  const [head, lastDate, lastSubject] = (
    (await tryGit(repo, ['log', '-1', '--format=%H%n%cI%n%s'])) ?? ''
  ).split('\n');

  const remoteOut = await tryGit(repo, ['remote', '-v']);
  const remotes = remoteOut === null ? null : parseRemotes(remoteOut);
  const hasRemotes = remotes === null ? null : remotes.length > 0;

  const { modified, untracked } = await statusCounts(repo);
  const stashOut = await tryGit(repo, ['stash', 'list']);
  const stashes = stashOut === null ? null : stashOut ? stashOut.split('\n').length : 0;

  const notRemotes = hasRemotes ? ['--not', '--remotes'] : [];
  let localOnlyCommits = null;
  if (hasRemotes !== null) {
    localOnlyCommits = Number(await git(repo, ['rev-list', '--count', '--branches', ...notRemotes]));
  }

  const branchNames = (await git(repo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']))
    .split('\n').filter(Boolean);
  const localOnlyBranches = [];
  for (const name of branchNames) {
    const out = hasRemotes === null
      ? null
      : await tryGit(repo, ['rev-list', '--count', `refs/heads/${name}`, ...notRemotes]);
    const n = out === null ? null : Number(out);
    if (n === null || n > 0) localOnlyBranches.push({ name, commits: n });
  }

  const worktrees = [];
  for (const e of entries.filter((x) => x.path.toLowerCase() !== top.toLowerCase())) {
    const entry = { path: e.path, branch: e.branch };
    if (e.prunable) entry.prunable = true;
    try {
      Object.assign(entry, await statusCounts(e.path));
    } catch (err) {
      Object.assign(entry, { modified: null, untracked: null, error: firstLine(err) });
    }
    worktrees.push(entry);
  }

  let defaultBranch = null;
  const originHead = await tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) defaultBranch = originHead.replace(/^origin\//, '');
  else if (branchNames.includes('main')) defaultBranch = 'main';
  else if (branchNames.includes('master')) defaultBranch = 'master';
  let defaultBehind = null;
  if (defaultBranch && hasRemotes) {
    const n = await tryGit(repo, ['rev-list', '--count', `refs/heads/${defaultBranch}..refs/remotes/origin/${defaultBranch}`]);
    if (n !== null) defaultBehind = Number(n);
  }

  return {
    branch, head: head || null, lastDate: lastDate || null, lastSubject: lastSubject ?? null,
    remotes, isWorktree, mainRepo, worktrees, modified, untracked, stashes,
    localOnlyCommits, localOnlyBranches, defaultBranch, defaultBehind,
  };
}

export async function gitFacts(repo) {
  const at = new Date().toISOString();
  try {
    return { at, value: await collect(repo) };
  } catch (e) {
    return { at, error: firstLine(e) };
  }
}
