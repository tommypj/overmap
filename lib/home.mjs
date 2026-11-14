// The instance folder: where the user's config, data, registry and secrets live, outside this code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from './paths.mjs';

const DEFAULT_EXAMPLE = fileURLToPath(new URL('../overmap.config.example.json', import.meta.url));

// Precedence: --home <dir> in argv, then OVERMAP_HOME, then ~/.overmap.
export function resolveHome({ env = process.env, argv = process.argv, homedir = osHomedir } = {}) {
  const i = argv.indexOf('--home');
  if (i >= 0 && argv[i + 1]) return norm(argv[i + 1]);
  if (env.OVERMAP_HOME) return norm(env.OVERMAP_HOME);
  return norm(`${homedir()}/.overmap`);
}

// Creates the instance folder, data/ and (once) overmap.config.json copied from the example.
export function ensureHome(dir, { exampleConfig = DEFAULT_EXAMPLE } = {}) {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const configFile = join(dir, 'overmap.config.json');
  if (existsSync(configFile)) return { created: false, configFile };
  writeFileSync(configFile, readFileSync(exampleConfig, 'utf8'));
  return { created: true, configFile };
}
