import { GLYPH, deltaByProject, healthClass, readLastVisit, leaveOverview, notePendingVisit, persistPendingVisit, baselineFor, readBaseline, saveBaseline } from '../events.js';
import { statusPill, h, api, ago, enc, pill, unknownPill, riskCount, isParked, lastWork, isPhone } from '../ui.js';
import { renderMap, selectedGroup } from '../map/view.js';

// Totals across the main working trees of all repos. Unknown parts are named, never counted as zero.
export function repoTotals(p) {
  const repos = p.repos || [];
  if (!repos.length) return { none: true };
  let uncommitted = 0, unpushed = 0, unkU = 0, unkP = 0;
  for (const r of repos) {
    const v = r.git?.value;
    if (!v) { unkU++; unkP++; continue; }
    if (v.modified == null || v.untracked == null) unkU++; else uncommitted += v.modified + v.untracked;
    if (v.localOnlyCommits == null) unkP++; else unpushed += v.localOnlyCommits;
  }
  return { count: repos.length, uncommitted, unpushed, unkU, unkP };
}

function totalsCell(p) {
  const t = repoTotals(p);
  if (t.none) return h('span', { class: 'muted' }, 'no repo');
  const bits = [];
  bits.push(t.unkU ? `${t.uncommitted}+ uncommitted (${t.unkU} unknown)` : `${t.uncommitted} uncommitted`);
  bits.push(t.unkP ? `${t.unpushed}+ unpushed (${t.unkP} unknown)` : `${t.unpushed} unpushed`);
  return h('span', null, `${t.count} repo${t.count > 1 ? 's' : ''} · `, h('span', { class: t.unkU || t.unkP ? 'unk' : '' }, bits.join(' · ')));
}

function flagsCell(p) {
  const a = p.attention || [];
  if (!a.length) return h('span', { class: 'muted' }, 'none');
  const risk = a.filter((x) => x.level === 'risk'), warn = a.filter((x) => x.level === 'warn');
  const wrap = h('span', { class: 'flags' });
  if (risk.length) wrap.append(pill(`${risk.length} risk`, 'risk'), h('span', { class: 'ftext' }, risk[0].text));
  if (warn.length) wrap.append(pill(`${warn.length} warn`, 'warn'));
  wrap.title = a.map((x) => `${x.level}: ${x.text}`).join('\n');
  return wrap;
}

// Phone list: hide rows outside the selected cluster, and headings left with no visible rows.
function filterPhone(el, group) {
  let head = null, shown = 0;
  const close = () => { if (head) head.hidden = shown === 0; };
  for (const c of el.children) {
    if (c.classList.contains('pgrp')) { close(); head = c; shown = 0; }
    else if (c.classList.contains('prow')) { c.hidden = !!group && c.dataset.group !== group; if (!c.hidden) shown++; }
  }
  close();
}

function phoneRow(p, sub, risk, dot, delta) {
  return h('a', { class: 'prow', href: '#/p/' + enc(p.id) },
    h('span', { class: 'ptxt' }, h('span', { class: 'pname' }, dot, p.name), h('span', { class: 'age block' }, sub), delta ? h('span', { class: 'age block pdelta' }, delta) : null),
    risk ? h('span', { class: 'flag' }, String(risk)) : h('span', { class: 'chev' }, '\u203a'));
}

function renderPhoneList(el, d, ctx, lastVisit) {
  const active = d.projects.filter((p) => !isParked(p));
  const rank = (p) => (lastWork(p).at ?? 0);
  const sorted = [...active].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  const lastText = (p) => { const lw = lastWork(p); return lw.at == null ? (p.repos?.length ? 'last work unknown' : 'no repo') : `last work ${ago(lw.at)}`; };
  const dotCells = new Map();
  const deltaCells = new Map();
  const row = (p, sub, risk) => {
    const dot = h('span', { class: 'dotslot' }, healthDot(null));
    const delta = h('span', { class: 'pdeltatxt' }, '\u2026');
    dotCells.set(p.id, dot);
    deltaCells.set(p.id, delta);
    const a = phoneRow(p, sub, risk, dot, delta);
    a.dataset.group = p.group || '';
    return a;
  };
  const needs = sorted.filter((p) => riskCount(p) > 0);
  const group = (title, list, cls) => list.length ? [h('div', { class: 'pgrp' + (cls ? ' ' + cls : '') }, title), ...list] : [];
  el.append(h('div', { class: 'row between' }, h('h1', { class: 'ptitle' }, 'Projects'), h('a', { class: 'btn primary', href: '#/new' }, 'New project')));
  const phoneMap = h('section', { class: 'map-section' });
  el.append(phoneMap);
  el.append(...group('Needs attention', needs.map((p) => row(p, (p.attention || [])[0]?.text || lastText(p), riskCount(p))), 'attn'));
  const fams = new Map();
  for (const p of sorted.filter((x) => riskCount(x) === 0)) {
    const g = p.kind === 'project' ? (p.group || 'Other') : p.kind === 'shared' ? 'Shared' : 'Tooling and data';
    if (!fams.has(g)) fams.set(g, []);
    fams.get(g).push(row(p, lastText(p), 0));
  }
  for (const [g, list] of [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) el.append(...group(g, list));
  renderMap(phoneMap, ctx, { onSelect: (g) => filterPhone(el, g) });
  filterPhone(el, selectedGroup());
  const nameOf = (id) => d.projects.find((x) => x.id === id)?.name ?? id;
  const deltaNote = h('p', { class: 'age pdeltanote' }, deltaNoteText(lastVisit));
  el.insertBefore(deltaNote, el.children[1] ?? null);
  el.append(feedSection(ctx, nameOf, PHONE_FEED_PAGE));
  return Promise.all([fillDeltas(ctx, lastVisit, deltaCells, deltaNote), fillHealth(ctx, dotCells)]);
}

function deltaNoteText(lastVisit) {
  return lastVisit ? (Date.now() - Date.parse(lastVisit) > 7 * 86_400_000 ? 'since you last looked: last 7 d (capped)' : `since you last looked: ${ago(lastVisit)}`) : 'first visit: last 24 h';
}

// Deltas and health dots: one request each, filled in when they arrive. Shared by the desktop table and the phone list.
async function fillDeltas(ctx, lastVisit, deltaCells, deltaNote) {
  const requestedAt = new Date().toISOString();
  const r = await api('api/events?limit=500' + (lastVisit ? `&sinceIngested=${enc(lastVisit)}` : ''));
  if (ctx.stale()) return;
  if (r.error) { for (const c of deltaCells.values()) c.replaceChildren(unknownPill(r.error)); return; }
  if (r.data.length >= 500) deltaNote.append(' (capped at 500 events)');
  notePendingVisit(requestedAt);
  const by = deltaByProject(r.data);
  for (const [id, c] of deltaCells) {
    const parts = by.get(id);
    c.replaceChildren(parts?.length ? parts.join(' \u00b7 ') : h('span', { class: 'muted' }, 'nothing new'));
  }
}
async function fillHealth(ctx, dotCells) {
  const r = await api('api/facts/health');
  if (ctx.stale() || r.error) return;
  for (const [id, slot] of dotCells) slot.replaceChildren(healthDot(r.data[id] ?? null));
}

// Persist the shown baseline when the tab is hidden or the page unloads while the Overview is the current route.
export const persistOverviewVisit = () => persistPendingVisit();
export const markOverviewVisited = () => leaveOverview();

const FEED_PAGE = 50;
const PHONE_FEED_PAGE = 30;
const safeHref = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const LIVE_TAB_ROUTABLE = true;

function healthDot(hl) {
  const cls = healthClass(hl);
  const label = !hl ? 'health unknown' : cls === 'unk' ? `unknown (last ${hl.status}${hl.stale ? ', stale' : ''}, checked ${ago(hl.at)})` : `${hl.status} (checked ${ago(hl.at)})`;
  return h('span', { class: 'dot ' + cls, role: 'img', 'aria-label': label, title: label });
}

function feedRow(e, nameOf) {
  const ext = safeHref(e.url);
  const title = e.title || e.kind;
  const link = ext
    ? h('a', { href: ext, target: '_blank', rel: 'noopener noreferrer' }, title)
    : h('a', { href: '#/p/' + enc(e.project) + (LIVE_TAB_ROUTABLE ? '/live' : '') }, title);
  return h('li', { class: 'feedrow' },
    h('span', { class: 'age feedtime', title: e.at }, ago(e.at)),
    h('span', { class: 'feedproj' }, nameOf(e.project)),
    h('span', { class: 'glyph', title: e.kind }, GLYPH[e.kind] ?? '\u2022'),
    link);
}

function feedSection(ctx, nameOf, pageSize = FEED_PAGE) {
  const sec = h('section', { class: 'feed' }, h('h2', null, 'Recent events'));
  const list = h('ul', { class: 'feedlist' });
  const more = h('button', { class: 'btn', type: 'button' }, 'Show more');
  const status = h('p', { class: 'muted' }, 'Loading\u2026');
  sec.append(list, status, more);
  more.hidden = true;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let before = null;
  const page = async () => {
    more.disabled = true;
    const r = await api(`api/events?limit=${pageSize}&since=${enc(since)}` + (before ? `&before=${enc(before.at)}&beforeId=${before.id}` : ''));
    if (ctx.stale()) return;
    more.disabled = false;
    if (r.error) { status.textContent = `unknown (${r.error})`; more.hidden = !before; return; }
    for (const e of r.data) list.append(feedRow(e, nameOf));
    if (r.data.length) { const last = r.data[r.data.length - 1]; before = { at: last.at, id: last.id }; }
    more.hidden = r.data.length < pageSize;
    status.textContent = list.children.length ? '' : 'No events in the last 7 days.';
  };
  more.addEventListener('click', page);
  page();
  return sec;
}

export async function renderOverview(el, ctx) {
  notePendingVisit(null);
  const d = ctx.data;
  // A reload in the same tab keeps the baseline it first showed; a first look fixes it for the tab.
  const lastVisit = baselineFor({ session: readBaseline(), stored: readLastVisit() });
  saveBaseline(lastVisit);
  if (d && isPhone()) { await renderPhoneList(el, d, ctx, lastVisit); return; }
  el.append(h('div', { class: 'row between' }, h('h1', null, 'Overview'), h('a', { class: 'btn primary', href: '#/new' }, 'New project')));
  if (!d) { el.append(h('p', { class: 'note risk' }, `unknown (${ctx.error || 'no data'})`)); return; }
  const active = d.projects.filter((p) => !isParked(p));
  const needs = active.filter((p) => riskCount(p) > 0).length;
  el.append(h('p', { class: 'headline' }, `scanned ${ago(d.generatedAt)} · ${active.length} projects · ${needs} need attention`));
  const mapEl = h('section', { class: 'map-section' });
  el.append(mapEl);

  const rank = (p) => (lastWork(p).at ?? 0);
  const rows = [...active].sort((a, b) => riskCount(b) - riskCount(a) || rank(b) - rank(a) || a.name.localeCompare(b.name));
  const deltaCells = new Map();
  const dotCells = new Map();
  const tbody = h('tbody');
  for (const p of rows) {
    const lw = lastWork(p);
    const dot = h('span', { class: 'dotslot' }, healthDot(null));
    dotCells.set(p.id, dot);
    const delta = h('td', { class: 'delta' }, '…');
    deltaCells.set(p.id, delta);
    tbody.append(h('tr', { 'data-group': p.group || '' },
      h('td', null, dot, h('a', { href: '#/p/' + enc(p.id) }, p.name), h('span', { class: 'age block' }, p.kind === 'project' ? p.group : p.kind)),
      h('td', null, statusPill(p.status)),
      h('td', null, flagsCell(p)),
      h('td', null, lw.at == null ? unknownPill(p.repos?.length ? 'no commit date' : 'no repo') : h('span', { title: new Date(lw.at).toISOString() }, ago(lw.at), lw.unknownSome ? h('span', { class: 'age block' }, 'some repos unknown') : null)),
      h('td', null, totalsCell(p)),
      delta));
  }
  // The map filters this table to the selected cluster (no selection = all rows).
  const filterTable = (group) => { for (const tr of tbody.rows) tr.hidden = !!group && tr.dataset.group !== group; };
  renderMap(mapEl, ctx, { onSelect: filterTable });
  filterTable(selectedGroup());
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'grid-table' },
    h('thead', null, h('tr', null, ...['Project', 'Status', 'Attention', 'Last work', 'Repos', 'Since you last looked'].map((t) => h('th', null, t)))), tbody)));

  const nameOf = (id) => d.projects.find((x) => x.id === id)?.name ?? id;
  const deltaNote = h('p', { class: 'age' }, deltaNoteText(lastVisit));
  el.insertBefore(deltaNote, el.querySelector('.tablewrap'));
  el.append(feedSection(ctx, nameOf));

  await Promise.all([fillDeltas(ctx, lastVisit, deltaCells, deltaNote), fillHealth(ctx, dotCells)]);
}
