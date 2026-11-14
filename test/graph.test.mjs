import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph, summarise, communityDetail } from '../lib/graph.mjs';
import { graphFact } from '../scan/graph.mjs';
import { createApp } from '../serve.mjs';

const fx = (name) => join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name);

test('readGraph accepts edges or links and defaults missing communities', () => {
  const a = readGraph(fx('graph-small.json'), { maxBytes: 1e6 });
  assert.equal(a.nodes.length, 40);
  assert.equal(a.edges.length, 60);
  const b = readGraph(fx('graph-links.json'), { maxBytes: 1e6 });
  assert.ok(b.edges.length > 0);
  const un = b.nodes.filter((n) => n.community === 'unassigned');
  assert.ok(un.length >= 3);
  assert.ok(un.every((n) => n.communityName === 'unassigned'));
  assert.deepEqual(un.find((n) => n.id === 'a6'), { id: 'a6', label: 'README', community: 'unassigned', communityName: 'unassigned', file: 'docs/README.md' });
  assert.equal(b.nodes.find((n) => n.id === 'a7').file, null);
});

test('readGraph refuses a file over the cap', () => {
  assert.throws(() => readGraph(fx('graph-small.json'), { maxBytes: 10 }), /larger than 10 bytes/);
});

test('summarise: counts, named communities by size, gods by degree, community edges a<b', () => {
  const s = summarise(readGraph(fx('graph-small.json'), { maxBytes: 1e6 }));
  assert.equal(s.nodeCount, 40);
  assert.equal(s.edgeCount, 60);
  assert.deepEqual(s.communities.map((c) => c.name), ['billing', 'auth', 'mailer', 'reports']);
  assert.deepEqual(s.communities.map((c) => c.size), [16, 12, 8, 4]);
  assert.ok(s.communities.every((c) => c.top.length <= 5 && c.top.length > 0));
  assert.equal(s.communities[0].top[0].degree >= s.communities[0].top[4].degree, true);
  assert.equal(s.gods.length, 10);
  assert.ok(s.gods[0].degree >= s.gods[1].degree);
  assert.ok(s.gods.every((g) => typeof g.community === 'string'));
  assert.ok(s.communityEdges.length > 0);
  for (const e of s.communityEdges) { assert.ok(e.a < e.b, `${e.a} < ${e.b}`); assert.ok(e.weight >= 1); }
  const lk = summarise(readGraph(fx('graph-links.json'), { maxBytes: 1e6 }));
  assert.ok(lk.communities.some((c) => c.id === 'unassigned' && c.name === 'unassigned'));
});

test('communityDetail cuts at maxNodes and keeps only internal edges', () => {
  const g = readGraph(fx('graph-small.json'), { maxBytes: 1e6 });
  const cut = communityDetail(g, '0', { maxNodes: 3 });
  assert.equal(cut.community.id, '0');
  assert.equal(cut.community.name, 'billing');
  assert.equal(cut.truncated, true);
  assert.equal(cut.nodes.length, 3);
  const ids = new Set(cut.nodes.map((n) => n.id));
  assert.ok(cut.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
  const full = communityDetail(g, '0');
  assert.equal(full.truncated, false);
  assert.equal(full.nodes.length, 16);
  assert.ok(full.nodes.every((n, i, arr) => i === 0 || arr[i - 1].degree >= n.degree));
});

test('graphFact: null when absent, error when unreadable or over cap, value when present', () => {
  const home = mkdtempSync(join(tmpdir(), 'graph-fact-'));
  const at = '2026-11-14T10:00:00.000Z';
  const now = () => Date.parse(at);
  const none = graphFact(home, { maxBytes: 1e6, now });
  assert.deepEqual(none, { at, value: null });
  mkdirSync(join(home, 'graphify-out'));
  copyFileSync(fx('graph-small.json'), join(home, 'graphify-out', 'graph.json'));
  const ok = graphFact(home, { maxBytes: 1e6, now });
  assert.equal(ok.value.nodeCount, 40);
  assert.equal(ok.error, undefined);
  const big = graphFact(home, { maxBytes: 10, now });
  assert.equal(big.value, null);
  assert.match(big.error, /larger than 10 bytes/);
  writeFileSync(join(home, 'graphify-out', 'graph.json'), '{not json');
  const bad = graphFact(home, { maxBytes: 1e6, now });
  assert.equal(bad.value, null);
  assert.match(bad.error, /graph\.json/);
  assert.match(bad.error, /graph\.json is not valid JSON$/);
  assert.ok(!/position|token|Unexpected/i.test(bad.error), bad.error);
  assert.match(big.error, /raise graphMaxBytes/);
  rmSync(home, { recursive: true, force: true });
});

// ---- GET /api/graph (real HTTP, follows test/serve.test.mjs) ----
const NOMINAL = 45872;
const LOGIN = 'me@example.com';
const config = { vaultProjectsDir: '/p', mocFile: '/m.md', allowedLogin: LOGIN, port: NOMINAL, architectureFile: '/a.md', memoryRoot: '/mem', proxyHost: 'host.tail0000.ts.net' }; // privacy-ok

const base = mkdtempSync(join(tmpdir(), 'graph-api-'));
const gHome = join(base, 'g');
const nHome = join(base, 'n');
mkdirSync(join(gHome, 'graphify-out'), { recursive: true });
mkdirSync(nHome);
copyFileSync(fx('graph-small.json'), join(gHome, 'graphify-out', 'graph.json'));
mkdirSync(join(base, 'data'));
writeFileSync(join(base, 'data', 'projects.json'), JSON.stringify({ generatedAt: '2026-11-14T10:00:00Z', scanSeconds: 1, projects: [{ id: 'G', name: 'G', home: gHome, roots: [gHome] }, { id: 'N', name: 'N', home: nHome, roots: [nHome] }], unmapped: [] }));

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

function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${NOMINAL}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('GET /api/graph returns one community detail', async () => {
  const r = await get('/api/graph?id=G&community=0');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['community', 'edges', 'nodes', 'truncated']);
  assert.deepEqual(r.body.community, { id: '0', name: 'billing' });
  assert.equal(r.body.nodes.length, 16);
  assert.equal(r.body.truncated, false);
  assert.ok(r.body.nodes.every((n) => 'id' in n && 'label' in n && 'degree' in n && 'file' in n));
  assert.ok(r.body.edges.every((e) => 'source' in e && 'target' in e && 'relation' in e));
});

test('GET /api/graph: 400 without community, 404 for a project without a graph', async () => {
  assert.equal((await get('/api/graph?id=G')).status, 400);
  assert.equal((await get('/api/graph?id=N&community=0')).status, 404);
});
