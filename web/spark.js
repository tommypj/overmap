// Sparklines as plain SVG. scale() is pure (tested in Node); sparkline() builds DOM with createElementNS only.
const PAD = 3;
const NS = 'http://www.w3.org/2000/svg';
const f = (n) => String(Math.round(n * 100) / 100);

function pointsXY(points, width, height) {
  const t = (p) => { const v = Date.parse(p.day); return Number.isNaN(v) ? null : v; };
  const times = points.map(t).filter((v) => v != null);
  const vals = points.map((p) => p.value).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const v0 = Math.min(...vals), v1 = Math.max(...vals);
  const w = width - PAD * 2, hh = height - PAD * 2;
  return points.map((p, i) => {
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) return null;
    const tt = t(p);
    const x = t1 === t0 || tt == null ? (points.length === 1 ? width / 2 : PAD + (w * i) / Math.max(1, points.length - 1)) : PAD + (w * (tt - t0)) / (t1 - t0);
    const y = v1 === v0 ? height / 2 : PAD + hh - (hh * (p.value - v0)) / (v1 - v0);
    return [x, y];
  });
}

// True when the previous drawn point is more than one UTC day before point i (series only has rows for days with data).
function gap(ms, i) {
  let j = i - 1;
  while (j >= 0 && Number.isNaN(ms[j])) j--;
  return j >= 0 && !Number.isNaN(ms[i]) && ms[i] - ms[j] > 86_400_000;
}

// points: [{ day, value }] sorted by day -> the `d` attribute. null values break the line.
export function scale(points, width, height) {
  if (!Array.isArray(points) || !points.length) return '';
  const xy = pointsXY(points, width, height);
  if (xy.every((p) => p == null)) return '';
  const ms = points.map((p) => Date.parse(p.day));
  let d = '', pen = false;
  for (let i = 0; i < xy.length; i++) {
    const p = xy[i];
    if (!p) { pen = false; continue; }
    if (pen && gap(ms, i)) pen = false;
    d += `${d ? ' ' : ''}${pen ? 'L' : 'M'} ${f(p[0])} ${f(p[1])}`;
    pen = true;
  }
  return d;
}

export function sparkline(points, { width = 160, height = 36 } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const d = scale(points, width, height);
  const real = (points || []).filter((p) => typeof p.value === 'number');
  svg.setAttribute('aria-label', real.length ? `${real.length} days, latest ${real[real.length - 1].value}` : 'no data');
  if (!d) return svg;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'sparkpath');
  path.setAttribute('fill', 'none');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  // Isolated points (single day, or between two nulls) have no segment: draw them as dots.
  const xy = pointsXY(points, width, height);
  const ms = points.map((p) => Date.parse(p.day));
  xy.forEach((p, i) => {
    if (!p || (xy[i - 1] && !gap(ms, i)) || (xy[i + 1] && !gap(ms, i + 1))) return;
    const c = document.createElementNS(NS, 'path'); // zero-length round-capped segment: a true circle even with a stretched viewBox
    c.setAttribute('d', `M ${f(p[0])} ${f(p[1])} l 0 0`);
    c.setAttribute('class', 'sparkdot');
    c.setAttribute('fill', 'none');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(c);
  });
  return svg;
}
