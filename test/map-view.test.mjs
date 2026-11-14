import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { viewBoxFor, zoomTransform, positionsKey, topCommunities, communityRadius, layoutBox, REST_ID } from '../web/map/view.js';

test('topCommunities keeps the largest N and folds the rest into one node with summed edges', () => {
  const comms = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, size: 10 - i }));
  const edges = [
    { a: 'c0', b: 'c1', weight: 2 },
    { a: 'c0', b: 'c4', weight: 1 },
    { a: 'c5', b: 'c0', weight: 3 },
    { a: 'c4', b: 'c5', weight: 7 }, // both folded: dropped
    { a: 'c1', b: 'c3', weight: 1 },
    { a: 'c1', b: 'zz', weight: 9 }, // unknown community: dropped
  ];
  const t = topCommunities(comms, edges, 3);
  assert.deepEqual(t.shown.map((c) => c.id), ['c0', 'c1', 'c2']);
  assert.deepEqual(t.rest, { id: REST_ID, name: '3 smaller communities', size: 7 + 6 + 5, count: 3 });
  const key = (e) => [e.a, e.b].sort().join('|');
  assert.deepEqual(Object.fromEntries(t.edges.map((e) => [key(e), e.weight])), {
    'c0|c1': 2,
    [[REST_ID, 'c0'].sort().join('|')]: 4,
    [[REST_ID, 'c1'].sort().join('|')]: 1,
  });
});

test('topCommunities ranks by size, ties in input order, and has no rest node when all fit', () => {
  const comms = [{ id: 'a', size: 1 }, { id: 'b', size: 5 }, { id: 'c', size: 5 }];
  const t = topCommunities(comms, [{ a: 'a', b: 'b' }], 40);
  assert.deepEqual(t.shown.map((c) => c.id), ['b', 'c', 'a']);
  assert.equal(t.rest, null);
  assert.deepEqual(t.edges, [{ a: 'a', b: 'b', weight: 1 }]);
  assert.equal(topCommunities(comms, [], Infinity).shown.length, 3);
});

test('communityRadius scales against the largest community and is capped at 60 px', () => {
  assert.equal(communityRadius(100, 100), 60);
  assert.equal(communityRadius(1e6, 100), 60);
  assert.ok(communityRadius(1, 1000) < 15);
  assert.ok(communityRadius(25, 100) > communityRadius(4, 100));
});

test('layoutBox keeps 960x560 for a few circles and grows with their area', () => {
  assert.deepEqual(layoutBox([20, 20, 20]), { width: 960, height: 560 });
  const big = layoutBox(Array(41).fill(60));
  assert.ok(big.width > 960 && Math.abs(big.width / big.height - 960 / 560) < 1e-9);
  assert.ok(41 * Math.PI * 3600 <= 0.2 * big.width * big.height + 1e-6);
});

test('project status colour is declared on the g, not on the circle', () => {
  const css = fs.readFileSync(new URL('../web/app.css', import.meta.url), 'utf8');
  const circleRule = css.match(/\.map-project > circle \{([^}]*)\}/)[1];
  assert.ok(!circleRule.includes('--sc:'), circleRule);
  const def = css.indexOf('.map-project { --sc:');
  assert.ok(def >= 0 && def < css.indexOf('.map-status-active') && def < css.indexOf('.map-status-paused'));
});

test('viewBoxFor pads to the extreme nodes using their radii', () => {
  const positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 100, y: 50 }]]);
  const radii = new Map([['a', 10], ['b', 5]]);
  assert.deepEqual(viewBoxFor(positions, radii, 24), { x: -34, y: -34, w: 163, h: 113 });
});

test('viewBoxFor defaults to a 24 px pad and never returns NaN for an empty map', () => {
  const box = viewBoxFor(new Map([['a', { x: 5, y: 5 }]]), new Map([['a', 0]]));
  assert.deepEqual(box, { x: -19, y: -19, w: 48, h: 48 });
  const empty = viewBoxFor(new Map(), new Map());
  for (const v of Object.values(empty)) assert.ok(Number.isFinite(v));
});

test('zoomTransform scales about a point', () => {
  assert.equal(zoomTransform(2, 10, 20), 'translate(10 20) scale(2) translate(-10 -20)');
  assert.equal(zoomTransform(1, 0, 0), 'translate(0 0) scale(1) translate(0 0)');
});

test('positionsKey is stable for the same id list and ignores order and status', () => {
  const a = { projects: [{ id: 'p1', status: 'active' }, { id: 'p2', status: 'active' }], services: [{ id: 'neon' }] };
  const b = { projects: [{ id: 'p2', status: 'paused' }, { id: 'p1', status: 'paused' }], services: [{ id: 'neon' }] };
  assert.equal(positionsKey(a), positionsKey(b));
  assert.match(positionsKey(a), /^[0-9a-f]+$/);
});

test('positionsKey differs when the id list differs', () => {
  const a = { projects: [{ id: 'p1' }], services: [] };
  const b = { projects: [{ id: 'p1' }, { id: 'p2' }], services: [] };
  const c = { projects: [{ id: 'p1' }], services: [{ id: 'neon' }] };
  assert.notEqual(positionsKey(a), positionsKey(b));
  assert.notEqual(positionsKey(a), positionsKey(c));
});
