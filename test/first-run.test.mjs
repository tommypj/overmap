import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { CliError } from '../lib/cli-error.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (script, home) => spawnSync(process.execPath, [script, '--home', home], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OVERMAP_HOME: '' } });
const fwd = (p) => p.replaceAll(String.fromCharCode(92), '/');

function instance(config) {
  const home = mkdtempSync(join(tmpdir(), 'overmap-first-'));
  mkdirSync(join(home, 'data'));
  if (config !== undefined) writeFileSync(join(home, 'overmap.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return home;
}
// One line on stderr, exit 1, no stack trace.
function oneLine(r) {
  assert.equal(r.status, 1, r.stderr);
  const lines = r.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(!/\bat .+:\d+:\d+/.test(r.stderr), r.stderr);
  return lines[0];
}

test('make-registry: a missing vault folder is one line naming the folder and the next command', () => {
  const home = instance({ vaultProjectsDir: join(tmpdir(), 'overmap-no-such-vault-xyz') });
  try {
    const line = oneLine(run('make-registry.mjs', home));
    assert.match(line, /vault folder not found: .*overmap-no-such-vault-xyz/);
    assert.match(line, /node make-registry\.mjs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('make-registry: malformed overmap.config.json names the file', () => {
  const home = instance('{ "vaultProjectsDir": ');
  try {
    const line = oneLine(run('make-registry.mjs', home));
    assert.match(line, /overmap\.config\.json is not valid JSON/);
    assert.ok(line.includes(fwd(home)) || line.includes(home), line);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('make-registry: a note without path prints "skipped <note>: no path" and the rest still builds', () => {
  const home = instance();
  const vault = join(home, 'vault');
  mkdirSync(vault);
  writeFileSync(join(home, 'overmap.config.json'), JSON.stringify({ vaultProjectsDir: fwd(vault) }));
  writeFileSync(join(vault, 'NoPath.md'), ['---', 'type: project', 'dashboard: true', '---', ''].join('\n'));
  writeFileSync(join(vault, 'Good.md'), ['---', 'type: project', 'dashboard: true', `path: ${fwd(join(home, 'good'))}`, '---', ''].join('\n'));
  try {
    const r = run('make-registry.mjs', home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^skipped NoPath\.md: no path$/m);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'registry.json'), 'utf8')).projects), ['Good']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('scan: no registry.json is one line naming the file and make-registry', () => {
  const home = instance({ vaultProjectsDir: fwd(tmpdir()) });
  try {
    const line = oneLine(run('scan.mjs', home));
    assert.match(line, /no registry at .*registry\.json/);
    assert.match(line, /node make-registry\.mjs/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('scan: malformed overmap.config.json names the file', () => {
  const home = instance('not json');
  try {
    assert.match(oneLine(run('scan.mjs', home)), /overmap\.config\.json is not valid JSON/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('loadConfig: malformed JSON is a CliError naming the file, without the parser text', () => {
  const home = instance('{"a": }');
  try {
    assert.throws(() => loadConfig(home), (e) => e instanceof CliError && /overmap\.config\.json is not valid JSON/.test(e.message) && !/Unexpected|position/.test(e.message));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('serve: a malformed config is one line naming the file, not a stack trace', () => {
  const home = instance('{ not json');
  try {
    const line = oneLine(run('serve.mjs', home));
    assert.ok(fwd(line).includes(`${fwd(join(home, 'overmap.config.json'))} is not valid JSON`), line);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); }
});
