// Find an executable the way a shell would, without spawning anything: PATH lookup, with PATHEXT on Windows.
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// Returns the first existing absolute path for cmd, or null. On win32 each PATHEXT extension is tried before
// the bare name, so `graphify` finds `graphify.cmd` rather than an extensionless shell script.
export function which(cmd, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d && isAbsolute(d));
  const exts = platform === 'win32'
    ? [...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']
    : [''];
  const names = isAbsolute(cmd) ? [cmd] : dirs.map((d) => join(d, cmd));
  for (const base of names) {
    for (const ext of exts) {
      const candidate = base + ext;
      if (isAbsolute(candidate) && exists(candidate)) return candidate;
    }
  }
  return null;
}
