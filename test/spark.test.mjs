import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scale } from '../web/spark.js';

const pts = (...v) => v.map((value, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value }));

test('two points -> M then L', () => {
  const d = scale(pts(1, 3), 100, 20);
  assert.match(d, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
});
test('a null in the middle breaks the line into two M segments', () => {
  const d = scale(pts(1, null, 3, 4), 100, 20);
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((d.match(/L/g) || []).length, 1);
});
test('a single point is just M x y', () => {
  assert.match(scale(pts(5), 100, 20), /^M [\d.]+ [\d.]+$/);
});
test('equal values draw a flat line at mid-height', () => {
  const d = scale(pts(7, 7, 7), 100, 20);
  const ys = [...d.matchAll(/[ML] [\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(ys, [10, 10, 10]);
});
test('no usable points -> empty path', () => {
  assert.equal(scale([], 100, 20), '');
  assert.equal(scale(pts(null, null), 100, 20), '');
});

test('a gap of more than one UTC day lifts the pen', () => {
  const p = [['2026-10-01', 1], ['2026-10-02', 2], ['2026-10-06', 3], ['2026-10-07', 4]].map(([day, value]) => ({ day, value }));
  const d = scale(p, 100, 20);
  assert.equal((d.match(/M/g) || []).length, 2);
  assert.equal((d.match(/L/g) || []).length, 2);
});
test('consecutive days stay connected', () => {
  const p = [['2026-10-01', 1], ['2026-10-02', 2], ['2026-10-03', 3]].map(([day, value]) => ({ day, value }));
  assert.equal((scale(p, 100, 20).match(/M/g) || []).length, 1);
});
