// The map. Zoomed out (renderMap): groups, services and projects on one SVG; a cluster expands in place.
// Zoomed in (renderProjectGraph): one project's Graphify communities. Layout runs once per model change
// (expand, collapse, pin, unpin, new scan). Pan, zoom and node drags only change transforms.
// No document access at module top level: DOM is touched only inside the render functions.
import { h, clear, api, enc } from '../ui.js';
import { mapModel } from './model.js';
import { forceLayout } from './layout.js';
import { projectPanel, servicePanel, summaryPanel, communityPanel, askPanel, graphMissing } from './panel.js';

const W = 960;
const H = 560;
const PAD = 24;
const NS = 'http://www.w3.org/2000/svg';
const expanded = new Set();
let selected = null; // the cluster (group name) the Overview table filters to; null = all
export const selectedGroup = () => selected;

// ---- pure helpers (browser-safe) ----
const num = (v) => Number(v.toFixed(3));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const radiusOf = (n) => 12 + 4 * Math.sqrt(n.size ?? 1);
const vb = (b) => [b.x, b.y, b.w, b.h].map(num).join(' ');

// Bounding box of the nodes, each padded by its radius and by `pad`.
export function viewBoxFor(positions, radii, pad = PAD) {
  if (!positions.size) return { x: -pad, y: -pad, w: 2 * pad, h: 2 * pad };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [id, { x, y }] of positions) {
    const r = radii.get(id) ?? 0;
    x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

// Scale about the point (cx, cy), in the svg's user units.
export function zoomTransform(scale, cx, cy) {
  return `translate(${num(cx)} ${num(cy)}) scale(${num(scale)}) translate(${num(-cx)} ${num(-cy)})`;
}

// Hash of the node id list (projects and services). Stable under reordering and status changes.
export function positionsKey(data) {
  const ids = [
    ...(data.projects || []).map((p) => p.id),
    ...(data.services || []).map((s) => `service:${s.id}`),
  ].sort();
  let hash = 0x811c9dc5;
  for (const ch of ids.join('\n')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// The zoomed-in graph draws the `limit` largest communities and folds the rest into one
// "N smaller communities" node (id REST_ID) that carries their edges, weights summed.
export const REST_ID = '__smaller__';
export const TOP_COMMUNITIES = 40;
export const TOP_LABELS = 15;
export function topCommunities(communities, communityEdges, limit = TOP_COMMUNITIES) {
  const all = (communities || []).map((c, i) => ({ c, i }));
  const ranked = [...all].sort((a, b) => (b.c.size ?? 1) - (a.c.size ?? 1) || a.i - b.i).map((x) => x.c);
  const shown = ranked.slice(0, limit);
  const hidden = ranked.slice(limit);
  const keep = new Set(shown.map((c) => c.id));
  const known = new Set(ranked.map((c) => c.id));
  const rest = hidden.length
    ? { id: REST_ID, name: `${hidden.length} smaller communities`, size: hidden.reduce((s, c) => s + (c.size ?? 1), 0), count: hidden.length }
    : null;
  const merged = new Map();
  for (const e of communityEdges || []) {
    if (!known.has(e.a) || !known.has(e.b)) continue;
    const a = keep.has(e.a) ? e.a : REST_ID;
    const b = keep.has(e.b) ? e.b : REST_ID;
    if (a === b) continue;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}\n${y}`;
    const prev = merged.get(key);
    if (prev) prev.weight += e.weight ?? 1;
    else merged.set(key, { a: x, b: y, weight: e.weight ?? 1 });
  }
  return { shown, rest, edges: [...merged.values()] };
}

// Community circle radius relative to the largest community, capped at 60 px.
export const communityRadius = (size, maxSize) =>
  Math.min(60, 10 + 50 * Math.sqrt(Math.max(size ?? 1, 0) / Math.max(maxSize || 1, 1)));

// The layout box grows past W x H once the circles would cover more than a fifth of it
// (the viewBox fits the result, so a bigger box only means more room, not smaller text).
export function layoutBox(radii, fill = 0.2) {
  const area = radii.reduce((sum, r) => sum + Math.PI * r * r, 0);
  const s = Math.max(1, Math.sqrt(area / (fill * W * H)));
  return { width: W * s, height: H * s };
}

// ---- DOM helpers ----
function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null && k !== false) el.append(typeof k === 'object' ? k : document.createTextNode(String(k)));
  return el;
}

const pinKey = (data) => `overmap.map.${positionsKey(data)}`;
// Storage access can throw (blocked site data, sandboxed frames): every read and write is guarded.
function safeStorage(s) {
  try { return s ?? localStorage; } catch { return null; }
}
function readPins(storage, key) {
  if (!storage) return new Map();
  try {
    const o = JSON.parse(storage.getItem(key) || '{}');
    return new Map(Object.entries(o).filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y)));
  } catch { return new Map(); }
}
function writePins(storage, key, pins) {
  if (!storage) return;
  try { storage.setItem(key, JSON.stringify(Object.fromEntries(pins))); } catch { /* blocked storage: pins last for this page */ }
}

const STATUS = { active: 'active', paused: 'paused' };
function nodeClass(n) {
  if (n.kind !== 'project') return `map-node map-${n.kind}`;
  return `map-node map-project map-status-${STATUS[n.status] ?? 'other'} ${n.graph ? 'map-has-graph' : 'map-no-graph'}`;
}
function nodeAria(n) {
  if (n.kind === 'group') return `${n.label}, ${n.size} projects, collapsed`;
  if (n.kind === 'service') return `${n.label} service, used by ${n.size}`;
  return `${n.label}, ${n.status ?? 'status unknown'}`;
}

// Enter/Space activates; arrows move focus through the nodes in DOM order.
function keyStep(e, els, g) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return false;
  e.preventDefault();
  const i = els.findIndex((x) => x.g === g);
  els[(i + step + els.length) % els.length]?.g.focus();
  return true;
}

// The svg with pan (drag background), zoom (wheel, pinch) and the shared transforms. Returns redraw helpers.
// onZoom(k) runs after every transform change.
function canvas(getBox, onBackground, onZoom) {
  const svg = svgEl('svg', { class: 'map-svg', role: 'img', 'aria-label': 'Map' });
  const edgeG = svgEl('g', { class: 'map-edges' });
  const nodeG = svgEl('g', { class: 'map-nodes' });
  const zoomG = svgEl('g', { class: 'map-zoom' }, edgeG, nodeG);
  const panG = svgEl('g', { class: 'map-pan' }, zoomG);
  svg.append(panG);
  const view = { k: 1, px: 0, py: 0 };
  const centre = () => { const b = getBox(); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const apply = () => {
    const c = centre();
    zoomG.setAttribute('transform', zoomTransform(view.k, c.x, c.y));
    panG.setAttribute('transform', `translate(${num(view.px)} ${num(view.py)})`);
    onZoom?.(view.k);
  };
  const toUser = (e) => {
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  };
  // Keep the user point under q fixed while the scale changes to `want`.
  const zoomAt = (q, want) => {
    const c = centre();
    const k1 = view.k, k2 = clamp(want, 0.3, 8);
    const ux = c.x + (q.x - c.x - view.px) / k1;
    const uy = c.y + (q.y - c.y - view.py) / k1;
    view.px = q.x - c.x - k2 * (ux - c.x);
    view.py = q.y - c.y - k2 * (uy - c.y);
    view.k = k2;
    apply();
  };
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(toUser(e), view.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

  const pts = new Map();
  let drag = null, pinch = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.map-node')) return; // nodes handle their own drags
    const q = toUser(e);
    pts.set(e.pointerId, q);
    svg.setPointerCapture(e.pointerId);
    if (pts.size === 1) drag = { start: q, px: view.px, py: view.py, moved: false };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: dist(a, b), k: view.k };
      drag = null;
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const q = toUser(e);
    pts.set(e.pointerId, q);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pinch.k * dist(a, b) / pinch.d);
      return;
    }
    if (drag) {
      if (!drag.moved && dist(q, drag.start) < 4) return;
      drag.moved = true;
      view.px = drag.px + q.x - drag.start.x;
      view.py = drag.py + q.y - drag.start.y;
      apply();
    }
  });
  const release = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (drag && !drag.moved && e.type === 'pointerup') onBackground?.();
      drag = null;
    }
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);

  const reset = () => { view.k = 1; view.px = 0; view.py = 0; apply(); };
  apply();
  return { svg, edgeG, nodeG, apply, reset, toUser };
}

function placeEdges(edgeEls, positions) {
  for (const { e, line } of edgeEls) {
    const a = positions.get(e.a), b = positions.get(e.b);
    if (!a || !b) continue;
    line.setAttribute('x1', num(a.x)); line.setAttribute('y1', num(a.y));
    line.setAttribute('x2', num(b.x)); line.setAttribute('y2', num(b.y));
  }
}
const moveTo = (p) => `translate(${num(p.x)} ${num(p.y)})`;

// ---- zoomed out ----
// el: container (cleared). ctx: { data }. opts: api (for facts), storage (pins), onSelect(group|null).
export function renderMap(el, ctx, { api: fetchApi = api, storage: given, onSelect = () => {} } = {}) {
  clear(el);
  const data = ctx.data;
  if (!data?.projects?.length) { el.append(h('p', { class: 'muted' }, 'No projects to map yet.')); return; }
  if (selected && !data.projects.some((p) => p.group === selected)) selected = null;
  const key = pinKey(data);
  const storage = safeStorage(given);
  const pins = readPins(storage, key);
  const detail = h('div', { class: 'map-panel', hidden: true, 'aria-live': 'polite' });
  const tools = h('div', { class: 'map-bar' });
  let model = { nodes: [], edges: [] };
  let positions = new Map();
  let box = { x: 0, y: 0, w: W, h: H };
  let nodeEls = [], edgeEls = [];
  let selectedId = null;

  const relayout = () => {
    model = mapModel(data, { expanded });
    positions = forceLayout(model.nodes, model.edges, { width: W, height: H, seed: 1, pinned: pins, radius: radiusOf });
    box = viewBoxFor(positions, new Map(model.nodes.map((n) => [n.id, radiusOf(n)])));
  };

  const markSelected = () => {
    for (const { n, g } of nodeEls) {
      g.classList.toggle('map-selected', n.id === selectedId || (n.kind === 'group' && n.label === selected));
    }
  };
  const clearSelection = () => {
    selectedId = null;
    detail.hidden = true;
    markSelected();
    if (selected !== null) { selected = null; onSelect(null); }
  };
  const showProject = (n) => {
    const p = data.projects.find((x) => x.id === n.id);
    if (!p) return;
    const open = p.group && expanded.has(p.group);
    detail.replaceChildren(projectPanel(p, {
      fetchApi, onClose: clearSelection, onCollapse: open ? () => collapse(p.group) : null,
    }));
    detail.hidden = false;
  };
  const showService = (n) => {
    const sid = n.id.slice('service:'.length);
    const name = (id) => data.projects.find((p) => p.id === id)?.name ?? id;
    const users = (data.edges || []).filter((e) => e.kind === 'uses' && e.b === sid).map((e) => name(e.a));
    detail.replaceChildren(servicePanel(n.label, users, clearSelection));
    detail.hidden = false;
  };
  const activate = (n) => {
    if (suppressClick) return;
    if (n.kind === 'group') {
      expanded.add(n.label);
      selected = n.label;
      onSelect(selected);
      changed(null, n.label); // focus the first member of the expanded cluster
      return;
    }
    selectedId = n.id;
    if (n.kind === 'project') showProject(n);
    else if (n.kind === 'service') showService(n);
    markSelected();
  };
  const collapse = (g) => {
    expanded.delete(g);
    if (selected === g) { selected = null; onSelect(null); }
    changed(`group:${g}`); // the group node is back: keep focus on it
  };
  const unpin = (id) => {
    if (!pins.has(id)) return;
    pins.delete(id);
    writePins(storage, key, pins);
    changed(id);
  };
  let suppressClick = false;
  const dragNode = (e, n, g) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const origin = positions.get(n.id);
    const from = c.toUser(e);
    let moved = false;
    g.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const q = c.toUser(ev);
      if (!moved && Math.hypot(q.x - from.x, q.y - from.y) < 4) return;
      moved = true;
      positions.set(n.id, { x: origin.x + q.x - from.x, y: origin.y + q.y - from.y });
      placeEdges(edgeEls, positions);
      g.setAttribute('transform', moveTo(positions.get(n.id)));
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      if (!moved) return;
      pins.set(n.id, { ...positions.get(n.id) });
      writePins(storage, key, pins);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      changed(n.id);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  };
  const nodeEl = (n) => {
    const r = radiusOf(n);
    const shape = n.kind === 'service'
      ? svgEl('rect', { x: num(-r), y: num(-r), width: num(2 * r), height: num(2 * r), rx: 6 })
      : svgEl('circle', { r: num(r) });
    const kids = [shape];
    if (n.kind === 'group') kids.push(svgEl('text', { class: 'map-count', 'text-anchor': 'middle', y: 4 }, String(n.size)));
    kids.push(svgEl('text', { class: 'map-label', 'text-anchor': 'middle', y: num(r + 14) }, n.label));
    const g = svgEl('g', { class: nodeClass(n), tabindex: 0, role: 'button', 'aria-label': nodeAria(n) }, ...kids);
    g.addEventListener('pointerdown', (e) => dragNode(e, n, g));
    g.addEventListener('click', () => activate(n));
    g.addEventListener('dblclick', () => unpin(n.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(n); return; }
      keyStep(e, nodeEls, g);
    });
    return g;
  };
  const drawContent = (focusId, focusGroup = null) => {
    c.edgeG.replaceChildren();
    c.nodeG.replaceChildren();
    edgeEls = model.edges.map((e) => {
      const line = svgEl('line', { class: `map-edge map-edge-${e.kind}`, 'stroke-width': num(1 + Math.min(e.weight, 6) * 0.5) });
      c.edgeG.append(line);
      return { e, line };
    });
    nodeEls = model.nodes.map((n) => {
      const g = nodeEl(n);
      c.nodeG.append(g);
      return { n, g };
    });
    placeEdges(edgeEls, positions);
    for (const { n, g } of nodeEls) g.setAttribute('transform', moveTo(positions.get(n.id)));
    markSelected();
    const target = nodeEls.find((x) => x.n.id === focusId) ?? nodeEls.find((x) => focusGroup && x.n.group === focusGroup);
    target?.g.focus();
  };
  const toolbar = () => {
    const open = [...expanded].filter((g) => data.projects.some((p) => p.group === g)).sort();
    tools.replaceChildren(
      ...open.map((g) => h('button', { class: 'pill chip on', type: 'button', on: { click: () => collapse(g) } }, `${g} \u00d7`)),
      h('button', { class: 'btn small', type: 'button', on: { click: () => c.reset() } }, 'Reset view'),
    );
  };
  // Model change: relayout once, then redraw. Pan and zoom are kept.
  const changed = (focusId = null, focusGroup = null) => {
    relayout();
    c.svg.setAttribute('viewBox', vb(box));
    if (selectedId && !model.nodes.some((n) => n.id === selectedId)) { selectedId = null; detail.hidden = true; }
    drawContent(focusId, focusGroup);
    toolbar();
    c.apply();
  };

  relayout();
  const c = canvas(() => box, clearSelection);
  c.svg.setAttribute('viewBox', vb(box));
  const wrap = h('div', { class: 'map' },
    h('p', { class: 'age' }, 'Click a cluster to expand it. Scroll to zoom, drag to pan, drag a node to pin it, double-click to unpin.'),
    tools,
    h('div', { class: 'map-body' }, c.svg, detail));
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSelection(); });
  el.append(wrap);
  drawContent(null);
  toolbar();
  onSelect(selected);
}

// ---- zoomed in ----
// The Overview is not drawn here: this replaces the whole main area on #/map/<projectId>.
export async function renderProjectGraph(el, ctx, projectId, { api: fetchApi = api, showAll = false } = {}) {
  clear(el);
  const p = (ctx.data?.projects || []).find((x) => x.id === projectId);
  el.append(h('nav', { class: 'mapcrumb', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/' }, 'Overmap'), ' \u203a ', p ? p.name : projectId));
  if (!p) { el.append(h('p', { class: 'note risk' }, 'unknown (no such project)')); return; }
  const sum = p.graph?.value;
  if (!sum) { el.append(graphMissing(p)); return; }

  const comms = sum.communities || [];
  const top = topCommunities(comms, sum.communityEdges, showAll ? Infinity : TOP_COMMUNITIES);
  const maxSize = Math.max(1, ...top.shown.map((c) => c.size ?? 1));
  const labelled = new Set(top.shown.slice(0, TOP_LABELS).map((c) => c.id));
  const nodes = top.shown.map((c) => ({ id: c.id, kind: 'community', label: c.name, size: c.size ?? 1, graph: true }));
  if (top.rest) nodes.push({ id: REST_ID, kind: 'community', label: top.rest.name, size: top.rest.size, graph: true, rest: true });
  const rOf = (n) => communityRadius(n.rest ? maxSize : n.size, maxSize);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = top.edges.map((e) => ({ a: e.a, b: e.b, kind: 'connects', weight: e.weight }));
  const positions = forceLayout(nodes, edges, { ...layoutBox(nodes.map(rOf)), seed: 1, radius: rOf });
  const box = viewBoxFor(positions, new Map(nodes.map((n) => [n.id, rOf(n)])));
  const toggleAll = () => renderProjectGraph(el, ctx, projectId, { api: fetchApi, showAll: !showAll });
  if (top.rest || showAll) {
    el.querySelector('.mapcrumb').append(' ', h('button', { type: 'button', class: 'btn small map-showall', 'aria-pressed': String(showAll), on: { click: toggleAll } },
      showAll ? `Show top ${TOP_COMMUNITIES}` : `Show all (${comms.length})`));
  }

  // Gods: small filled circles on a ring inside their community.
  const godsBy = new Map();
  for (const g of sum.gods || []) {
    if (!byId.has(g.community)) continue;
    if (!godsBy.has(g.community)) godsBy.set(g.community, []);
    godsBy.get(g.community).push(g);
  }
  const godPlaced = [];
  for (const [cid, list] of godsBy) {
    const c0 = positions.get(cid);
    const r0 = rOf(byId.get(cid)) * 0.5;
    list.forEach((g, i) => {
      const a = (2 * Math.PI * i) / list.length;
      godPlaced.push({ g, x: c0.x + Math.cos(a) * r0, y: c0.y + Math.sin(a) * r0 });
    });
  }

  const detail = h('div', { class: 'map-panel-body' });
  const ask = h('div', { id: 'ask-graph', class: 'ask-graph' }, askPanel(projectId));
  const side = h('aside', { class: 'map-panel' }, detail, ask);
  let pick = null;
  let nodeEls = [];
  const markPick = () => { for (const { n, g } of nodeEls) g.classList.toggle('map-selected', n.id === pick); };
  const back = () => { pick = null; detail.replaceChildren(summaryPanel(sum)); markPick(); };
  const showCommunity = async (cm) => {
    pick = cm.id;
    markPick();
    detail.replaceChildren(communityPanel(cm, {}, back));
    const r = await fetchApi(`api/graph?id=${enc(projectId)}&community=${enc(cm.id)}`);
    if (pick !== cm.id) return;
    detail.replaceChildren(communityPanel(cm, r.error ? { error: r.error } : { nodes: r.data.nodes || [], truncated: !!r.data.truncated }, back));
  };
  const activate = (n) => (n.rest ? toggleAll() : showCommunity(comms.find((x) => x.id === n.id)));

  // Labels beyond the largest TOP_LABELS show once the view is zoomed to 1.5x or more.
  let svgRef = null;
  const c = canvas(() => box, () => { if (pick) back(); }, (k) => svgRef?.classList.toggle('map-zoomed', k >= 1.5));
  svgRef = c.svg;
  c.svg.setAttribute('viewBox', vb(box));
  for (const e of edges) {
    const a = positions.get(e.a), b = positions.get(e.b);
    c.edgeG.append(svgEl('line', {
      class: 'map-edge map-edge-connects', 'stroke-width': num(1 + Math.min(e.weight, 8) * 0.6),
      x1: num(a.x), y1: num(a.y), x2: num(b.x), y2: num(b.y),
    }));
  }
  nodeEls = nodes.map((n) => {
    const p0 = positions.get(n.id);
    const r = rOf(n);
    const minor = !n.rest && !labelled.has(n.id);
    const aria = n.rest ? `${n.label}, ${n.size} nodes, show all` : `${n.label}, ${n.size} nodes`;
    const g = svgEl('g', { class: `map-node map-community${n.rest ? ' map-rest' : ''}`, tabindex: 0, role: 'button', 'aria-label': aria, transform: moveTo(p0) },
      svgEl('circle', { r: num(r) }),
      svgEl('text', { class: 'map-count', 'text-anchor': 'middle', y: 4 }, String(n.size)),
      svgEl('text', { class: `map-label${minor ? ' map-label-minor' : ''}`, 'text-anchor': 'middle', y: num(r + 14) }, n.label));
    g.addEventListener('click', () => activate(n));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(n); return; }
      keyStep(e, nodeEls, g);
    });
    c.nodeG.append(g);
    return { n, g };
  });
  for (const { g, x, y } of godPlaced) {
    c.nodeG.append(svgEl('circle', { class: 'map-god', r: 4, cx: num(x), cy: num(y) },
      svgEl('title', {}, `${g.label} (degree ${g.degree})`)));
  }
  detail.replaceChildren(summaryPanel(sum));
  const wrap = h('div', { class: 'map map-graph' }, h('div', { class: 'map-body' }, c.svg, side));
  el.append(wrap);
}
