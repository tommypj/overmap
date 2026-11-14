import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../serve.mjs';

const NOMINAL = 45871; // the port the Host header claims; the test server itself binds port 0
const LOGIN = 'me@example.com';
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: LOGIN, port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };

const base = mkdtempSync(join(tmpdir(), 'serve-'));
const root = join(base, 'proj');
mkdirSync(root);
writeFileSync(join(root, 'ten.txt'), '0123456789ABCDEF');
writeFileSync(join(root, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
writeFileSync(join(root, '.env'), 'SECRET=1');
writeFileSync(join(root, 'clip.mp4'), 'xx');
mkdirSync(join(base, 'data'));
const dataFile = join(base, 'data', 'projects.json');
writeFileSync(dataFile, JSON.stringify({ generatedAt: '2026-10-31T10:00:00Z', scanSeconds: 3, projects: [{ id: 'P1', name: 'P1', roots: [root] }], unmapped: [] }));

let server;
let port;
before(async () => {
  server = createApp({ ...config, home: base });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(base, { recursive: true, force: true });
});

const laptopHeaders = () => ({ host: `127.0.0.1:${NOMINAL}` });
const tailnetHeaders = () => ({ host: 'host.tail0000.ts.net', 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.7', 'tailscale-user-login': LOGIN }); // privacy-ok

function req(path, { method = 'GET', headers = laptopHeaders() } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body.toString());

test('foreign Host is 403', async () => {
  const r = await req('/api/projects', { headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

test('tailscale login without x-forwarded-proto is 403 not allowed', async () => {
  const r = await req('/api/projects', { headers: { host: `127.0.0.1:${NOMINAL}`, 'tailscale-user-login': LOGIN } });
  assert.equal(r.status, 403);
  assert.deepEqual(json(r), { error: 'not allowed from here' });
});

test('whoami reports class and login for both classes', async () => {
  assert.deepEqual(json(await req('/api/whoami')), { class: 'laptop', login: null });
  assert.deepEqual(json(await req('/api/whoami', { headers: tailnetHeaders() })), { class: 'tailnet', login: LOGIN });
});

test('non-GET is 405, POST /api/actions/* without a good Origin is 403', async () => {
  assert.equal((await req('/api/projects', { method: 'POST' })).status, 405);
  assert.equal((await req('/api/projects', { method: 'DELETE' })).status, 405);
  const r = await req('/api/actions/x', { method: 'POST' });
  assert.equal(r.status, 403);
  assert.deepEqual(json(r), { error: 'bad origin' });
  assert.equal((await req('/api/actions/x', { method: 'GET' })).status, 404);
});

test('/projects prefix is stripped once and bodies match', async () => {
  const a = await req('/api/projects');
  const b = await req('/projects/api/projects', { headers: tailnetHeaders() });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(json(a).projects[0].id, 'P1');
  assert.equal((await req('/projects/projects/api/projects')).status, 404);
  assert.equal((await req('/projects/')).status, 200);
});

test('hardening headers on every response, no-store on api', async () => {
  for (const [p, h] of [['/api/projects', laptopHeaders()], ['/', laptopHeaders()], ['/nope', laptopHeaders()], ['/api/projects', { host: 'evil.example.com' }]]) {
    const r = await req(p, { headers: h });
    assert.equal(r.headers['x-robots-tag'], 'noindex', p);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'", p);
  }
  assert.equal((await req('/api/projects')).headers['cache-control'], 'no-store');
  assert.equal((await req('/')).headers['cache-control'], 'no-cache');
});

test('static: / and /web/*, 404 outside web/', async () => {
  const idx = await req('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-type'], /text\/html/);
  const js = await req('/web/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal((await req('/web/..%2Fprojects.json')).status, 404);
  assert.equal((await req('/web/%2e%2e/projects.json')).status, 404);
  assert.equal((await req('/web/missing.js')).status, 404);
});

test('/legacy serves HTML', async () => {
  const r = await req('/legacy');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
});

test('Range: 206 with Content-Range, 416 when unsatisfiable, suffix and open ranges', async () => {
  const q = '/api/file?id=P1&root=0&path=ten.txt';
  const r = await req(q, { headers: { ...laptopHeaders(), range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.body.length, 10);
  assert.equal(r.body.toString(), '0123456789');
  assert.equal(r.headers['content-range'], 'bytes 0-9/16');
  assert.equal(r.headers['accept-ranges'], 'bytes');
  const open = await req(q, { headers: { ...laptopHeaders(), range: 'bytes=12-' } });
  assert.equal(open.body.toString(), 'CDEF');
  assert.equal(open.headers['content-range'], 'bytes 12-15/16');
  const suffix = await req(q, { headers: { ...laptopHeaders(), range: 'bytes=-3' } });
  assert.equal(suffix.body.toString(), 'DEF');
  const bad = await req(q, { headers: { ...laptopHeaders(), range: 'bytes=99999-' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */16');
  const full = await req(q);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-disposition'], 'inline; filename="ten.txt"');
  const head = await req(q, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '16');
  assert.equal(head.body.length, 0);
});

test('.svg is served as text/plain; mp4 as video/mp4', async () => {
  const svg = await req('/api/file?id=P1&root=0&path=pic.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal((await req('/api/file?id=P1&root=0&path=clip.mp4')).headers['content-type'], 'video/mp4');
});

test('file API refuses secrets, traversal, bad root; unknown project 404', async () => {
  assert.equal((await req('/api/file?id=P1&root=0&path=.env')).status, 403);
  assert.equal((await req('/api/file?id=P1&root=0&path=..%2Fx')).status, 403);
  assert.equal((await req('/api/file?id=P1&root=0&path=..%5Cx')).status, 403);
  assert.equal((await req('/api/file?id=P1&root=7&path=ten.txt')).status, 403);
  assert.equal((await req('/api/file?id=NOPE&root=0&path=ten.txt')).status, 404);
  assert.equal((await req('/api/file?id=P1&root=0&path=missing.txt')).status, 404);
});

test('ls and index return the documented shapes', async () => {
  const ls = json(await req('/api/ls?id=P1&root=0&path='));
  assert.equal(ls.root, 0);
  assert.equal(ls.truncated, false);
  assert.ok(ls.entries.some((e) => e.name === 'ten.txt'));
  assert.ok(!ls.entries.some((e) => e.name === '.env'));
  const ix = json(await req('/api/index?id=P1&kind=media'));
  assert.deepEqual(ix.files.map((f) => f.name).sort(), ['clip.mp4', 'pic.svg']);
  assert.equal(ix.truncated, false);
  assert.equal((await req('/api/index?id=P1&kind=bogus')).status, 400);
});

test('settings has secrets health, config, lastScan', async () => {
  const s = json(await req('/api/settings'));
  assert.ok(['missing', 'unprotected', 'unreadable', 'ok'].includes(s.secrets.file));
  assert.deepEqual(s.config, { home: base, vaultProjectsDir: '/p', architectureFile: '/a.md' });
  assert.equal(s.lastScan, null);
});

test('/legacy gets a relaxed CSP, everything else stays strict', async () => {
  assert.match((await req('/legacy')).headers['content-security-policy'], /'unsafe-inline'/);
  assert.doesNotMatch((await req('/api/projects')).headers['content-security-policy'], /unsafe-inline/);
});

test('.js and .css from projects are served as text/plain', async () => {
  writeFileSync(join(root, 'x.js'), 'alert(1)');
  assert.equal((await req('/api/file?id=P1&root=0&path=x.js')).headers['content-type'], 'text/plain; charset=utf-8');
});

test('missing projects.json is 404 no scan yet; // path cannot change host', async () => {
  const hidden = dataFile + '.off';
  renameSync(dataFile, hidden);
  try {
    for (const p of ['/api/projects', '/api/ls?id=P1&root=0']) {
      const r = await req(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(json(r), { error: 'no scan yet' });
    }
  } finally { renameSync(hidden, dataFile); }
  assert.equal((await req('//evil.com/api/projects')).status, 404); // path /evil.com/api/projects, not a host
  assert.equal((await req('//api/projects')).status, 200);
});

test('GET /setup serves the setup guide as plain text', async () => {
  const r = await req('/setup');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/plain; charset=utf-8/);
  assert.match(r.body.toString(), /secrets\.json/);
  const t = await req('/projects/setup', { headers: tailnetHeaders() });
  assert.equal(t.status, 200);
});
