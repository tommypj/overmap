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

test('connected nodes end closer than unconnected ones, across seeds', () => {
  const linked = new Set(edges.flatMap((e) => [`${e.a}|${e.b}`, `${e.b}|${e.a}`]));
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  let wins = 0;
  let gapSum = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const pos = forceLayout(nodes, edges, { width: 800, height: 600, seed });
    const dist = (p, q) => Math.hypot(pos.get(p).x - pos.get(q).x, pos.get(p).y - pos.get(q).y);
    const connected = edges.map((e) => dist(e.a, e.b));
    const free = [];
    for (const p of nodes) for (const q of nodes) {
      if (p.id < q.id && !linked.has(`${p.id}|${q.id}`)) free.push(dist(p.id, q.id));
    }
    const gap = avg(free) - avg(connected);
    gapSum += gap;
    if (gap > 0) wins++;
  }
  assert.ok(wins >= 27, `connected closer in only ${wins}/30 seeds`);
  assert.ok(gapSum / 30 > 0, `mean gap ${gapSum / 30} not positive`);
});

test('pinned nodes do not move', () => {
  const pinned = new Map([['a', { x: 100, y: 120 }]]);
  const pos = forceLayout(nodes, edges, { width: 800, height: 600, seed: 5, pinned });
  assert.deepEqual(pos.get('a'), { x: 100, y: 120 });
});

// A random graph: n nodes of mixed size, about 1.2n random edges.
function randomGraph(n, seed) {
  const rng = mulberry32(seed);
  const ns = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, size: 1 + Math.floor(rng() * 20) }));
  const es = [];
  for (let i = 0; i < n * 1.2; i++) {
    const a = Math.floor(rng() * n);
    const b = Math.floor(rng() * n);
    if (a !== b) es.push({ a: `n${a}`, b: `n${b}`, weight: 1 + Math.floor(rng() * 4) });
  }
  return { ns, es };
}

test('zoomed-out layouts stay off the box edge and never overlap (n=16, n=40)', () => {
  const W = 960;
  const H = 560;
  const radius = (n) => 12 + 4 * Math.sqrt(n.size ?? 1);
  for (const n of [16, 40]) {
    for (const seed of [1, 2, 3]) {
      const { ns, es } = randomGraph(n, seed * 100 + n);
      const pos = forceLayout(ns, es, { width: W, height: H, seed: 1, radius });
      const onEdge = ns.filter((nd) => {
        const { x, y } = pos.get(nd.id);
        const r = radius(nd);
        return x - r < 1 || W - r - x < 1 || y - r < 1 || H - r - y < 1;
      }).length;
      assert.ok(onEdge <= n * 0.1, `n=${n} seed=${seed}: ${onEdge}/${n} on the box edge`);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = pos.get(ns[i].id);
          const b = pos.get(ns[j].id);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          assert.ok(d >= radius(ns[i]) + radius(ns[j]), `n=${n} seed=${seed}: ${ns[i].id} overlaps ${ns[j].id}`);
        }
      }
    }
  }
});

test('empty input gives an empty layout', () => {
  assert.equal(forceLayout([], [], { width: 100, height: 100 }).size, 0);
});
