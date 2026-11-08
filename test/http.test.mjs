import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, HttpError } from '../lib/http.mjs';

const reply = (status, body, headers = {}) => async () => new Response(body, { status, headers });

test('rejects a host that is not in allowHosts, without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return new Response('{}'); };
  await assert.rejects(fetchJson('https://evil.example.com/x', { allowHosts: ['api.example.org'], fetchImpl }), /host not allowed/);
  assert.equal(called, false);
});

test('an empty or missing allowHosts rejects everything', async () => {
  await assert.rejects(fetchJson('https://a.example/x', { fetchImpl: reply(200, '{}') }), /host not allowed/);
});

test('a 500 becomes HttpError carrying the status and a body snippet', async () => {
  await assert.rejects(
    fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: reply(500, 'boom') }),
    (e) => e instanceof HttpError && e.status === 500 && /HTTP 500/.test(e.message) && e.bodySnippet === 'boom',
  );
});

test('a 302 is an error and is never followed', async () => {
  let seen;
  const fetchImpl = async (_u, init) => { seen = init; return new Response('', { status: 302, headers: { location: 'https://other.example/' } }); };
  await assert.rejects(fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl }), (e) => e instanceof HttpError && e.status === 302);
  assert.equal(seen.redirect, 'manual');
});

test('a never-resolving fetch times out', async () => {
  const fetchImpl = () => new Promise(() => {});
  await assert.rejects(fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl, timeoutMs: 50 }), /timed out/);
});

test('returns status, parsed json and text; sets the User-Agent and GET', async () => {
  let seen;
  const fetchImpl = async (_u, init) => { seen = init; return new Response('{"ok":true}', { status: 200 }); };
  const r = await fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl, headers: { authorization: 'Bearer x' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.text, '{"ok":true}');
  assert.equal(seen.method, 'GET');
  assert.equal(seen.headers['user-agent'], 'project-cockpit/stage2');
  assert.equal(seen.headers.authorization, 'Bearer x');
});

test('a non-JSON 2xx body gives json null', async () => {
  const r = await fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: reply(200, 'OK') });
  assert.equal(r.json, null);
  assert.equal(r.text, 'OK');
});
