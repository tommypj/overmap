// Find an executable the way a shell would, without spawning anything: PATH lookup, with PATHEXT on Windows.
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const SHIM = /\.(cmd|bat)$/i;

// Returns the first existing absolute path for cmd, or null. On win32 only .EXE and .COM are resolved, plus the bare
// name when it is not a .cmd/.bat shim: shims are run through cmd.exe, which parses metacharacters in arguments.
// allowShims: true also resolves .CMD/.BAT (used only to report that a shim exists).
export function which(cmd, { env = process.env, platform = process.platform, exists = existsSync, allowShims = false } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d && isAbsolute(d));
  const win = platform === 'win32';
  const exts = win
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).filter((e) => allowShims || /^\.(com|exe)$/i.test(e))
    : [''];
  if (win && (allowShims || !SHIM.test(cmd))) exts.push('');
  const names = isAbsolute(cmd) ? [cmd] : dirs.map((d) => join(d, cmd));
  for (const base of names) {
    for (const ext of exts) {
      const candidate = base + ext;
      if (isAbsolute(candidate) && exists(candidate)) return candidate;
    }
  }
  return null;
}
