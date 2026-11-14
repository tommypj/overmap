// Final fix wave: credential hardening, size cache reuse, secret masking, EADDRINUSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSafe, listDir, indexFiles, Forbidden } from '../server/fsapi.mjs';
import { SECRET_NAME } from '../lib/paths.mjs';
import { createApp, startServer } from '../serve.mjs';
import { createRoutes } from '../server/api.mjs';
import { createHandler } from '../server/router.mjs';
import { cachedSize } from '../scan/assemble.mjs';

const base = mkdtempSync(join(tmpdir(), 'hard-'));
test.after(() => rmSync(base, { recursive: true, force: true }));

const sec = join(base, 'sec');
mkdirSync(join(sec, 'foo', 'secrets'), { recursive: true });
mkdirSync(join(sec, 'foo', 'ok'), { recursive: true });
mkdirSync(join(sec, '.sandbox-secrets'), { recursive: true });
const SECRET_FILES = {
  'foo/secrets/x.txt': 'plain',
  '.sandbox-secrets/a.txt': 'plain',
  'auth.json': '{}',
  '.credentials.json': '{}',
  'my-firebase-admin.json': '{}',
  'pem.txt': '-----BEGIN RSA PRIVATE KEY-----\nabc', // privacy-ok
  'key.json': '{"type":"x","private_key": "abc"}',
  'cfg.json': '{"token":"pcp_board_abc123"}', // privacy-ok
  'oauth.json': '{"refresh_token":"x"}',
};
for (const [f, c] of Object.entries(SECRET_FILES)) writeFileSync(join(sec, f), c);
writeFileSync(join(sec, 'notes.md'), 'My secretary called about the meeting.');
writeFileSync(join(sec, 'big.txt'), 'x'.repeat(1024 * 1024 + 10) + ' refresh_token');
writeFileSync(join(sec, 'foo', 'ok', 'pic.png'), 'x');
writeFileSync(join(sec, 'foo', 'secrets', 'pic.png'), 'x');

test('secret segments and names: forbidden in resolveSafe, hidden in listings and indexes', () => {
  for (const f of ['foo/secrets/x.txt', '.sandbox-secrets/a.txt', 'auth.json', '.credentials.json', 'my-firebase-admin.json']) {
    assert.throws(() => resolveSafe([sec], 0, f), Forbidden, f);
  }
  const names = listDir(sec).entries.map((e) => e.name);
  for (const n of ['.sandbox-secrets', 'auth.json', '.credentials.json', 'my-firebase-admin.json']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('notes.md'));
  const idx = indexFiles([sec], 'media').files.map((f) => f.path);
  assert.ok(idx.includes('foo/ok/pic.png'));
  assert.ok(!idx.some((p) => p.includes('secrets')));
});

test('SECRET_NAME widened, with negatives', () => {
  for (const n of ['auth.json', 'Auth-State.json', 'token.json', 'tokens.json', '.git-credentials', '.netrc', '_netrc', 'a.ppk', 'x-firebase-admin-sdk.json', 'my_service_account.json', 'serviceAccount.json', '.htpasswd', '.pypirc', 'a.asc', 'a.gpg', 'a.ovpn']) assert.ok(SECRET_NAME.test(n), n);
  for (const n of ['known_hosts', 'author.json', 'tokenizer.json', '.env.example']) assert.ok(!SECRET_NAME.test(n), n);
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', r));
}
function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    }).on('error', reject);
  });
}
const closeServer = async (s) => { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); };
// An instance folder (under base) holding a scan result at data/projects.json.
function homeWith(name, projects) {
  const h = join(base, name);
  mkdirSync(join(h, 'data'), { recursive: true });
  writeFileSync(join(h, 'data', 'projects.json'), JSON.stringify({ generatedAt: 'x', projects }));
  return h;
}
// An instance folder (under base) holding only overmap.config.json, for startServer.
function configHome(name, port) {
  const h = join(base, name);
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, 'overmap.config.json'), JSON.stringify({ vaultProjectsDir: '/p', allowedLogin: 'a@example.com', port }));
  return h;
}

test('content check: 403 over HTTP for each pattern class (incl. Range), negatives served', async () => {
  const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'a@example.com', port: 45872, architectureFile: '/a.md', memoryRoot: '/m' };
  const server = createApp({ ...config, home: homeWith('sec-home', [{ id: 'S', name: 'S', roots: [sec] }]) });
  await listen(server);
  const port = server.address().port;
  const H = { host: '127.0.0.1:45872' };
  try {
    for (const f of Object.keys(SECRET_FILES)) {
      assert.equal((await get(port, `/api/file?id=S&root=0&path=${encodeURIComponent(f)}`, H)).status, 403, f);
    }
    for (const f of ['pem.txt', 'key.json', 'cfg.json', 'oauth.json']) {
      const hit = (await get(port, `/api/file?id=S&root=0&path=${f}`, H));
      // these names are not secret names, so the 403 must come from the content check
      assert.match(hit.body, /holds a secret/, f);
      assert.equal((await get(port, `/api/file?id=S&root=0&path=${f}`, { ...H, range: 'bytes=0-3' })).status, 403, `range ${f}`);
    }
    const ok = await get(port, '/api/file?id=S&root=0&path=notes.md', H);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /secretary/);
    assert.equal((await get(port, '/api/file?id=S&root=0&path=big.txt', H)).status, 200); // over 1 MiB: not scanned
  } finally { await closeServer(server); }
});

test('--no-size reuses the cached size, null when uncached', () => {
  const cache = { '/x': { key: 'k', size: { code: 5, deps: 7 }, at: '2026-10-30T00:00:00.000Z' } };
  assert.deepEqual(cachedSize('/x', cache), { code: 5, deps: 7, at: '2026-10-30T00:00:00.000Z' });
  assert.equal(cachedSize('/y', cache), null);
});



test('a second server process on a busy port exits with code 2', async () => {
  const blocker = http.createServer();
  await listen(blocker);
  const p = blocker.address().port;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['serve.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, OVERMAP_HOME: configHome('e2-home', p), OVERMAP_NO_SCHEDULE: '1' },
    });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => resolve({ code, err }));
  });
  blocker.close();
  assert.equal(out.code, 2);
  assert.match(out.err, /in use/);
});

test('writeIfChanged and updateMoc skip rewrites that only change the timestamp', async () => {
  const { writeIfChanged, updateMoc } = await import('../scan/assemble.mjs');
  const { statSync, readFileSync, utimesSync } = await import('node:fs');
  const f = join(base, 'arch.md');
  assert.equal(writeIfChanged(f, '# A\n'), true);
  utimesSync(f, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(writeIfChanged(f, '# A\n'), false);
  assert.equal(statSync(f).mtime.getFullYear(), 2020);
  assert.equal(writeIfChanged(f, '# B\n'), true);

  const moc = join(base, 'moc.md');
  const table = (stamp, row) => `<!-- dashboard:start -->\n_Scanned ${stamp} · 1 projects._\n${row}\n<!-- dashboard:end -->`;
  writeFileSync(moc, table('2026-10-31 10:00', 'row1'));
  utimesSync(moc, new Date(2020, 0, 1), new Date(2020, 0, 1));
  updateMoc(moc, table('2026-10-31 10:15', 'row1'));
  assert.equal(statSync(moc).mtime.getFullYear(), 2020);
  updateMoc(moc, table('2026-10-31 10:30', 'row2'));
  assert.match(readFileSync(moc, 'utf8'), /row2/);
});

test('byte-based content check: any extension, UTF-16, binary skipped; sqlite and push-tokens hidden', async () => {
  const d = join(base, 'bytes');
  mkdirSync(d);
  writeFileSync(join(d, 'log.jsonl'), '{"a":"pcp_board_abcdefgh12345678"}\n'); // privacy-ok
  writeFileSync(join(d, 'pem16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('-----BEGIN PRIVATE KEY-----', 'utf16le')])); // privacy-ok
  writeFileSync(join(d, 'notes.jsonl'), '{"a":"hello"}\n');
  writeFileSync(join(d, 'x.sqlite'), 'SQLite');
  writeFileSync(join(d, '.push-tokens.json'), '{}');
  writeFileSync(join(d, 'pic.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0, 0, 0]), Buffer.from('refresh_token')]));
  assert.ok(!listDir(d).entries.some((e) => e.name === 'x.sqlite' || e.name === '.push-tokens.json'));
  const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'a@example.com', port: 45874, architectureFile: '/a.md', memoryRoot: '/m' };
  const server = createApp({ ...config, home: homeWith('bytes-home', [{ id: 'B', name: 'B', roots: [d] }]) });
  await listen(server);
  const port = server.address().port;
  const H = { host: '127.0.0.1:45874' };
  const head = (path) => new Promise((resolve, reject) => http.request({ host: '127.0.0.1', port, path, method: 'HEAD', headers: H }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject).end());
  const u = (f) => `/api/file?id=B&root=0&path=${encodeURIComponent(f)}`;
  try {
    assert.equal((await get(port, u('log.jsonl'), H)).status, 403);
    assert.equal(await head(u('log.jsonl')), 403);
    assert.equal((await get(port, u('pem16.txt'), H)).status, 403);
    assert.equal((await get(port, u('notes.jsonl'), H)).status, 200);
    assert.equal((await get(port, u('x.sqlite'), H)).status, 403);
    assert.equal((await get(port, u('.push-tokens.json'), H)).status, 403);
    assert.equal((await get(port, u('pic.png'), { ...H, range: 'bytes=0-3' })).status, 206);
  } finally { await closeServer(server); }
});
