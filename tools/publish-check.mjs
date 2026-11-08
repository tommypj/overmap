// Privacy scanner for the public Overmap tree.
// Flags private shapes (drive paths, tailnet hosts, emails, secrets, user homes)
// and any term listed in a denylist file. Lines containing `privacy-ok` are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PATTERNS = [
  { name: 'drive-path', re: /\b[A-Za-z]:[\\/](?!$)/ },
  { name: 'tailnet-host', re: /\b[\w-]+\.tail[0-9a-f]+\.ts\.net\b/i },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: 'secret', re: /(?<![A-Za-z0-9])(pcp_[a-z]+_[A-Za-z0-9]{6,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)|"client_secret"\s*:\s*"[^"]{8,}"/ },
  { name: 'user-home', re: /[\\/](?:Users|users|home)[\\/](?!(?:someone|me|you|user)(?![A-Za-z]))[A-Za-z]+/ },
];

const EXEMPT_EMAIL_DOMAINS = new Set(['example.com', 'example.org']);
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

function lineFindings(line, denylist) {
  const out = [];
  for (const p of PATTERNS) {
    if (p.name === 'email') {
      const re = new RegExp(p.re.source, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const domain = m[0].split('@')[1].toLowerCase();
        if (!EXEMPT_EMAIL_DOMAINS.has(domain)) {
          out.push(p.name);
          break;
        }
      }
    } else if (p.re.test(line)) {
      out.push(p.name);
    }
  }
  for (const term of denylist) {
    if (new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, 'i').test(line)) out.push('denylist');
  }
  return out;
}

function walk(dir, ignore, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, ignore, acc);
    else if (ent.isFile() && !BINARY_EXT.has(path.extname(ent.name).toLowerCase())) acc.push(full);
  }
  return acc;
}

export function scanTree(root, { denylist = [], ignore = ['.git', 'node_modules', '.superpowers'] } = {}) {
  const findings = [];
  for (const full of walk(root, ignore, [])) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes(MARKER)) return;
      for (const name of lineFindings(line, denylist)) {
        findings.push({ file: rel, line: i + 1, name, excerpt: line.trim().slice(0, 120) });
      }
    });
  }
  return findings;
}

function main() {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const denylist = process.env.OVERMAP_DENYLIST ? readDenylist(process.env.OVERMAP_DENYLIST) : [];
  const findings = scanTree(root, { denylist });
  if (denylist.length) console.log(`denylist terms loaded: ${denylist.length}`);
  for (const f of findings) console.log(`${f.file}:${f.line} [${f.name}] ${f.excerpt}`);
  console.log(findings.length ? `publish-check: ${findings.length} finding(s)` : 'publish-check: clean');
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
