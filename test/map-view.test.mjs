import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewBoxFor, zoomTransform, positionsKey } from '../web/map/view.js';

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
