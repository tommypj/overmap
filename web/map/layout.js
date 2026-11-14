// Pure deterministic force layout. Browser-safe: no DOM, no Node imports.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fruchterman-Reingold: k = C * sqrt(area / n). Springs (SPRING) are tuned
// against k so connected pairs settle near their rest length, not the box.
// Repulsion stops beyond 2k, so distant clusters do not push each other into the
// walls; a soft wall (WALL px deep) pushes inward before the hard clamp, and a final
// separation pass keeps circles GAP px apart.
const C = 0.45;
const GRAVITY = 0.05;
const SPRING = 2;
const WALL = 40;
const GAP = 4;

export function forceLayout(nodes, edges, {
  width,
  height,
  seed = 1,
  iterations = 300,
  pinned = new Map(),
  radius = (n) => 12 + 4 * Math.sqrt(n.size ?? 1),
} = {}) {
  const rng = mulberry32(seed);
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const r = nodes.map((node) => radius(node));
  const half = (i) => ({ mx: Math.min(r[i], width / 2), my: Math.min(r[i], height / 2) });
  const pos = nodes.map((node, i) => {
    const pin = pinned.get(node.id);
    const { mx, my } = half(i);
    const x = pin ? pin.x : mx + rng() * (width - 2 * mx);
    const y = pin ? pin.y : my + rng() * (height - 2 * my);
    return { x: clamp(x, mx, width - mx), y: clamp(y, my, height - my) };
  });
  const isPinned = nodes.map((node) => pinned.has(node.id));
  const links = edges
    .map((e) => ({ i: index.get(e.a), j: index.get(e.b), w: Math.sqrt(e.weight ?? 1) }))
    .filter((l) => l.i !== undefined && l.j !== undefined && l.i !== l.j);
  const rest = links.map((l) => 60 + r[l.i] + r[l.j]);
  const k = C * Math.sqrt((width * height) / Math.max(n, 1));
  const k2 = k * k;
  const cx = width / 2;
  const cy = height / 2;
  const t0 = width / 10;

  // Unit direction from j to i; coincident nodes get a seeded random direction.
  const direction = (ex, ey) => {
    const d = Math.hypot(ex, ey);
    if (d >= 1e-6) return { ux: ex / d, uy: ey / d, d };
    const a = rng() * 2 * Math.PI;
    return { ux: Math.cos(a), uy: Math.sin(a), d: 1e-6 };
  };

  for (let step = 0; step < iterations; step++) {
    const temp = t0 * (1 - step / iterations);
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { ux, uy, d } = direction(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
        const f = d < 2 * k ? k2 / d : 0;
        dx[i] += ux * f;
        dy[i] += uy * f;
        dx[j] -= ux * f;
        dy[j] -= uy * f;
      }
    }
    links.forEach((l, li) => {
      const { ux, uy, d } = direction(pos[l.i].x - pos[l.j].x, pos[l.i].y - pos[l.j].y);
      const f = (d - rest[li]) * SPRING * l.w;
      dx[l.i] -= ux * f;
      dy[l.i] -= uy * f;
      dx[l.j] += ux * f;
      dy[l.j] += uy * f;
    });
    for (let i = 0; i < n; i++) {
      if (isPinned[i]) continue;
      dx[i] += (cx - pos[i].x) * GRAVITY;
      dy[i] += (cy - pos[i].y) * GRAVITY;
      const { mx, my } = half(i);
      dx[i] += Math.max(0, WALL - (pos[i].x - mx)) - Math.max(0, WALL - (width - mx - pos[i].x));
      dy[i] += Math.max(0, WALL - (pos[i].y - my)) - Math.max(0, WALL - (height - my - pos[i].y));
      const m = Math.hypot(dx[i], dy[i]);
      if (m > 0) {
        const s = Math.min(m, temp) / m;
        pos[i].x += dx[i] * s;
        pos[i].y += dy[i] * s;
      }
      pos[i].x = clamp(pos[i].x, mx, width - mx);
      pos[i].y = clamp(pos[i].y, my, height - my);
    }
  }

  // Separation: push overlapping circles apart (a pinned node never moves).
  for (let sweep = 0; sweep < 100; sweep++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (isPinned[i] && isPinned[j]) continue;
        const { ux, uy, d } = direction(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
        const overlap = r[i] + r[j] + GAP - d;
        if (overlap <= 0) continue;
        const si = isPinned[j] ? 1 : isPinned[i] ? 0 : 0.5;
        pos[i].x += ux * overlap * si;
        pos[i].y += uy * overlap * si;
        pos[j].x -= ux * overlap * (1 - si);
        pos[j].y -= uy * overlap * (1 - si);
        for (const q of [i, j]) {
          if (isPinned[q]) continue;
          const { mx, my } = half(q);
          pos[q].x = clamp(pos[q].x, mx, width - mx);
          pos[q].y = clamp(pos[q].y, my, height - my);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  return new Map(nodes.map((node, i) => [node.id, { x: pos[i].x, y: pos[i].y }]));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
