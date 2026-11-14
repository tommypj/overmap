import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connState, hasGood, nowNext, itemsOfKind, testsModel, deployModel, bugsModel, ideasModel } from '../web/devmodel.js';

const it = (id, title, state, kind = 'task') => ({ id, title, state, kind });
const plan = {
  source: 'master-plan', updatedAt: null, percent: 20,
  milestones: [
    { id: 'm1', title: 'Alpha', due: null, percent: 0, sprints: [
      { id: 'm1#0', title: 'Alpha', percent: 0, items: [it('a', 'A', 'in_progress'), it('b', 'B', 'planned', 'bug'), it('c', 'C', 'done', 'bug')] },
      { id: 'm1#1', title: 'Sprint 1', percent: 0, items: [it('d', 'D', 'blocked'), it('e', 'E', 'planned', 'idea'), it('f', 'F', 'planned', 'test')] },
    ] },
    { id: 'm2', title: 'Beta', due: null, percent: 0, sprints: [
      { id: 'm2#1', title: 'S2', percent: 0, items: [it('g', 'G', 'planned'), it('h', 'H', 'planned', 'idea'), it('i', 'I', 'done', 'idea'), it('j', 'J', 'planned')] },
    ] },
  ],
};
const T = '2026-11-03T10:00:00Z';
const later = '2026-11-03T11:00:00Z';
const earlier = '2026-11-03T09:00:00Z';
const good = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { at: T, value: v }]));

test('connState: four states', () => {
  assert.equal(connState(good({ x: 1 }), { status: 'ok' }), 'ok');
  assert.equal(connState({ _error: { at: T, error: 'boom' } }, undefined), 'error');
  assert.equal(connState(good({ x: 1 }), { status: 'error' }), 'error');
  assert.equal(connState({}, { status: 'not_configured' }), 'not_configured');
  assert.equal(connState({}, undefined), 'never');
  assert.equal(hasGood({ _error: {} }), false);
  assert.equal(hasGood(null), false);
});

test('nowNext: groups, order, where text, limit', () => {
  const r = nowNext(plan, { nextLimit: 2 });
  assert.deepEqual(r.now.map((i) => i.id), ['a']);
  assert.equal(r.now[0].where, 'Alpha');
  assert.deepEqual(r.blocked.map((i) => [i.id, i.where]), [['d', 'Alpha › Sprint 1']]);
  assert.deepEqual(r.next.map((i) => i.id), ['b', 'e']);
  assert.equal(nowNext(plan).next.length, 5);
  assert.equal(r.total, 10);
  assert.equal(r.done, 2);
  assert.equal(r.supported, true);
  assert.deepEqual(nowNext(null), { supported: false, now: [], blocked: [], next: [], total: 0, done: 0 });
});

test('non-master plans: no Now/Next, no plan bugs', () => {
  const docs = { ...plan, source: 'checkbox-docs' };
  const r = nowNext(docs);
  assert.deepEqual([r.supported, r.now, r.blocked, r.next, r.total], [false, [], [], [], 0]);
  assert.equal(bugsModel({}, undefined, [], docs).source, 'none');
  assert.equal(ideasModel(docs).count, 2);
});

test('itemsOfKind: open only by default, document order', () => {
  assert.deepEqual(itemsOfKind(plan, 'bug').map((i) => i.id), ['b']);
  assert.deepEqual(itemsOfKind(plan, 'bug', { openOnly: false }).map((i) => i.id), ['b', 'c']);
  assert.deepEqual(itemsOfKind(plan, 'idea').map((i) => i.where), ['Alpha › Sprint 1', 'Beta › S2']);
  assert.deepEqual(itemsOfKind(null, 'bug'), []);
});

const fileFact = (failed, at = T) => ({ at, value: { file: 'r.json', at, passed: 9, failed, skipped: 0, total: 9 + failed, durationMs: 5, command: 'npm test' } });
const act = (state, over = {}) => ({ id: 'run-tests', label: 'Run tests', kind: 'run', state, ...over });
const ran = (exitCode, endedAt, status = 'exited') => ({ status, exitCode, startedAt: endedAt, endedAt });

test('testsModel verdicts', () => {
  const p = testsModel(fileFact(0), []);
  assert.equal(p.verdict, 'pass');
  assert.equal(p.file.ok, true);
  assert.equal(p.run, null);
  assert.equal(testsModel(fileFact(2), []).verdict, 'fail');
  assert.equal(testsModel(fileFact(0, T), [act(ran(1, later))]).verdict, 'fail');
  assert.equal(testsModel(fileFact(0, T), [act(ran(1, earlier))]).verdict, 'pass');
  assert.equal(testsModel(fileFact(0, T), [act(ran(1, T))]).verdict, 'pass'); // tie: file wins
  assert.equal(testsModel(fileFact(2, T), [act(ran(0, later))]).verdict, 'pass');
  assert.equal(testsModel(fileFact(0), [act({ status: 'running', startedAt: later })]).verdict, 'running');
  assert.equal(testsModel(null, []).verdict, 'unknown');
  assert.equal(testsModel({ at: T, value: null }, [act(null)]).verdict, 'unknown');
  assert.equal(testsModel(null, [act(ran(0, T))]).verdict, 'pass');
});

test('testsModel: test-action match is on the word, not a substring', () => {
  const a = (id, label) => ({ id, label, kind: 'run', state: ran(0, T) });
  assert.equal(testsModel(null, [a('test-unit', 'Unit suite')]).run?.id, 'test-unit');
  assert.equal(testsModel(null, [a('run-tests', 'x')]).run?.id, 'run-tests');
  assert.equal(testsModel(null, [a('deploy-latest', 'Deploy latest')]).run, null);
  assert.equal(testsModel(null, [a('contest', 'Contest')]).run, null);
});

test('testsModel: run selection and fileError', () => {
  const acts = [
    act(ran(1, earlier), { id: 'run-old' }), act(ran(0, later), { id: 'run-new' }),
    { id: 'start-tests', label: 'tests', kind: 'start', state: ran(1, later) },
    { id: 'lint', label: 'Lint', kind: 'run', state: ran(1, later) },
  ];
  assert.equal(testsModel(null, acts).run.id, 'run-new');
  assert.equal(testsModel(null, [...acts, act({ status: 'running' }, { id: 'run-live' })]).run.id, 'run-live');
  const e = testsModel({ at: T, error: 'bad json' }, []);
  assert.equal(e.fileError, 'bad json');
  assert.equal(e.file, null);
  assert.equal(e.verdict, 'unknown');
});

test('deployModel: four states and values', () => {
  const d = { state: 'READY', createdAt: T, url: 'x.vercel.app', commit: 'c', sha: 'abc' };
  const facts = { vercel: good({ 'deploy.production': d, 'deploy.preview': null, 'deploy.failed_24h': 2 }) };
  const m = deployModel(facts, { status: 'ok' });
  assert.deepEqual([m.state, m.production, m.preview, m.failed24h], ['ok', d, null, 2]);
  assert.equal(deployModel({ vercel: { _error: { at: T, error: 'x' } } }, undefined).state, 'error');
  assert.equal(deployModel({}, { status: 'not_configured' }).state, 'not_configured');
  const n = deployModel({}, undefined);
  assert.deepEqual([n.state, n.production, n.preview, n.failed24h], ['never', null, null, null]);
});

test('bugsModel falls sentry -> plan -> none', () => {
  const events = [
    { kind: 'error', at: earlier, title: 'old' }, { kind: 'message', at: later, title: 'm' }, { kind: 'error', at: later, title: 'new' },
  ];
  const facts = { sentry: good({ 'issues.unresolved': 3, 'events.today': 7, 'issues.truncated': true }) };
  const s = bugsModel(facts, { status: 'ok' }, events, plan);
  assert.equal(s.source, 'sentry');
  assert.equal(s.unresolved, 3);
  assert.equal(s.eventsToday, 7);
  assert.equal(s.truncated, true);
  assert.deepEqual(s.list.map((e) => e.title), ['new', 'old']);
  const many = Array.from({ length: 15 }, (_, i) => ({ kind: 'error', at: `2026-11-03T10:${String(i).padStart(2, '0')}:00Z`, title: `e${i}` }));
  assert.equal(bugsModel(facts, undefined, many, null).list.length, 10);
  const p = bugsModel({}, undefined, events, plan);
  assert.equal(p.source, 'plan');
  assert.deepEqual(p.list.map((i) => i.id), ['b']);
  assert.equal(p.unresolved, null);
  const err = bugsModel({ sentry: { _error: { at: T, error: 'x' } } }, undefined, [], plan);
  assert.equal(err.source, 'plan');
  assert.equal(err.state, 'error');
  const none = bugsModel({}, undefined, [], null);
  assert.deepEqual([none.source, none.state, none.list], ['none', 'never', []]);
});

test('ideasModel groups by milestone', () => {
  const r = ideasModel(plan);
  assert.equal(r.count, 2);
  assert.deepEqual(r.groups.map((g) => [g.milestone, g.items.map((i) => i.id)]), [['Alpha', ['e']], ['Beta', ['h']]]);
  assert.deepEqual(ideasModel(null), { groups: [], count: 0 });
});
