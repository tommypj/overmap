import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_FILE = fileURLToPath(new URL('../cockpit.config.json', import.meta.url));
const DEFAULT_MEMORY_ROOT = join(process.env.OVERMAP_HOME || homedir(), '.claude', 'projects');

export function loadConfig(file = DEFAULT_FILE) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof c.allowedLogin !== 'string' || c.allowedLogin.trim() === '') {
    throw new Error(`allowedLogin must be set in ${file}`);
  }
  const { vaultProjectsDir, mocFile, allowedLogin, port, architectureFile } = c;
  return { vaultProjectsDir, mocFile, allowedLogin, port, architectureFile, memoryRoot: c.memoryRoot ?? DEFAULT_MEMORY_ROOT };
}
