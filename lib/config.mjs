// Reads <home>/overmap.config.json. Every path field is expanded (~) and normalised.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, norm } from './paths.mjs';

const pathOrNull = (v) => (typeof v === 'string' && v !== '' ? norm(expandHome(v)) : null);

export function loadConfig(home) {
  const file = join(home, 'overmap.config.json');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof c.vaultProjectsDir !== 'string' || c.vaultProjectsDir.trim() === '') {
    throw new Error(`vaultProjectsDir must be set in ${file}`);
  }
  return {
    home,
    vaultProjectsDir: pathOrNull(c.vaultProjectsDir),
    mocFile: pathOrNull(c.mocFile),
    allowedLogin: typeof c.allowedLogin === 'string' ? c.allowedLogin : '', // '' = loopback only
    port: Number.isInteger(c.port) ? c.port : 3210,
    architectureFile: pathOrNull(c.architectureFile),
    memoryRoot: pathOrNull(c.memoryRoot),
    proxyHost: typeof c.proxyHost === 'string' && c.proxyHost !== '' ? c.proxyHost : null,
    projectsDir: pathOrNull(c.projectsDir),
    graphMaxBytes: Number.isInteger(c.graphMaxBytes) ? c.graphMaxBytes : 67108864,
    graphifyCommand: typeof c.graphifyCommand === 'string' && c.graphifyCommand ? c.graphifyCommand : 'graphify',
  };
}
