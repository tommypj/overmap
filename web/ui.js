// Shared DOM and formatting helpers. No innerHTML except for already-escaped markdown output.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'text') el.textContent = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => { el.replaceChildren(); return el; };

export async function api(path) {
  const at = Date.now();
  try {
    const r = await fetch(path, { headers: { accept: 'application/json' } });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* keep status */ }
      return { data: null, at, error: msg };
    }
    return { data: await r.json(), at, error: null };
  } catch (e) {
    return { data: null, at, error: e.message || 'network error' };
  }
}

export const enc = encodeURIComponent;
export const fileUrl = (id, root, path) => `api/file?id=${enc(id)}&root=${enc(root)}&path=${enc(path)}`;
export const winPath = (p) => String(p).replaceAll('/', String.fromCharCode(92));
export const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

export function ago(when) {
  if (when == null) return 'unknown';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
export function dateText(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unknown' : new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}
export function bytes(n) {
  if (n == null) return 'unknown';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
export const branchText = (v) => v.branch ?? (v.head ? 'detached' : 'unknown');
export const statusPill = (status, cls = '') => (status == null ? pill('unknown', 'unknown') : pill(status, cls));
export const num = (n, suffix = '') => (n == null ? 'unknown' : `${n}${suffix}`);

export const pill = (text, cls = '') => h('span', { class: `pill ${cls}`.trim() }, text);
export const unknownPill = (why) => pill(why ? `unknown (${why})` : 'unknown', 'unknown');

// A fact is { at, value } or { at, error }. renderValue(value) -> node(s).
// Returns a block: the value (or "unknown (reason)") plus "scanned N min ago".
export function factNote(fact) {
  if (!fact) return h('span', { class: 'age' }, 'not scanned');
  return h('span', { class: 'age', title: fact.at || '' }, `scanned ${ago(fact.at)}`);
}
export function factBody(fact, renderValue) {
  if (!fact) return unknownPill('not scanned');
  if (fact.error) return unknownPill(fact.error);
  if (fact.value === undefined) return unknownPill('no value');
  return renderValue(fact.value);
}
// <fact-row>: label, value-or-unknown, age.
export function factRow(label, fact, renderValue) {
  return h('div', { class: 'row' }, h('span', { class: 'k' }, label), h('span', { class: 'rowbody' }, factBody(fact, renderValue)), factNote(fact));
}
export function section(title, fact, ...body) {
  return h('section', { class: 'blk' }, h('h3', null, title, fact !== undefined ? factNote(fact) : null), ...body);
}

export const isPhone = () => matchMedia('(max-width: 719px)').matches;
export const isTouch = () => matchMedia('(pointer: coarse)').matches;

export function copyButton(text, label = 'Copy path') {
  if (isTouch()) return null;
  const btn = h('button', { class: 'btn', type: 'button' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
      btn.after(h('input', { class: 'pathbox', readonly: true, value: text }));
    }
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
  return btn;
}

export function emptyNote(text) { return h('p', { class: 'muted' }, text); }
export function errorNote(why) { return h('p', { class: 'muted' }, `unknown (${why})`); }

// Fixed project facts derived from repo list.
export function repoValues(p) {
  return (p.repos || []).map((r) => ({ path: r.path, fact: r.git }));
}
export function lastWork(p) {
  let best = null, unknown = false;
  for (const r of p.repos || []) {
    const v = r.git?.value;
    if (!v || !v.lastDate) { unknown = true; continue; }
    const t = Date.parse(v.lastDate);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return { at: best, unknownSome: unknown };
}
export function isParked(p) { return ['parked', 'archived', 'terminated'].includes(p.status); }
export const riskCount = (p) => (p.attention || []).filter((a) => a.level === 'risk').length;
