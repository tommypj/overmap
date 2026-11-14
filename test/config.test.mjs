import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { norm } from '../lib/paths.mjs';

function tmpHome(obj) {
  const home = mkdtempSync(join(tmpdir(), 'cfg-'));
  if (obj !== undefined) writeFileSync(join(home, 'overmap.config.json'), JSON.stringify(obj));
  return home;
}

test('loadConfig defaults and expansion', () => {
  const home = tmpHome({ vaultProjectsDir: '~/vault' });
  try {
    const c = loadConfig(home);
    assert.equal(c.home, home);
    assert.equal(c.vaultProjectsDir, norm(join(homedir(), 'vault')));
    assert.equal(c.port, 3210);
    assert.equal(c.allowedLogin, '');
    assert.equal(c.proxyHost, null);
    assert.equal(c.mocFile, null);
    assert.equal(c.architectureFile, null);
    assert.equal(c.memoryRoot, null);
    assert.equal(c.projectsDir, null);
    assert.equal(c.graphMaxBytes, 67108864);
    assert.equal(c.graphifyCommand, 'graphify');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('loadConfig without vaultProjectsDir throws', () => {
  const home = tmpHome({ port: 1 });
  try {
    assert.throws(() => loadConfig(home), /vaultProjectsDir must be set/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
