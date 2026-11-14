import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHome, ensureHome } from '../lib/home.mjs';
import { expandHome } from '../lib/paths.mjs';

const EXAMPLE = join(import.meta.dirname, '..', 'overmap.config.example.json');

test('resolveHome precedence: --home, then OVERMAP_HOME, then ~/.overmap', () => {
  assert.equal(resolveHome({ env: { OVERMAP_HOME: '/e' }, argv: ['node', 's', '--home', '/a'], homedir: () => '/h' }), '/a');
  assert.equal(resolveHome({ env: { OVERMAP_HOME: '/e' }, argv: ['node', 's'], homedir: () => '/h' }), '/e');
  assert.equal(resolveHome({ env: {}, argv: ['node', 's'], homedir: () => '/h' }), '/h/.overmap');
});

test('ensureHome creates the folder, data/ and a config from the example once', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'home-')), 'instance');
  try {
    const first = ensureHome(dir, { exampleConfig: EXAMPLE });
    assert.equal(first.created, true);
    assert.ok(existsSync(join(dir, 'data')));
    assert.equal(first.configFile, join(dir, 'overmap.config.json'));
    assert.equal(readFileSync(first.configFile, 'utf8'), readFileSync(EXAMPLE, 'utf8'));
    writeFileSync(first.configFile, '{"vaultProjectsDir":"x"}');
    const second = ensureHome(dir, { exampleConfig: EXAMPLE });
    assert.equal(second.created, false);
    assert.equal(readFileSync(first.configFile, 'utf8'), '{"vaultProjectsDir":"x"}');
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});

test('expandHome', () => {
  assert.equal(expandHome('~/code/x', '/h'), '/h/code/x');
  assert.equal(expandHome('/abs', '/h'), '/abs');
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('a~b', '/h'), 'a~b');
});
