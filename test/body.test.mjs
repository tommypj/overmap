import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readJsonBody, originOk } from '../server/body.mjs';

async function post(body, headers = { 'content-type': 'application/json' }) {
  const server = http.createServer(async (req, res) => {
    try {
      const b = await readJsonBody(req);
      res.writeHead(200); res.end(JSON.stringify(b));
    } catch (e) { res.writeHead(e.status ?? 500, { connection: 'close' }); res.end(); res.on('finish', () => { req.socket.end(); setTimeout(() => req.destroy(), 250).unref(); }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // Raw http client: a real response must arrive (a reset without one fails the test).
    return await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/', headers }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      rq.on('error', (e) => reject(e));
      rq.end(body);
    });
  } finally { server.closeAllConnections?.(); server.close(); }
}

test('readJsonBody accepts an object with charset', async () => {
  assert.equal(await post('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }), 200);
});
test('readJsonBody rejects bad input', async () => {
  assert.equal(await post('{"a":1}', { 'content-type': 'text/plain' }), 400);
  assert.equal(await post(JSON.stringify({ x: 'a'.repeat(70 * 1024) })), 400);
  assert.equal(await post('[1,2]'), 400);
  assert.equal(await post('"x"'), 400);
  assert.equal(await post('{bad'), 400);
});
test('originOk accepts loopback origins; the proxy origin only when a proxy host is configured', () => {
  const o = (origin) => ({ headers: origin === undefined ? {} : { origin } });
  for (const x of ['http://127.0.0.1:3210', 'http://localhost:3210']) assert.equal(originOk(o(x), 3210), true, x);
  assert.equal(originOk(o('https://box.tail0000.ts.net'), 3210, 'box.tail0000.ts.net'), true); // privacy-ok
  assert.equal(originOk(o('https://box.tail0000.ts.net'), 3210, null), false); // privacy-ok
  for (const x of ['http://127.0.0.1:3211', 'https://evil.example', 'null', undefined]) assert.equal(originOk(o(x), 3210), false, String(x));
});
