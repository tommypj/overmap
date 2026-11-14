// Router, data loading and sidebar. Relative URLs only: in production the page lives under /projects/.
import { h, clear, api, enc, riskCount, isParked, ago } from './ui.js';
import { renderOverview, markOverviewVisited, persistOverviewVisit } from './pages/overview.js';
import { renderProject } from './pages/project.js';
import { renderSettings } from './pages/settings.js';
import { renderNewProject } from './pages/newproject.js';
import { renderAudit } from './pages/audit.js';
import { renderProjectGraph } from './map/view.js';

const side = document.getElementById('side');
const main = document.getElementById('main');
const phonebar = document.getElementById('phonebar');
const state = { data: null, error: null, at: 0, fresh: false };
let seq = 0;
let onOverview = false;
const openGroups = new Set();

export function parseHash(hash = location.hash) {
  return hash.replace(/^#\/?/, '').split('/').filter((s) => s !== '').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

async function loadProjects(force = false) {
  if (!force && state.data && Date.now() - state.at < 30_000) return;
  const r = await api('api/projects');
  if (r.error) { state.error = r.error; return; }
  state.data = r.data;
  state.error = null;
  state.at = Date.now();
}

const byName = (a, b) => a.name.localeCompare(b.name);

function groupProjects(projects) {
  const live = projects.filter((p) => !isParked(p));
  const families = new Map();
  for (const p of live.filter((x) => x.kind === 'project')) {
    const g = p.group || 'Other';
    if (!families.has(g)) families.set(g, []);
    families.get(g).push(p);
  }
  return {
    needs: live.filter((p) => riskCount(p) > 0).sort(byName),
    families: [...families.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([g, l]) => [g, l.sort(byName)]),
    shared: live.filter((p) => p.kind === 'shared').sort(byName),
    tooling: live.filter((p) => ['tool', 'data', 'media'].includes(p.kind)).sort(byName),
    parked: projects.filter(isParked).sort(byName),
  };
}

function navItem(p, currentId) {
  const risk = riskCount(p);
  return h('a', { class: 'navitem' + (p.id === currentId ? ' on' : ''), href: '#/p/' + enc(p.id), title: p.summary || p.name },
    h('span', { class: 'navname' }, p.name), risk ? h('span', { class: 'flag' }, `● ${risk}`) : null);
}

function collapsible(key, title, items) {
  if (!items.length) return null;
  const d = h('details', { class: 'navgroup' }, h('summary', { class: 'grp' }, title, h('span', { class: 'count' }, items.length)), ...items);
  if (openGroups.has(key)) d.open = true;
  d.addEventListener('toggle', () => { if (d.open) openGroups.add(key); else openGroups.delete(key); });
  return d;
}

function renderSide(route) {
  clear(side);
  const cur = route[0] === 'p' || route[0] === 'map' ? route[1] : null;
  side.append(h('div', { class: 'brand' }, h('a', { href: '#/' }, 'Overmap')));
  if (state.fresh) side.append(newScanButton());
  side.append(h('a', { class: 'navitem' + (route.length === 0 || route[0] === 'map' ? ' on' : ''), href: '#/' }, 'Overview'));
  if (!state.data) {
    side.append(h('p', { class: 'muted pad' }, state.error ? `unknown (${state.error})` : 'Loading...'));
    return;
  }
  const g = groupProjects(state.data.projects);
  if (g.needs.length) {
    side.append(h('div', { class: 'grp attn' }, 'Needs attention', h('span', { class: 'count risk' }, g.needs.reduce((n, p) => n + riskCount(p), 0))));
    for (const p of g.needs) side.append(navItem(p, cur));
  }
  for (const [name, list] of g.families) {
    side.append(h('div', { class: 'grp' }, name));
    for (const p of list) side.append(navItem(p, cur));
  }
  if (g.shared.length) {
    side.append(h('div', { class: 'grp' }, 'Shared'));
    for (const p of g.shared) side.append(navItem(p, cur));
  }
  const t = collapsible('tooling', 'Tooling and data', g.tooling.map((p) => navItem(p, cur)));
  if (t) side.append(t);
  const pk = collapsible('parked', 'Parked', g.parked.map((p) => navItem(p, cur)));
  if (pk) side.append(pk);
  side.append(h('div', { class: 'grp' }, 'Cockpit'),
    h('a', { class: 'navitem' + (route[0] === 'new' ? ' on' : ''), href: '#/new' }, 'New project'),
    h('a', { class: 'navitem' + (route[0] === 'audit' ? ' on' : ''), href: '#/audit' }, 'Actions log'),
    h('a', { class: 'navitem' + (route[0] === 'settings' ? ' on' : ''), href: '#/settings' }, 'Settings'));
}

function newScanButton() {
  return h('button', { class: 'pill chip warn', type: 'button', on: { click: () => route() } }, 'new scan available — refresh');
}

function renderPhoneBar(r) {
  clear(phonebar);
  const inProject = r[0] === 'p';
  const p = inProject ? state.data?.projects.find((x) => x.id === r[1]) : null;
  const sub = inProject && r[2] ? ' \u00b7 ' + ({ dev: 'Dev', files: 'Files', media: 'Media', docs: 'Docs', live: 'Live' }[r[2]] || '') : '';
  phonebar.append(inProject
    ? h('a', { class: 'pback', href: '#/' }, '\u2039 ', p ? p.name : 'Projects', sub)
    : r[0] === 'map' ? h('a', { class: 'pback', href: '#/' }, '\u2039 Overview')
    : h('a', { class: 'pback', href: '#/' }, r.length ? 'Projects' : 'Overmap'));
  const title = { new: 'New project', audit: 'Actions log', map: 'Map' }[r[0]];
  if (title) phonebar.append(h('span', { class: 'ptb' }, title));
  phonebar.append(h('span', { class: 'pill' }, state.data ? 'refreshed ' + ago(state.data.generatedAt) : 'offline'));
  if (state.fresh) phonebar.append(newScanButton());
}

async function route() {
  const mine = ++seq;
  const r = parseHash();
  // lastVisit is written when the Overview is LEFT, never on load, so the summary survives a reload.
  if (onOverview && r.length !== 0) markOverviewVisited();
  onOverview = r.length === 0;
  await loadProjects(state.fresh);
  if (mine !== seq) return;
  state.fresh = false;
  renderSide(r);
  renderPhoneBar(r);
  const ctx = { data: state.data, error: state.error, stale: () => mine !== seq, route: r };
  clear(main);
  try {
    if (r.length === 0) await renderOverview(main, ctx);
    else if (r[0] === 'p') await renderProject(main, ctx);
    else if (r[0] === 'settings') await renderSettings(main, ctx);
    else if (r[0] === 'new') await renderNewProject(main, ctx);
    else if (r[0] === 'audit') await renderAudit(main, ctx);
    else if (r[0] === 'map') await renderProjectGraph(main, ctx, r[1] ?? '', { api });
    else main.append(h('h1', null, 'Not found'), h('p', null, h('a', { href: '#/' }, 'Back to the overview')));
  } catch (e) {
    console.error(e);
    main.append(h('p', { class: 'note risk' }, `unknown (${e.message})`));
  }
}

window.addEventListener('hashchange', route);
// Escape leaves the zoomed-in map for the Overview.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && parseHash()[0] === 'map') location.hash = '#/'; });
// Closing or backgrounding the tab on the Overview counts as leaving it (the page may never get another event).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && onOverview) persistOverviewVisit(); });
window.addEventListener('pagehide', () => { if (onOverview) persistOverviewVisit(); });
matchMedia('(max-width: 719px)').addEventListener('change', route);
// Re-read the scan every minute. A new scan updates the sidebar and the refreshed pill only; the open page
// (preview, media paging, scroll) is left alone behind a refresh button, except on the Overview.
setInterval(async () => {
  const before = state.data?.generatedAt;
  await loadProjects(true);
  if (state.data?.generatedAt === before) return;
  const r = parseHash();
  if (r.length === 0) { route(); return; }
  state.fresh = true;
  renderSide(r);
  renderPhoneBar(r);
}, 60_000);
route();
