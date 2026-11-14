import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSample } from '../examples/make-sample.mjs';
import { startServer } from '../serve.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile);
const scan = (home) => execFileP(process.execPath, ['scan.mjs', '--home', home, '--no-size', '--quiet'], { cwd: ROOT, windowsHide: true });
const readData = (home) => JSON.parse(readFileSync(join(home, 'data', 'projects.json'), 'utf8'));

const PLAN_PERCENT = { storefront: 15, 'shop-api': 40, 'api-worker': 60, 'mobile-app': 80, 'docs-site': 100, 'ops-tool': 0 };

test('makeSample + scan produces six projects, one repo edge and five graphs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overmap-sample-'));
  try {
    const { home } = await makeSample(dir);
    await scan(home);
    const data = readData(home);
    assert.equal(data.projects.length, 6);
    assert.ok(data.edges.some((e) => e.kind === 'repo' && e.a === 'api-worker' && e.b === 'shop-api'));
    assert.equal(data.projects.filter((p) => p.graph?.value).length, 5);
    assert.ok(data.services.some((s) => s.id === 'neon' && s.count === 3));
    assert.deepEqual(Object.fromEntries(data.projects.map((p) => [p.id, p.plan?.value?.percent])), PLAN_PERCENT);
    const failing = data.projects.filter((p) => p.tests?.value?.failed > 0).map((p) => p.id);
    assert.deepEqual(failing, ['shop-api']);
    for (const p of data.projects) {
      const g = p.repos[0].git.value;
      assert.equal(g.remotes.length, 1, `${p.id}: one remote`);
      assert.equal(g.modified + g.untracked, 0, `${p.id}: clean tree`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('makeSample with git:false still scans to six projects, with no repo edges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overmap-sample-'));
  try {
    const { home, projectsDir } = await makeSample(dir, { git: false });
    assert.ok(existsSync(join(projectsDir, 'api-worker', 'PLAN.md')));
    assert.equal(existsSync(join(projectsDir, 'shop-api', '.git')), false);
    await scan(home);
    const data = readData(home);
    assert.equal(data.projects.length, 6);
    assert.equal(data.edges.filter((e) => e.kind === 'repo').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('serve --sample answers /api/projects on the port it binds, and kills its child', async () => {
  const child = spawn(process.execPath, [join(ROOT, 'serve.mjs'), '--sample', '--port', '0'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let sampleDir = null;
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line; stderr: ${stderr}`)), 120_000);
      child.stdout.on('data', (c) => {
        stdout += c;
        const dir = stdout.match(/sample workspace in (.+)/);
        if (dir) sampleDir = dir[1].trim();
        const m = stdout.match(/dashboard on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m) { clearTimeout(timer); resolveUrl(m[1]); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}; stderr: ${stderr}`)); });
    });
    const res = await fetch(`${url}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.projects.length, 6);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
    if (sampleDir) rmSync(sampleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('--sample with --home is an error (exit 2)', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'serve.mjs'), '--sample', '--home', join(tmpdir(), 'nope')], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--sample cannot be combined with --home/);
});

test("startServer skips the connector scheduler when connectors is false", async () => {
  const home = mkdtempSync(join(tmpdir(), "sample-conn-"));
  writeFileSync(join(home, "overmap.config.json"), JSON.stringify({ vaultProjectsDir: home, port: 0 }));
  const calls = [];
  const fake = (...args) => { calls.push(args); return { stop() {} }; };
  try {
    const off = startServer({ home, env: {}, port: 0, connectors: false, startConnectors: fake });
    await once(off, "listening");
    await new Promise((r) => off.close(r));
    assert.equal(calls.length, 0);
    const on = startServer({ home, env: {}, port: 0, startConnectors: fake });
    await once(on, "listening");
    await new Promise((r) => on.close(r));
    assert.equal(calls.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});
