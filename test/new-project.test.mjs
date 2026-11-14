import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as realFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, noteFileName, validateNewProject, createProject } from '../lib/new-project.mjs';
import { slugify as browserSlugify } from '../web/slug.js';
import { parseFrontmatter } from '../lib/frontmatter.mjs';
import { loadRegistry } from '../registry.mjs';
import { createRoutes } from '../server/api.mjs';
import { createHandler } from '../server/router.mjs';
import { openDb } from '../lib/db.mjs';
import { listAudit } from '../lib/audit.mjs';

const LOGIN = 'me@example.com';
const TAIL = { host: 'host.tail0000.ts.net', origin: 'https://host.tail0000.ts.net', 'x-forwarded-proto': 'https', 'tailscale-user-login': LOGIN }; // privacy-ok

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-np-'));
  const projectsDir = join(dir, 'projects').replaceAll('\\', '/'), vaultDir = join(dir, 'vault').replaceAll('\\', '/');
  mkdirSync(projectsDir); mkdirSync(vaultDir);
  const registryFile = join(dir, 'registry.json');
  writeFileSync(registryFile, JSON.stringify({ version: 1, projects: {
    base: { name: 'base', family: 'F', kind: 'project', home: `${projectsDir}/base`, note: `${vaultDir}/base.md`, uses: [], protected: false },
    other: { name: 'other', family: 'F', kind: 'project', home: `${projectsDir}/other`, uses: [], protected: true },
  } }, null, 2) + '\n');
  return { dir, projectsDir, vaultDir, registryFile, registry: loadRegistry(registryFile) };
}
const good = { name: 'My Thing', family: 'Tools', purpose: 'Does a thing', branchesOff: 'base', uses: ['other'] };

test('slugify', () => {
  assert.equal(slugify('Acme — Growth Hub!'), 'acme-growth-hub');
  assert.equal(slugify('Élan Vital'), 'elan-vital');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify('abcdefghi '.repeat(7)), 'abcdefghi-'.repeat(4).slice(0, 39));
  assert.equal(slugify, browserSlugify);
  assert.equal(noteFileName('a/b:c'), 'a-b-c.md');
});

test('validateNewProject: field errors', () => {
  const s = setup();
  try {
    const o = { registry: s.registry, projectsDir: s.projectsDir, vaultDir: s.vaultDir };
    const bad = validateNewProject({ name: 'x', family: 'a/b', purpose: '', branchesOff: 'nope', uses: ['nope'] }, o);
    assert.equal(bad.ok, false);
    for (const k of ['name', 'family', 'purpose', 'branchesOff', 'uses']) assert.ok(bad.errors[k], k);
    assert.match(validateNewProject({ ...good, name: 'Base' }, o).errors.name, /already exists/);
    mkdirSync(`${s.projectsDir}/my-thing`);
    assert.match(validateNewProject(good, o).errors.name, /folder/);
    rmSync(`${s.projectsDir}/my-thing`, { recursive: true });
    writeFileSync(`${s.vaultDir}/My Thing.md`, 'x');
    assert.match(validateNewProject(good, o).errors.name, /vault note/);
    rmSync(`${s.vaultDir}/My Thing.md`);
    const ok = validateNewProject(good, o);
    assert.equal(ok.ok, true);
    assert.equal(ok.value.home, `${s.projectsDir}/my-thing`);
    assert.equal(ok.value.note, `${s.vaultDir}/My Thing.md`);
    assert.equal(validateNewProject({ ...good, name: '../..' }, o).ok, false);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('createProject writes skeleton, notes and registry', () => {
  const s = setup();
  try {
    const v = validateNewProject(good, { registry: s.registry, projectsDir: s.projectsDir, vaultDir: s.vaultDir }).value;
    const before = JSON.parse(readFileSync(s.registryFile, 'utf8'));
    const r = createProject(v, { registryFile: s.registryFile, now: () => Date.parse('2026-11-02T10:00:00Z') });
    assert.deepEqual(r, { id: 'my-thing', home: v.home, note: v.note });
    for (const f of ['docs', 'assets', 'outputs', 'exports', 'ops', 'repos']) assert.ok(existsSync(`${v.home}/${f}`), f);
    const pm = parseFrontmatter(readFileSync(`${v.home}/PROJECT.md`, 'utf8'));
    assert.equal(pm.data.status, 'active'); assert.equal(pm.data.summary, 'Does a thing'); assert.equal(pm.data.created, '2026-11-02'); assert.equal(pm.data.branchesOff, 'base');
    const n = parseFrontmatter(readFileSync(v.note, 'utf8'));
    assert.equal(n.data.dashboard, true); assert.equal(n.data.path, v.home);
    const after = JSON.parse(readFileSync(s.registryFile, 'utf8'));
    assert.deepEqual(after.projects['my-thing'], { name: 'My Thing', family: 'Tools', kind: 'project', home: v.home, note: v.note, uses: ['other'], protected: false, branchesOff: 'base' });
    assert.deepEqual(before.projects, Object.fromEntries(Object.entries(after.projects).filter(([k]) => k !== 'my-thing')));
    assert.equal(existsSync(`${s.registryFile}.tmp`), false);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('createProject failure reports created paths', () => {
  const s = setup();
  try {
    const v = validateNewProject(good, { registry: s.registry, projectsDir: s.projectsDir, vaultDir: s.vaultDir }).value;
    const fs = { ...realFs, renameSync() { throw new Error('boom'); } };
    assert.throws(() => createProject(v, { registryFile: s.registryFile, fs }), (e) => e.created.includes(v.home) && e.created.includes(v.note));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

async function withApp(fn, { noVault = false } = {}) {
  const s = setup();
  const rescans = [];
  const actionsDir = join(s.dir, 'actions');
  mkdirSync(actionsDir);
  const config = { home: s.dir, allowedLogin: LOGIN, projectsDir: s.projectsDir, ...(noVault ? {} : { vaultProjectsDir: s.vaultDir }) };
  const routes = createRoutes({ config, actionsDir, rescan: (f) => { rescans.push(f); }, isScanning: () => false });
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ config, port, routes }));
  const call = (method, path, body, headers) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (method === 'POST') { h['content-type'] = 'application/json'; if (!h.origin) h.origin = `http://127.0.0.1:${port}`; }
    const rq = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
    });
    rq.on('error', reject);
    rq.end(method === 'POST' ? JSON.stringify(body ?? {}) : undefined);
  });
  const get = (p, h) => call('GET', p, null, h);
  const post = (p, b, h) => call('POST', p, b, h);
  try { await fn({ get, post, rescans, s }); } finally { routes.close(); server.closeAllConnections?.(); server.close(); rmSync(s.dir, { recursive: true, force: true }); }
}

test('route: validation, confirm, create, duplicate, tailnet', async () => {
  await withApp(async ({ get, post, rescans, s }) => {
    const csrf = (await get('/api/csrf')).json.token;
    const bad = await post('/api/actions/new-project', { ...good, csrf, name: 'x' });
    assert.equal(bad.status, 400); assert.ok(bad.json.errors.name);
    const c = await post('/api/actions/new-project', { ...good, csrf });
    assert.equal(c.status, 409);
    assert.equal(existsSync(`${s.projectsDir}/my-thing`), false);
    const ok = await post('/api/actions/new-project', { ...good, csrf, confirm: c.json.confirm.nonce });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.json, { id: 'my-thing', home: `${s.projectsDir}/my-thing`, note: `${s.vaultDir}/My Thing.md` });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(rescans, [false]);
    const again = await post('/api/actions/new-project', { ...good, csrf });
    assert.equal(again.status, 400);
    const tcsrf = (await get('/api/csrf', TAIL)).json.token;
    const t = await post('/api/actions/new-project', { ...good, name: 'Tail Thing', csrf: tcsrf }, TAIL);
    assert.equal(t.status, 409);
    const t2 = await post('/api/actions/new-project', { ...good, name: 'Tail Thing', csrf: tcsrf, confirm: t.json.confirm.nonce }, TAIL);
    assert.equal(t2.status, 201);
  });
});

test('validate: control chars, reserved names, uses limits, dedupe', () => {
  const s = setup();
  try {
    const o = { registry: s.registry, projectsDir: s.projectsDir, vaultDir: s.vaultDir };
    const inj = validateNewProject({ ...good, purpose: 'x\ndashboard: false\npath: /elsewhere' }, o);
    assert.equal(inj.errors.purpose, 'no line breaks or control characters');
    assert.equal(validateNewProject({ ...good, name: 'a\tb' }, o).errors.name, 'no line breaks or control characters');
    assert.equal(validateNewProject({ ...good, family: 'a\nb' }, o).errors.family, 'no line breaks or control characters');
    assert.equal(validateNewProject({ ...good, name: 'NUL' }, o).errors.name, 'reserved name on Windows');
    assert.equal(validateNewProject({ ...good, name: 'com1' }, o).errors.name, 'reserved name on Windows');
    const many = Array.from({ length: 11 }, () => 'base');
    assert.ok(validateNewProject({ ...good, uses: many }, o).errors.uses);
    assert.deepEqual(validateNewProject({ ...good, uses: ['base', 'base', 'other'] }, o).value.uses, ['base', 'other']);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('createProject: unreadable registry fails with nothing written; no branchesOff key; punctuation round-trips', () => {
  const s = setup();
  try {
    const o = { registry: s.registry, projectsDir: s.projectsDir, vaultDir: s.vaultDir };
    const v = validateNewProject(good, o).value;
    assert.throws(() => createProject(v, { registryFile: join(s.dir, 'missing.json') }));
    assert.equal(existsSync(v.home), false); assert.equal(existsSync(v.note), false);
    const purpose = 'He said "hi": ok # yes \'q\'';
    const v2 = validateNewProject({ name: 'Plain', family: 'Tools', purpose }, o).value;
    createProject(v2, { registryFile: s.registryFile });
    assert.equal(parseFrontmatter(readFileSync(`${v2.home}/PROJECT.md`, 'utf8')).data.summary, purpose);
    assert.equal(parseFrontmatter(readFileSync(v2.note, 'utf8')).data.summary, purpose);
    assert.equal('branchesOff' in parseFrontmatter(readFileSync(`${v2.home}/PROJECT.md`, 'utf8')).data, false);
    assert.equal('branchesOff' in JSON.parse(readFileSync(s.registryFile, 'utf8')).projects.plain, false);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('route: injection refused with nothing written, audit rows, nonce bound to note, 503 unconfigured', async () => {
  await withApp(async ({ get, post, s }) => {
    const csrf = (await get('/api/csrf')).json.token;
    const bad = await post('/api/actions/new-project', { ...good, csrf, purpose: 'x\ndashboard: false' });
    assert.equal(bad.status, 400); assert.ok(bad.json.errors.purpose);
    assert.equal(existsSync(`${s.projectsDir}/my-thing`), false);
    const c = await post('/api/actions/new-project', { ...good, csrf });
    const swap = await post('/api/actions/new-project', { ...good, name: 'My-Thing', csrf, confirm: c.json.confirm.nonce });
    assert.equal(swap.status, 403);
    assert.equal(existsSync(`${s.projectsDir}/my-thing`), false);
    const c2 = await post('/api/actions/new-project', { ...good, csrf });
    const ok = await post('/api/actions/new-project', { ...good, csrf, confirm: c2.json.confirm.nonce });
    assert.equal(ok.status, 201);
    const db = openDb(join(s.dir, 'data', 'overmap.db'));
    const rows = listAudit(db, { limit: 20 }).filter((r) => r.action === 'new-project');
    db.close();
    assert.ok(rows.some((r) => r.status === 'ok'));
    assert.ok(rows.some((r) => r.status === 'refused' && /purpose/.test(r.result.error)));
  });
  await withApp(async ({ get, post }) => {
    const csrf = (await get('/api/csrf')).json.token;
    const r = await post('/api/actions/new-project', { ...good, csrf });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'new project not configured');
  }, { noVault: true });
});

test('reserved device names are refused even with an extension part', () => {
  const o = { registry: new Map(), exists: () => false, projectsDir: '/projects', vaultDir: '/vault' };
  for (const name of ['nul.foo', 'NUL', 'com1.x']) {
    const v = validateNewProject({ name, family: 'f', purpose: 'p' }, o);
    assert.equal(v.ok, false, name);
    assert.equal(v.errors.name, 'reserved name on Windows', name);
  }
});
