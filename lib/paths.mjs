// Path normalisation and shared name filters.
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { dirname, basename } from 'node:path';

const BACKSLASH = String.fromCharCode(92);

export function norm(p) {
  let s = String(p).replaceAll(BACKSLASH, '/');
  const unc = s.startsWith('//') && !s.startsWith('///');
  s = (unc ? '/' : '') + s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

// Canonical form for comparing paths: symlinks and Windows 8.3 short names resolved, the way git
// reports worktree paths (/var -> /private/var on macOS, RUNNER~1 -> runneradmin on Windows).
// A missing tail is resolved through its nearest existing ancestor below the filesystem root;
// with no such ancestor the path is only normalised. Use it for comparison keys, not for display.
export function canon(p) {
  let head = String(p);
  const tail = [];
  for (;;) {
    const up = dirname(head);
    if (up === head) return norm(p);
    try { return norm([realpathSync.native(head), ...tail].join('/')); } catch { /* missing: try the parent */ }
    tail.unshift(basename(head));
    head = up;
  }
}

// Expands a leading ~ ("~" or "~/x") to the home folder; other paths are returned unchanged.
export function expandHome(p, home = homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`;
  return p;
}

export function isUnder(child, root) {
  const c = norm(child).toLowerCase();
  const r = norm(root).toLowerCase();
  return c === r || c.startsWith(r + '/');
}

export const SECRET_NAME = /^(?!\.env\.(example|sample|template)$)(\.env(\..+)?|\.npmrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\..+)?|(client_secret|credentials|service-account).*\.json|.*\.bak([.-].*)?|.*\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk|asc|gpg|ovpn|sqlite|sqlite3|db|sqlite-wal|sqlite-shm)|auth\.json|auth-state\.json|.*tokens?\.json|\.git-credentials|\.netrc|_netrc|\.htpasswd|\.pypirc|.*firebase-admin.*\.json|.*service_account.*\.json|.*serviceaccount.*\.json)$/i;

// Any path segment (directory or file) containing these words is hidden and forbidden.
export const SECRET_SEGMENT = /secret|credential/i;
export const isSecretName = (name) => SECRET_NAME.test(name) || SECRET_SEGMENT.test(name);

export const DEP_DIRS = new Set([
  'node_modules', '.next', '.turbo', '.gradle', '.venv', 'venv', '__pycache__', 'build', 'dist',
  'Library', '.pnpm-store', '.uv-cache', '.pytest_cache', '.ruff_cache', 'graphify-out', '.tmp-media',
]);
