// Reads <home>/overmap.config.json. Every path field is expanded (~) and normalised.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, norm } from './paths.mjs';
import { CliError } from './cli-error.mjs';

const pathOrNull = (v) => (typeof v === 'string' && v !== '' ? norm(expandHome(v)) : null);

export function loadConfig(home) {
  const file = join(home, 'overmap.config.json');
  let c;
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError(`${file} not found. Copy overmap.config.example.json there and set vaultProjectsDir`);
    throw new CliError(`${file} is not valid JSON. Fix it, then run the command again`);
  }
  if (typeof c?.vaultProjectsDir !== 'string' || c.vaultProjectsDir.trim() === '') {
    throw new CliError(`vaultProjectsDir must be set in ${file}. Set it to your notes folder, then run: node make-registry.mjs`);
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
