// Reads <home>/secrets.json. Values are released only when the file is protected:
// Windows: icacls shows no principal beyond the current user, SYSTEM and Administrators.
// Other platforms: no group or other permission bits set.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function allowedPrincipals(env) {
  const user = env.USERNAME ?? '';
  const domain = env.USERDOMAIN ?? '';
  return new Set(
    [domain && user ? `${domain}\\${user}` : '', user, 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators']
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
}

// Parses `icacls <path>` output: "<path> PRINCIPAL:(F)" then indented continuation lines.
export function checkAcl(path, env = process.env) {
  const native = resolve(path);
  let out;
  try {
    out = execFileSync('icacls', [native], { encoding: 'utf8', windowsHide: true });
  } catch {
    return { ok: false, extra: ['(ACL check failed)'] };
  }
  const prefix = native.toLowerCase();
  const allowed = allowedPrincipals(env);
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

// Protection check for a file that exists. Returns { ok, extra }.
function protection(file, { platform, env, statImpl }) {
  if (platform === 'win32') return checkAcl(file, env);
  const mode = statImpl(file).mode;
  if ((mode & 0o077) === 0) return { ok: true, extra: [] };
  return { ok: false, extra: [`mode 0${(mode & 0o777).toString(8)}`] };
}

function sig(path) {
  try { const st = statSync(path); return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`; } catch { return null; }
}

export function createSecrets(home, { platform = process.platform, env = process.env, statImpl = statSync } = {}) {
  const file = join(home, 'secrets.json');
  let cache = null; // { sig, file, ok, extra, values, cachedAt }

  // A changed mtime/size re-reads; a file that disappeared (stat fails) falls through to the 'missing' state.
  function load() {
    const now = sig(file);
    if (cache && now !== null && now === cache.sig) return cache;
    let state;
    if (!existsSync(file)) {
      state = { file: 'missing', ok: true, extra: [], values: Object.create(null) };
    } else {
      const p = protection(file, { platform, env, statImpl });
      if (!p.ok) {
        state = { file: 'unprotected', ok: false, extra: p.extra, values: Object.create(null) };
      } else {
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
          const values = Object.create(null); // null prototype: 'toString' etc. are not secrets
          for (const [k, v] of Object.entries(parsed)) {
            if (k !== '_meta' && typeof v === 'string') values[k] = v;
          }
          state = { file: 'ok', ok: true, extra: [], values };
        } catch {
          state = { file: 'unreadable', ok: true, extra: [], values: Object.create(null) };
        }
      }
    }
    cache = { ...state, sig: now, cachedAt: new Date().toISOString() };
    return cache;
  }

  return {
    getSecret(name) {
      const v = load().values[name];
      return v === '' ? undefined : v;
    },
    // file: 'missing' | 'ok' | 'unprotected' | 'unreadable' (the Settings page shows this); ok: no protection problem.
    health() {
      const { file: state, ok, extra, cachedAt } = load();
      return { file: state, ok, extra, cachedAt };
    },
  };
}
