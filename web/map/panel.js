// Side-panel content for the map: project and service details (zoomed out), summary and community lists
// (zoomed in). Builds DOM with h() only; no innerHTML.
import { h, enc, ago, branchText, num, pill } from '../ui.js';

const safeHref = (u) => (/^https:\/\//i.test(u ?? '') ? u : null);

export function panelHead(title, onClose) {
  return h('div', { class: 'row between' }, h('h3', null, title),
    onClose ? h('button', { class: 'btn small', type: 'button', on: { click: onClose } }, 'Close') : null);
}

const line = (label, ...value) => h('div', { class: 'row' }, h('span', { class: 'k' }, label), h('span', { class: 'rowbody' }, ...value));

function deployText(d) {
  const link = safeHref(d.url);
  return [d.state ?? 'unknown', d.createdAt ? ` \u00b7 ${ago(d.createdAt)}` : '',
    link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, ' open') : null];
}

// p: a project from projects.json. opts: { fetchApi, onClose, onCollapse }.
export function projectPanel(p, { fetchApi, onClose, onCollapse = null }) {
  const repo = p.repos?.[0];
  const v = repo?.git?.value;
  const repoText = !p.repos?.length ? 'no repo' : !v ? 'unknown'
    : `${branchText(v)} \u00b7 ahead ${num(v.ahead)} \u00b7 behind ${num(v.behind)}`;
  const t = p.tests?.value;
  const deploy = h('span', null, 'loading\u2026');
  fetchApi(`api/facts?id=${enc(p.id)}`).then((r) => {
    const d = r.data?.vercel?.['deploy.production']?.value;
    deploy.replaceChildren(...(d ? deployText(d) : ['unknown']));
  });
  const graph = p.graph?.value
    ? h('a', { href: '#/map/' + enc(p.id) }, 'Open the graph map')
    : h('p', { class: 'muted' }, `No graph yet. Run: /graphify ${p.home ?? '<home>'}`);
  return h('div', { class: 'mapcard' }, panelHead(p.name, onClose),
    line('Status', pill(p.status || 'unknown', 'status')),
    line('Group', p.group || 'none'),
    line('Repo', repoText),
    line('Plan', p.plan?.value ? num(p.plan.value.percent, '%') : 'unknown'),
    line('Tests', t ? `${t.passed} passed \u00b7 ${t.failed} failed` : 'unknown'),
    line('Deploy', deploy),
    graph,
    h('a', { href: '#/p/' + enc(p.id) }, 'Open the project page'),
    onCollapse ? h('button', { class: 'btn small', type: 'button', on: { click: onCollapse } }, `Collapse ${p.group}`) : null);
}

export function servicePanel(name, users, onClose) {
  return h('div', { class: 'mapcard' }, panelHead(name, onClose),
    h('p', { class: 'muted' }, `Shared service, used by ${users.length} project${users.length === 1 ? '' : 's'}.`),
    h('ul', { class: 'plain' }, ...users.map((u) => h('li', null, u))));
}

// Zoomed in: the whole-graph summary, shown until a community is picked.
export function summaryPanel(sum) {
  const comms = sum.communities?.length ?? 0;
  return h('div', { class: 'mapcard' }, h('h3', null, 'Communities'),
    h('p', { class: 'muted' }, `${sum.nodeCount} nodes \u00b7 ${sum.edgeCount} edges \u00b7 ${comms} communities`),
    h('p', { class: 'muted small' }, 'Click a community to list its nodes.'),
    h('div', { class: 'csub' }, 'Most connected'),
    h('ol', { class: 'items' }, ...(sum.gods || []).slice(0, 10).map((g) => h('li', null, g.label, h('span', { class: 'age' }, ` \u00b7 ${g.degree}`)))));
}

// state: {} while loading, { error } or { nodes, truncated }. Shows the top 50 nodes by degree.
export function communityPanel(c, state, onBack) {
  let body;
  if (state.error) body = h('p', { class: 'note risk' }, `unknown (${state.error})`);
  else if (!state.nodes) body = h('p', { class: 'muted' }, 'Loading\u2026');
  else {
    const top = [...state.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0)).slice(0, 50);
    body = h('div', null,
      state.truncated ? h('p', { class: 'note warn' }, 'Truncated: the server capped this community, so not every node is listed.') : null,
      h('ol', { class: 'items' }, ...top.map((n) => h('li', { title: n.file || '' }, n.label, h('span', { class: 'age' }, ` \u00b7 degree ${n.degree}`)))));
  }
  return h('div', { class: 'mapcard' }, panelHead(c.name, onBack),
    h('p', { class: 'muted' }, `${c.size} nodes`), body);
}
