import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../serve.mjs';

const NOMINAL = 45874;
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: 'x@example.com', port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem' };

test('GET /api/connectors/config returns the registry connector config, secrets-free', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-cc-'));
  writeFileSync(join(dir, 'projects.json'), '{"projects":[]}');
  writeFileSync(join(dir, 'reg.json'), JSON.stringify({ projects: { Demo: { home: '/demo-x', connectors: {
    gsc: { siteUrl: 'sc-domain:demo.test' }, 'custom': { baseUrl: 'https://x.test', apiToken: 'SECRET', nested: { password: 'p', ok: 1, deep: { secretKey: 'z', name: 'n' } }, leak: 'https://u:pw@example.com/x', leak2: 'https://h.test/p?token=abc12345', list: ['https://a:b@example.com', 'fine'] },
    ga4: { propertyId: '123' }, lemonsqueezy: { storeId: 42 }, extra: { companyId: 'c-1', companyPrefix: 'AST' }, bad: null } } } }));
  const env = { DASH_PORT: String(NOMINAL), DASH_NO_SCHEDULE: '1', DASH_DB: join(dir, 'c.db'), DASH_REGISTRY: join(dir, 'reg.json'), DASH_DATA: join(dir, 'projects.json') };
  const server = createApp(config, env);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${NOMINAL}` } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    }).on('error', reject);
  });
  try {
    const ok = await get('/api/connectors/config?id=Demo');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      gsc: { siteUrl: 'sc-domain:demo.test' },
      'custom': { baseUrl: 'https://x.test', nested: { ok: 1, deep: { name: 'n' } }, list: ['fine'] },
      ga4: { propertyId: '123' }, lemonsqueezy: { storeId: 42 }, extra: { companyId: 'c-1', companyPrefix: 'AST' },
    });
    assert.deepEqual((await get('/api/connectors/config?id=Nope')).body, {});
    assert.equal((await get('/api/connectors/config')).status, 400);
  } finally { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); }
});

test('linksFor builds honest links only and rejects non-http bases', async () => {
  const { linksFor } = await import('../web/pages/live.js');
  const labels = (cfg) => linksFor(cfg).map((l) => `${l.label}=${l.href}`);
  assert.deepEqual(labels({ sentry: { org: 'o', project: 'p' } }), ['Sentry=https://sentry.io/organizations/o/issues/']);
  assert.deepEqual(labels({ vercel: { project: 'p', teamSlug: 't' } }), ['Vercel=https://vercel.com/t/p']);
  assert.deepEqual(labels({ vercel: { project: 'p' } }), []);
});
