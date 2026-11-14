import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, sendJson } from '../server/router.mjs';
import { createActionRoutes } from '../server/actions.mjs';

const config = { allowedLogin: 'me@example.com' };
async function withApp(fn) {
  const calls = [];
  const routes = async (ctx) => { calls.push(ctx.body); sendJson(ctx.req, ctx.res, 200, { ok: true }); return true; };
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ config, port, routes }));
  try { await fn({ port, calls }); } finally { server.closeAllConnections?.(); server.close(); }
}
const req = (port, path, { method = 'POST', headers = {}, body = '{"a":1}' } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body });

test('POST /api/actions/x with good origin gets the parsed body', async () => {
  await withApp(async ({ port, calls }) => {
    const r = await req(port, '/api/actions/x', { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [{ a: 1 }]);
  });
});
test('POST without or with bad origin: 403, routes not called', async () => {
  await withApp(async ({ port, calls }) => {
    const r = await req(port, '/api/actions/x');
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'bad origin' });
    assert.equal((await req(port, '/api/actions/x', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal(calls.length, 0);
  });
});
test('POST elsewhere is 405; GET body is undefined', async () => {
  await withApp(async ({ port, calls }) => {
    const r = await req(port, '/api/projects', { headers: { origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
    await req(port, '/api/x', { method: 'GET' });
    assert.deepEqual(calls, [undefined]);
  });
});
test('POST through the tailnet headers with the tailnet origin', async () => {
  await withApp(async ({ port }) => {
    // fetch forbids overriding Host, so use raw http.request
    const status = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/actions/x', method: 'POST', headers: {
        host: 'host.tail0000.ts.net', origin: 'https://host.tail0000.ts.net', 'content-type': 'application/json', // privacy-ok
        'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@example.com',
      } }, (res) => { res.resume(); resolve(res.statusCode); });
      rq.on('error', reject);
      rq.end('{}');
    });
    assert.equal(status, 200);
  });
});

test('over-limit chunked body: 400 arrives and the socket closes', async () => {
  await withApp(async ({ port, calls }) => {
    const { status, closed } = await new Promise((resolve, reject) => {
      let status;
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/actions/x', method: 'POST', headers: {
        origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
        status = res.statusCode; res.resume();
        res.socket.on('close', () => resolve({ status, closed: true }));
      });
      rq.on('error', () => { if (status) resolve({ status, closed: true }); else reject(new Error('no response')); });
      rq.write('{"x":"');
      let n = 0;
      const pump = setInterval(() => { if (rq.destroyed || ++n > 200) return clearInterval(pump); rq.write('a'.repeat(8192)); }, 1);
    });
    assert.equal(status, 400);
    assert.equal(closed, true);
    assert.equal(calls.length, 0);
  });
});

async function withRoutes(routes, fn) {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createHandler({ config, port, routes }));
  try { await fn({ port }); } finally { server.closeAllConnections?.(); server.close(); }
}

test('removed action routes are 404 (run, open-local, stop-process, output, files, list)', async () => {
  const routes = createActionRoutes({ getDb: () => null, getRegistry: () => new Map(), tokens: { check: () => false }, who: () => ({ class: 'laptop', login: '' }) });
  await withRoutes(routes, async ({ port }) => {
    const origin = { origin: `http://127.0.0.1:${port}` };
    for (const p of ['/api/actions/run', '/api/actions/open-local', '/api/actions/stop-process']) {
      assert.equal((await req(port, p, { headers: origin, body: '{}' })).status, 404, p);
    }
    for (const p of ['/api/actions/files', '/api/actions/output', '/api/actions']) {
      assert.equal((await req(port, p, { method: 'GET' })).status, 404, p);
    }
  });
});
