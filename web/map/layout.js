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

const GRAVITY = 0.02;
const SPRING = 0.1;

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
  const pos = nodes.map((node, i) => {
    const pin = pinned.get(node.id);
    const mx = Math.min(r[i], width / 2);
    const my = Math.min(r[i], height / 2);
    const x = pin ? pin.x : mx + rng() * (width - 2 * mx);
    const y = pin ? pin.y : my + rng() * (height - 2 * my);
    return { x: clamp(x, mx, width - mx), y: clamp(y, my, height - my) };
  });
  const isPinned = nodes.map((node) => pinned.has(node.id));
  const links = edges
    .map((e) => ({ i: index.get(e.a), j: index.get(e.b), w: Math.sqrt(e.weight ?? 1) }))
    .filter((l) => l.i !== undefined && l.j !== undefined && l.i !== l.j);
  const rest = links.map((l) => 60 + r[l.i] + r[l.j]);
  const k = Math.sqrt((width * height) / Math.max(n, 1));
  const cx = width / 2;
  const cy = height / 2;
  const t0 = width / 10;

  for (let step = 0; step < iterations; step++) {
    const temp = t0 * (1 - step / iterations);
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = pos[i].x - pos[j].x;
        const ey = pos[i].y - pos[j].y;
        const d = Math.max(Math.hypot(ex, ey), 0.01);
        const f = (k * k) / d;
        dx[i] += (ex / d) * f;
        dy[i] += (ey / d) * f;
        dx[j] -= (ex / d) * f;
        dy[j] -= (ey / d) * f;
      }
    }
    links.forEach((l, li) => {
      const ex = pos[l.i].x - pos[l.j].x;
      const ey = pos[l.i].y - pos[l.j].y;
      const d = Math.max(Math.hypot(ex, ey), 0.01);
      const f = (d - rest[li]) * SPRING * l.w;
      dx[l.i] -= (ex / d) * f;
      dy[l.i] -= (ey / d) * f;
      dx[l.j] += (ex / d) * f;
      dy[l.j] += (ey / d) * f;
    });
    for (let i = 0; i < n; i++) {
      if (isPinned[i]) continue;
      dx[i] += (cx - pos[i].x) * GRAVITY;
      dy[i] += (cy - pos[i].y) * GRAVITY;
      const m = Math.hypot(dx[i], dy[i]);
      if (m > 0) {
        const s = Math.min(m, temp) / m;
        pos[i].x += dx[i] * s;
        pos[i].y += dy[i] * s;
      }
      pos[i].x = clamp(pos[i].x, Math.min(r[i], width / 2), width - Math.min(r[i], width / 2));
      pos[i].y = clamp(pos[i].y, Math.min(r[i], height / 2), height - Math.min(r[i], height / 2));
    }
  }

  return new Map(nodes.map((node, i) => [node.id, { x: pos[i].x, y: pos[i].y }]));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
