import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_ALIASES, serviceId, projectEdges } from '../scan/edges.mjs';

const repo = (remotes, worktrees = []) => ({ path: '/x/r', git: { value: { remotes, worktrees } } });

test('serviceId normalises, aliases and hyphenates', () => {
  assert.equal(serviceId('Neon EU'), 'neon');
  assert.equal(serviceId(' Vercel '), 'vercel');
  assert.equal(serviceId('My Mail Thing'), 'my-mail-thing');
  assert.equal(serviceId('vercel.com'), 'vercel');
  assert.equal(SERVICE_ALIASES['neon db'], 'neon');
});

test('uses edges and services count', () => {
  const projects = [
    { id: 'p1', uses: ['Neon EU', 'vercel'], repos: [] },
    { id: 'p2', uses: ['neon db'], repos: [] },
  ];
  const { edges, services } = projectEdges(projects);
  assert.deepEqual(edges, [
    { a: 'p1', b: 'neon', kind: 'uses', service: 'neon' },
    { a: 'p1', b: 'vercel', kind: 'uses', service: 'vercel' },
    { a: 'p2', b: 'neon', kind: 'uses', service: 'neon' },
  ]);
  assert.deepEqual(services.map((s) => [s.id, s.count]), [['neon', 2], ['vercel', 1]]);
});

test('a repeated service on one project gives one uses edge', () => {
  const { edges } = projectEdges([{ id: 'p1', uses: ['Neon EU', 'neon db # prod'], repos: [] }]);
  assert.equal(edges.length, 1);
  assert.equal(projectEdges([{ id: 'p1', uses: ['Neon EU', 'neon db # prod'] }]).services[0].count, 1);
});

test('uses naming another project becomes a connects edge', () => {
  const projects = [
    { id: 'alpha', name: 'Alpha', noteId: 'alpha-note', uses: ['Beta #api'], repos: [] },
    { id: 'beta', name: 'Beta Service', noteId: 'beta-note', uses: [], repos: [] },
  ];
  const { edges, services } = projectEdges(projects);
  assert.deepEqual(edges, [{ a: 'alpha', b: 'beta', kind: 'connects' }]);
  assert.deepEqual(services, []);
});

test('connects entries resolve by id, name or noteId; unresolved and self entries are dropped', () => {
  const projects = [
    { id: 'alpha', name: 'Alpha', noteId: 'alpha-note', connects: ['beta-note', 'Gamma', 'nobody', 'alpha'], repos: [] },
    { id: 'beta', name: 'Beta', noteId: 'beta-note', repos: [] },
    { id: 'gamma', name: 'Gamma', noteId: 'gamma', repos: [] },
  ];
  assert.deepEqual(projectEdges(projects).edges, [
    { a: 'alpha', b: 'beta', kind: 'connects' },
    { a: 'alpha', b: 'gamma', kind: 'connects' },
  ]);
});

test('a connects entry duplicated by uses gives one edge', () => {
  const projects = [
    { id: 'alpha', connects: ['beta'], uses: ['Beta'], repos: [] },
    { id: 'beta', repos: [] },
  ];
  assert.equal(projectEdges(projects).edges.filter((e) => e.kind === 'connects').length, 1);
});

test('shared remote or worktree makes exactly one repo edge; no repos makes none', () => {
  const p = [
    { id: 'a', repos: [repo(['https://u:t@github.com/o/r.git'], [{ path: '/x/b' }])], uses: [] }, // privacy-ok
    { id: 'b', home: '/x/b', repos: [{ path: '/x/b', git: { value: { remotes: ['https://github.com/o/r'], worktrees: [] } } }], uses: [] },
    { id: 'c', home: '/x/c', repos: [], uses: [] },
  ];
  const { edges } = projectEdges(p);
  assert.deepEqual(edges, [{ a: 'a', b: 'b', kind: 'repo' }]);
});

test('two registry entries that are worktrees of one repository give exactly one repo edge', () => {
  const remote = 'https://github.com/o/r.git';
  const p = [
    { id: 'main-wt', home: '/w/main', repos: [repo([remote], [{ path: '/w/main' }, { path: '/w/feat' }])], uses: [] },
    { id: 'feat-wt', home: '/W/Feat', repos: [repo([remote], [{ path: '/w/main' }, { path: '/w/feat' }])], uses: [] },
  ];
  assert.deepEqual(projectEdges(p).edges, [{ a: 'feat-wt', b: 'main-wt', kind: 'repo' }]);
});

test('a project with an errored git fact or no home does not throw', () => {
  const p = [
    { id: 'a', repos: [{ path: '/x/a', git: { error: 'boom' } }] },
    { id: 'b', home: '/x/b', repos: [{ path: '/x/b', git: { error: 'boom' } }] },
  ];
  assert.deepEqual(projectEdges(p).edges, []);
});
