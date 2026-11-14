// Privacy scanner for the public Overmap tree.
// Flags private shapes (drive paths, private repo folders, tailnet hosts and addresses, emails,
// secrets, user homes) and any term listed in a denylist file. A line containing `privacy-ok`
// is exempt from the generic patterns only: denylist terms are reported on every line.
//
//   node tools/publish-check.mjs [root]             scan the working tree
//   node tools/publish-check.mjs --history [root]   scan every blob reachable in the git history
//
// Set OVERMAP_DENYLIST to a file of private terms (one per line, # comments).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SECRETS = [
  'pcp_[a-z]+_[A-Za-z0-9]{6,}',
  'sk-[A-Za-z0-9_-]{12,}',
  'sk_live_[A-Za-z0-9]{8,}',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'xox[bp]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'AIza[0-9A-Za-z_-]{20,}',
  'GOCSPX-[A-Za-z0-9_-]{20,}',
  'eyJ[A-Za-z0-9_-]{4,}\\.eyJ[A-Za-z0-9_-]{4,}\\.',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----',
];

export const PATTERNS = [
  { name: 'drive-path', re: /\b[A-Za-z]:[\\/](?!$)/ },
  // A root-anchored POSIX path into a private (underscore-prefixed) repo folder.
  { name: 'private-path', re: /(?<![\w.~-])\/projects\/_[\w.-]/i },
  // Any tailnet host; the documented placeholder `<machine>.your-tailnet.ts.net` is exempt.
  { name: 'tailnet-host', re: /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/i, ok: /(?:^|\.)your-tailnet\.ts\.net$/i },
  // The carrier-grade NAT range 100.64.0.0/10, which tailnets hand out. privacy-ok
  { name: 'tailnet-ip', re: /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])/ },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/, ok: /@example\.(?:com|org)$/i },
  { name: 'secret', re: new RegExp(`(?<![A-Za-z0-9])(?:${SECRETS.join('|')})|"client_secret"\\s*:\\s*"[^"]{8,}"`) },
  { name: 'user-home', re: /[\\/](?:Users|users|home)[\\/](?!(?:someone|me|you|user)(?![A-Za-z]))[A-Za-z]+/ },
];

// Files the scanner never reads: LICENSE carries the copyright holder's legal name by design.
const SKIP_FILES = new Set(['LICENSE']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.db', '.sqlite']);
const MARKER = 'privacy-ok';

export function readDenylist(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#'));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A pattern with an `ok` regex reports a line only when some match is not an exempt placeholder.
export function patternFindings(line) {
  const out = [];
  for (const p of PATTERNS) {
    if (!p.ok) {
      if (p.re.test(line)) out.push(p.name);
      continue;
    }
    for (const m of line.matchAll(new RegExp(p.re.source, `g${p.re.flags}`))) {
      if (!p.ok.test(m[0])) {
        out.push(p.name);
        break;
      }
    }
  }
  return out;
}

function denylistFindings(line, denylist) {
  const out = [];
  for (const term of denylist) {
    if (new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, 'i').test(line)) out.push('denylist');
  }
  return out;
}

// Findings for one file's text. `privacy-ok` silences the generic patterns, never the denylist.
export function textFindings(text, denylist = []) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const names = [...(line.includes(MARKER) ? [] : patternFindings(line)), ...denylistFindings(line, denylist)];
    for (const name of names) out.push({ line: i + 1, name, excerpt: line.trim().slice(0, 120) });
  });
  return out;
}

function walk(dir, ignore, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.includes(ent.name) || (ent.isFile() && SKIP_FILES.has(ent.name))) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, ignore, acc);
    else if (ent.isFile() && !BINARY_EXT.has(path.extname(ent.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

export function scanTree(root, { denylist = [], ignore = ['.git', 'node_modules', '.superpowers', '.base', '.base-ast', '.base-ast-cache'] } = {}) {
  const findings = [];
  for (const full of walk(root, ignore, [])) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    for (const f of textFindings(fs.readFileSync(full, 'utf8'), denylist)) findings.push({ file: rel, ...f });
  }
  return findings;
}

const git = (root, args, input) =>
  execFileSync('git', args, { cwd: root, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });

// Read many blobs in one `git cat-file --batch` call: sha -> Buffer.
function readBlobs(root, shas) {
  const out = new Map();
  if (!shas.length) return out;
  const buf = git(root, ['cat-file', '--batch'], shas.join('\n') + '\n');
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const [sha, type, size] = buf.subarray(pos, nl).toString('utf8').split(' ');
    const n = Number(size);
    if (type === 'blob') out.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    pos = type === 'missing' ? nl + 1 : nl + 1 + n + 1;
  }
  return out;
}

// Scan every blob reachable from `git rev-list --objects --all`. Each finding names the blob's
// path and a commit (the newest one) whose tree holds it: `file` is `<path>@<short commit>`.
export function scanHistory(root, { denylist = [] } = {}) {
  const objects = git(root, ['rev-list', '--objects', '--all']).toString('utf8').split('\n').filter(Boolean);
  const types = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], objects.map((l) => l.slice(0, l.indexOf(' ') < 0 ? l.length : l.indexOf(' '))).join('\n') + '\n')
    .toString('utf8').split('\n').filter(Boolean);
  const blobPath = new Map();
  objects.forEach((l, i) => {
    const sp = l.indexOf(' ');
    if (sp > 0 && types[i]?.endsWith(' blob')) blobPath.set(l.slice(0, sp), l.slice(sp + 1));
  });
  // Blob -> newest commit holding it (rev-list lists newest first).
  const commitOf = new Map();
  for (const c of git(root, ['rev-list', '--all']).toString('utf8').split('\n').filter(Boolean)) {
    const tree = git(root, ['ls-tree', '-r', '-z', c]).toString('utf8').split('\0').filter(Boolean);
    for (const entry of tree) {
      const sha = entry.split('\t')[0].split(' ')[2];
      if (!commitOf.has(sha)) commitOf.set(sha, c.slice(0, 7));
    }
  }
  const scannable = [...blobPath].filter(([, p]) => !SKIP_FILES.has(path.posix.basename(p)) && !BINARY_EXT.has(path.posix.extname(p).toLowerCase()));
  const blobs = readBlobs(root, scannable.map(([sha]) => sha));
  const findings = [];
  for (const [sha, p] of scannable) {
    const buf = blobs.get(sha);
    if (!buf || buf.includes(0)) continue;
    const file = `${p}@${commitOf.get(sha) || sha.slice(0, 7)}`;
    for (const f of textFindings(buf.toString('utf8'), denylist)) findings.push({ file, ...f });
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const history = args.includes('--history');
  const rootArg = args.find((a) => a !== '--history');
  const root = path.resolve(rootArg || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const denylist = process.env.OVERMAP_DENYLIST ? readDenylist(process.env.OVERMAP_DENYLIST) : [];
  const findings = history ? scanHistory(root, { denylist }) : scanTree(root, { denylist });
  if (denylist.length) console.log(`denylist terms loaded: ${denylist.length}`);
  for (const f of findings) console.log(`${f.file}:${f.line} [${f.name}] ${f.excerpt}`);
  const what = history ? 'publish-check --history' : 'publish-check';
  console.log(findings.length ? `${what}: ${findings.length} finding(s)` : `${what}: clean`);
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
