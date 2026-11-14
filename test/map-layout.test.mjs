import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, forceLayout } from '../web/map/layout.js';

const nodes = [
  { id: 'a', size: 1 }, { id: 'b', size: 2 }, { id: 'c', size: 1 },
  { id: 'd', size: 1 }, { id: 'e', size: 3 }, { id: 'f', size: 1 },
];
const edges = [
  { a: 'a', b: 'b', kind: 'uses', weight: 1 },
  { a: 'c', b: 'd', kind: 'connects', weight: 2 },
  { a: 'e', b: 'f', kind: 'repo', weight: 1 },
];

test('mulberry32 is deterministic and yields values in [0, 1)', () => {
  const r1 = mulberry32(42);
  const r2 = mulberry32(42);
  const xs = Array.from({ length: 50 }, () => r1());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => r2()));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  const other = mulberry32(43);
  assert.notDeepEqual(xs, Array.from({ length: 50 }, () => other()));
});

test('deterministic and inside the box', () => {
  const a = forceLayout(nodes, edges, { width: 800, height: 600, seed: 7 });
  const b = forceLayout(nodes, edges, { width: 800, height: 600, seed: 7 });
  assert.deepEqual([...a], [...b]);
  assert.equal(a.size, nodes.length);
  for (const { x, y } of a.values()) {
    assert.ok(x >= 0 && x <= 800 && y >= 0 && y <= 600);
  }
});

test('connected nodes end closer than unconnected ones on average', () => {
  const pos = forceLayout(nodes, edges, { width: 800, height: 600, seed: 3 });
  const dist = (p, q) => Math.hypot(pos.get(p).x - pos.get(q).x, pos.get(p).y - pos.get(q).y);
  const connected = edges.map((e) => dist(e.a, e.b));
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const linked = new Set(edges.flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]));
  const free = [];
  for (const p of nodes) for (const q of nodes) {
    if (p.id < q.id && !linked.has(`${p.id}|${q.id}`)) free.push(dist(p.id, q.id));
  }
  assert.ok(avg(connected) < avg(free), `connected ${avg(connected)} vs free ${avg(free)}`);
});

test('pinned nodes do not move', () => {
  const pinned = new Map([['a', { x: 100, y: 120 }]]);
  const pos = forceLayout(nodes, edges, { width: 800, height: 600, seed: 5, pinned });
  assert.deepEqual(pos.get('a'), { x: 100, y: 120 });
});

test('empty input gives an empty layout', () => {
  assert.equal(forceLayout([], [], { width: 100, height: 100 }).size, 0);
});
