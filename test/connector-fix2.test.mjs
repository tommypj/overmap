import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { runConnector, sanitiseError } from '../lib/connector.mjs';
import { maskText } from '../lib/mask.mjs';
import { fetchJson, HttpError } from '../lib/http.mjs';
import health from '../connectors/health.mjs';

const M = '‹secret›';

// ---- 1. streamed body cap ----
test('a body over the cap is cancelled mid-stream, before the remaining chunks are pulled', async () => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1.1 * 1024 * 1024);
  const body = new ReadableStream({
    pull(c) { pulls++; if (pulls <= 6) c.enqueue(chunk); else c.close(); },
    cancel() { cancelled = true; },
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
  await assert.rejects(
    fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: async () => new Response(body, { status: 200 }) }),
    (e) => e instanceof HttpError && /too large/.test(e.message),
  );
  assert.equal(cancelled, true);
  assert.equal(pulls, 5);
});

test('a declared content-length over the cap is rejected without reading the body', async () => {
  let pulls = 0;
  const body = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(10)); } }, new CountQueuingStrategy({ highWaterMark: 0 }));
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) } });
  await assert.rejects(fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl }), /too large/);
  assert.equal(pulls, 0);
});

test('a normal streamed body is assembled intact', async () => {
  const r = await fetchJson('https://a.example/x', { allowHosts: ['a.example'], fetchImpl: async () => new Response('{"a":[1,2,3]}') });
  assert.deepEqual(r.json, { a: [1, 2, 3] });
});

// ---- 4. new shapes ----
test('maskText: new query params, JSON-ish values and header echoes', () => {
  const cases = [
    ['https://h/p?refresh_token=RT123456789', 'RT123456789'],
    ['https://h/p?a=1&client_secret=CS123456789', 'CS123456789'],
    ['https://h/p?id_token=IDT12345678&x=1', 'IDT12345678'],
    ['https://h/cb?code=AUTHCODE9999&state=STATEVAL999', 'AUTHCODE9999'],
    ['https://h/cb?code=AUTHCODE9999&state=STATEVAL999', 'STATEVAL999'],
    ['https://s3/x?X-Amz-Signature=SIG1234567', 'SIG1234567'],
    ['https://s3/x?X-Amz-Security-Token=SEC1234567', 'SEC1234567'],
    ['https://s3/x?x-goog-signature=GSIG123456', 'GSIG123456'],
    ['https://h/x?My-Custom-Token=CUST1234567', 'CUST1234567'],
    ['token=STARTVALUE123 and more', 'STARTVALUE123'],
    ['{"access_token":"AT12345678","x":1}', 'AT12345678'],
    ['{ "Password" : "hunter2hunter2" }', 'hunter2hunter2'],
    ['{"client_secret": "CSV12345678"}', 'CSV12345678'],
    ['sent X-API-Key: KEY1234567890 to server', 'KEY1234567890'],
    ['Set-Cookie: session=abcdef123456; Path=/', 'abcdef123456'],
    ['api-key: APIK1234567', 'APIK1234567'],
    ['x-auth-token: XAT1234567', 'XAT1234567'],
  ];
  for (const [text, secret] of cases) {
    const out = maskText(text);
    assert.ok(!out.includes(secret), `${text} -> ${out}`);
    assert.ok(out.includes(M), `${text} -> ${out}`);
  }
  assert.equal(maskText('{"access_token":"AT12345678","x":1}'), `{"access_token":"${M}","x":1}`);
});

// ---- 5. over-matching ----
test('maskText leaves ordinary text alone', () => {
  for (const t of ['Upgraded to Basic plan', 'http://10.0.0.1:8001//api', 'https://host:8080/p?email=a@example.com', 'see the bearer of bad news', 'order 1//2 done', 'status: ok']) {
    assert.equal(maskText(t), t);
  }
});

test('maskText: userinfo greedy to the last @ of the authority; token-like runs only', () => {
  assert.equal(maskText('https://user:p@ss@host/x'), `https://${M}@host/x`);
  assert.equal(maskText('fail https://user:hunter22@example.com/path'), `fail https://${M}@example.com/path`);
  assert.equal(maskText('Authorization: Basic dXNlcjpwYXNz'), `Authorization: Basic ${M}`);
  assert.equal(maskText('refresh 1//0gAbCdEf-GhIj'), `refresh ${M}`);
});

test('literal prefix rule: skips host-only or letters-only prefixes, still masks random-looking ones', () => {
  // URL-shaped secret: prefix judged after the scheme; "example.com/" has no digits -> not masked on its own
  assert.equal(maskText('talking to https://example.com/x', ['https://example.com/secretpath']), 'talking to https://example.com/x');
  assert.equal(maskText('plain word abcdefghijkl here', ['abcdefghijklmnop']), 'plain word abcdefghijkl here');
  assert.ok(!maskText('echo sk9a8b7c6d5e4 trunc', ['sk9a8b7c6d5e4f3g2h1']).includes('sk9a8b7c6d5e4'));
});

// ---- 2. event url / json ----
test('event url and json are masked like the title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-fix2-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    const conn = {
      id: 'ev', every: '5m', secrets: [], required: [],
      fetch: async () => ({}),
      parse: () => ({ facts: [], series: [], events: [{ kind: 'k', at: '2026-10-30T00:00:00Z', title: 't', url: 'https://h/x?access_token=URLTOKEN12345', external_id: 'e', json: { note: 'Bearer JSONBEARER12345' } }] }),
    };
    await runConnector(conn, { project: 'P' }, { getSecret: () => undefined, fetchJson, now: () => Date.now() }, db);
    const row = db.prepare('SELECT url, json FROM events').get();
    assert.ok(!row.url.includes('URLTOKEN12345'));
    assert.ok(!row.json.includes('JSONBEARER12345'));
    JSON.parse(row.json);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- 6. health reason masked before the cut ----
test('health reason is masked before being cut to 200 chars', async () => {
  const raw = await health.fetch({ project: 'A', url: 'https://a.example/h' }, {
    now: () => Date.now(),
    fetchJson: async () => { throw new Error('x'.repeat(190) + ' Bearer ABCDEFGHIJKLMNOP'); },
  });
  assert.ok(!/Bearer\s+A/.test(raw.reason), raw.reason);
  assert.ok(raw.reason.length <= 200);
});

// ---- 7. secrets cache notices ctime changes ----
test('sanitiseError still cuts to 300 after masking', () => {
  assert.equal(sanitiseError('y'.repeat(900)).length, 300);
});

test('secrets signature includes ctime (a metadata-only change re-reads)', async () => {
  const { getSecret, _resetSecretsCache, secretsHealth } = await import('../lib/secrets.mjs');
  const { execFileSync } = await import('node:child_process');
  _resetSecretsCache();
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-sec2-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ A: 'v1' }));
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore' });
  try {
    assert.equal(getSecret('A', file), 'v1');
    const first = secretsHealth(file).cachedAt;
    await new Promise((r) => setTimeout(r, 20));
    // an ACL change moves ctime but not mtime or size
    execFileSync('icacls', [file, '/grant', 'Everyone:R'], { stdio: 'ignore' });
    getSecret('A', file);
    assert.notEqual(secretsHealth(file).cachedAt, first);
    assert.equal(secretsHealth(file).file, 'unprotected');
  } finally { rmSync(dir, { recursive: true, force: true }); void utimesSync; }
});
