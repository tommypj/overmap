import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const secretsPath = join(process.env.OVERMAP_HOME || homedir(), '.config', 'cockpit', 'secrets.json');

function allowedPrincipals() {
  const user = process.env.USERNAME ?? '';
  const domain = process.env.USERDOMAIN ?? '';
  return new Set(
    [domain && user ? `${domain}\\${user}` : '', user, 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
}

// Parses `icacls <path>` output: "<path> PRINCIPAL:(F)" then indented continuation lines.
export function checkAcl(path) {
  const native = resolve(path);
  let out;
  try {
    out = execFileSync('icacls', [native], { encoding: 'utf8', windowsHide: true });
  } catch {
    return { ok: false, extra: ['(ACL check failed)'] };
  }
  const prefix = native.toLowerCase();
  const allowed = allowedPrincipals();
  const principals = [];
  for (const raw of out.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith(prefix)) line = line.slice(prefix.length).trim();
    const m = /^(.+?):\(/.exec(line);
    if (m) principals.push(m[1].trim());
  }
  const extra = [...new Set(principals.filter((p) => !allowed.has(p.toLowerCase())))];
  if (principals.length === 0) return { ok: false, extra: ['(ACL unparsed)'] };
  return { ok: extra.length === 0, extra };
}

const cache = new Map();

export function _resetSecretsCache() {
  cache.clear();
}

// State for one file: { file: 'missing'|'unprotected'|'unreadable'|'ok', extra, values }.
function sig(path) {
  try { const st = statSync(path); return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`; } catch { return null; }
}

function load(path) {
  if (cache.has(path)) {
    const hit = cache.get(path);
    const now = sig(path);
    // A changed mtime/size re-reads; a file that disappeared (stat fails) falls through to the 'missing' state.
    if (now !== null && now === hit.sig) return hit;
    cache.delete(path);
  }
  let state;
  if (!existsSync(path)) {
    state = { file: 'missing', extra: [], values: {} };
  } else {
    const acl = checkAcl(path);
    if (!acl.ok) {
      state = { file: 'unprotected', extra: acl.extra, values: {} };
    } else {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
        const values = Object.create(null);
        for (const [k, v] of Object.entries(parsed)) {
          if (k !== '_meta' && typeof v === 'string') values[k] = v;
        }
        state = { file: 'ok', extra: [], values };
      } catch {
        state = { file: 'unreadable', extra: [], values: {} };
      }
    }
  }
  state.sig = sig(path);
  state.cachedAt = new Date().toISOString();
  cache.set(path, state);
  return state;
}

export function getSecret(name, path = secretsPath) {
  const v = load(path).values[name]; // values has a null prototype
  return v === '' ? undefined : v;
}

export function secretStatus(names, path = secretsPath) {
  return Object.fromEntries(names.map((n) => [n, getSecret(n, path) === undefined ? 'missing' : 'set']));
}

export function secretsHealth(path = secretsPath) {
  const { file, extra, cachedAt } = load(path);
  return { file, extra, cachedAt };
}
