import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapModel } from '../web/map/model.js';

const data = {
  projects: [
    { id: 'p1', name: 'One', status: 'active', group: 'G', kind: 'project', uses: ['neon'], connects: [], graph: null },
    { id: 'p2', name: 'Two', status: 'active', group: 'G', kind: 'project', uses: ['neon'], connects: ['p3'], graph: { at: 'x', value: { nodes: 1 } } },
    { id: 'p3', name: 'Three', status: 'active', group: 'G', kind: 'project', uses: ['neon'], connects: [], graph: { at: 'x', value: null } },
    { id: 'p4', name: 'Four', status: 'active', group: 'H', kind: 'project', uses: [], connects: [], graph: null },
    { id: 'p5', name: 'Five', status: 'archived', group: 'H', kind: 'project', uses: ['neon'], connects: [], graph: null },
  ],
  edges: [
    { a: 'p1', b: 'neon', kind: 'uses' },
    { a: 'p2', b: 'neon', kind: 'uses' },
    { a: 'p3', b: 'neon', kind: 'uses' },
    { a: 'p2', b: 'p3', kind: 'connects' },
    { a: 'p4', b: 'p1', kind: 'repo' },
    { a: 'p5', b: 'neon', kind: 'uses' },
  ],
  services: [{ id: 'neon', name: 'Neon', count: 4 }],
};

const ids = (r) => r.nodes.map((n) => n.id).sort();
const pairKey = (e) => `${e.kind}:${[e.a, e.b].sort().join('|')}`;

test('collapsed groups merge member edges and sum weights', () => {
  const r = mapModel(data);
  assert.deepEqual(ids(r), ['group:G', 'group:H', 'service:neon']);
  const g = r.nodes.find((n) => n.id === 'group:G');
  assert.equal(g.kind, 'group');
  assert.equal(g.size, 3);
  assert.equal(g.label, 'G');
  const uses = r.edges.find((e) => e.kind === 'uses');
  assert.deepEqual([uses.a, uses.b].sort(), ['group:G', 'service:neon']);
  assert.equal(uses.weight, 3);
  // p2-p3 connects is inside G: collapses to a self-loop and is dropped
  assert.equal(r.edges.some((e) => e.kind === 'connects'), false);
  // p4 (H) -> p1 (G) repo edge becomes one group-to-group edge
  const repo = r.edges.find((e) => e.kind === 'repo');
  assert.equal(pairKey(repo), 'repo:group:G|group:H');
  assert.equal(repo.weight, 1);
});

test('expanding a group emits its projects and no group node', () => {
  const r = mapModel(data, { expanded: new Set(['G']) });
  assert.deepEqual(ids(r), ['group:H', 'p1', 'p2', 'p3', 'service:neon']);
  assert.equal(r.nodes.some((n) => n.id === 'group:G'), false);
  const p2 = r.nodes.find((n) => n.id === 'p2');
  assert.equal(p2.kind, 'project');
  assert.equal(p2.group, 'G');
  assert.equal(p2.label, 'Two');
  assert.equal(p2.size, 1);
  const keys = r.edges.map(pairKey).sort();
  assert.ok(keys.includes('connects:p2|p3'));
  assert.ok(keys.includes('uses:p1|service:neon'));
  assert.ok(keys.includes('repo:group:H|p1'));
  for (const e of r.edges) assert.equal(e.weight, 1);
});

test('parked projects hidden by default, shown with hideParked:false', () => {
  assert.equal(mapModel(data).nodes.some((n) => n.id === 'p5'), false);
  const shown = mapModel(data, { hideParked: false });
  assert.equal(shown.nodes.find((n) => n.id === 'group:H').size, 2);
  const exp = mapModel(data, { expanded: new Set(['H']), hideParked: false });
  assert.ok(exp.nodes.some((n) => n.id === 'p5' && n.status === 'archived'));
  assert.ok(exp.edges.some((e) => pairKey(e) === 'uses:p5|service:neon'));
});

test('services are always one node each and graph flag reflects graph.value', () => {
  const r = mapModel(data, { expanded: new Set(['G']) });
  const svc = r.nodes.find((n) => n.id === 'service:neon');
  assert.equal(svc.kind, 'service');
  assert.equal(svc.label, 'Neon');
  assert.equal(svc.graph, false);
  assert.equal(r.nodes.find((n) => n.id === 'p2').graph, true);
  assert.equal(r.nodes.find((n) => n.id === 'p3').graph, false);
  assert.equal(r.nodes.find((n) => n.id === 'p1').graph, false);
});

test('a group whose members are all parked emits no node', () => {
  const only = { ...data, projects: data.projects.filter((p) => p.group !== 'H' || p.id === 'p5') };
  assert.equal(mapModel(only).nodes.some((n) => n.id === 'group:H'), false);
});

test('edges to unknown projects are dropped', () => {
  const r = mapModel({ ...data, edges: [...data.edges, { a: 'nope', b: 'p1', kind: 'repo' }] });
  assert.equal(r.edges.some((e) => e.a === 'nope' || e.b === 'nope'), false);
});
