import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaByProject, readLastVisit, writeLastVisit, leaveOverview, notePendingVisit, healthClass, isFailedDeploy, GLYPH } from '../web/events.js';

const e = (project, kind, title = 't') => ({ project, kind, title });

test('deltas group by project then kind, with plurals and failed deploys named', () => {
  const m = deltaByProject([
    e('A', 'claim'), e('A', 'claim'), e('A', 'claim'), e('A', 'message'), e('A', 'run_finished'), e('A', 'run_finished'),
    e('A', 'deploy', 'Deploy ERROR on main'), e('B', 'approval'), e('B', 'deploy', 'ok'), e('B', 'bogus'),
  ]);
  assert.equal(m.get('A').join(' \u00b7 '), '+3 claims \u00b7 +1 message \u00b7 +2 runs finished \u00b7 deploy failed');
  assert.deepEqual(m.get('B'), ['+1 approval to decide', '+1 deploy']);
  assert.equal(m.get('C'), undefined);
});

test('every event kind has a glyph', () => {
  for (const k of ['message', 'claim', 'order', 'error', 'deploy', 'approval', 'run_finished']) assert.ok(GLYPH[k]);
});

test('lastVisit: missing, invalid and throwing storage all read as null; write round-trips', () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(readLastVisit(st), null);
  writeLastVisit(st, Date.parse('2026-10-31T10:00:00Z'));
  assert.equal(mem.get('cockpit.lastVisit'), '2026-10-31T10:00:00.000Z');
  assert.equal(readLastVisit(st), '2026-10-31T10:00:00.000Z');
  mem.set('cockpit.lastVisit', 'garbage');
  assert.equal(readLastVisit(st), null);
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readLastVisit(bad), null);
  assert.doesNotThrow(() => writeLastVisit(bad));
});

test('failed deploy: json.state decides; old rows fall back to the title', () => {
  assert.equal(isFailedDeploy({ kind: 'deploy', json: '{"state":"ERROR"}', title: 'production ok' }), true);
  assert.equal(isFailedDeploy({ kind: 'deploy', json: '{"state":"READY"}', title: 'production ERROR' }), false);
  assert.equal(isFailedDeploy({ kind: 'deploy', json: null, title: 'production ERROR \u00b7 fix' }), true);
  assert.equal(isFailedDeploy({ kind: 'deploy', json: null, title: 'production READY \u00b7 fix ERROR handling' }), false);
  assert.equal(isFailedDeploy({ kind: 'message', json: '{"state":"ERROR"}' }), false);
});

test('health dot is grey when stale or older than 15 min', () => {
  const now = Date.parse('2026-10-31T10:20:00Z');
  assert.equal(healthClass({ status: 'up', at: '2026-10-31T10:10:00Z' }, now), 'up');
  assert.equal(healthClass({ status: 'down', at: '2026-10-31T10:10:00Z' }, now), 'down');
  assert.equal(healthClass({ status: 'up', at: '2026-10-31T10:00:00Z' }, now), 'unk');
  assert.equal(healthClass({ status: 'up', at: '2026-10-31T10:19:00Z', stale: true }, now), 'unk');
  assert.equal(healthClass(null, now), 'unk');
});

test('leaving the Overview persists the delta-request time, not now; nothing is written without a fetch', () => {
  const mem = new Map();
  const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  notePendingVisit(null);
  assert.equal(leaveOverview(st), false);
  assert.equal(mem.size, 0);
  notePendingVisit('2026-10-31T09:00:00.000Z');
  assert.equal(leaveOverview(st), true);
  assert.equal(mem.get('cockpit.lastVisit'), '2026-10-31T09:00:00.000Z');
  assert.equal(leaveOverview(st), false);
});
