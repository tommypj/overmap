import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';
import { recordAction, listAudit } from '../lib/audit.mjs';

function tmp() { const dir = mkdtempSync(join(tmpdir(), 'cockpit-audit-')); const db = openDb(join(dir, 'c.db')); return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } }; }

test('schema v5 has who and status', () => {
  const { db, done } = tmp();
  try {
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema').get().v, 5);
    const cols = db.prepare('PRAGMA table_info(actions_log)').all().map((c) => c.name);
    assert.ok(cols.includes('who') && cols.includes('status'));
  } finally { done(); }
});

test('recordAction masks secrets; listAudit orders, parses, clamps, filters', () => {
  const { db, done } = tmp();
  try {
    recordAction(db, { at: '2026-11-02T10:00:00Z', who: 'laptop', action: 'a', project: 'P', args: { token: 'pcp_board_1234567890abcdef' }, status: 'ok', result: { n: 1 }, durationMs: 5 }); // privacy-ok
    recordAction(db, { at: '2026-11-02T11:00:00Z', who: 'laptop', action: 'b', project: 'Q', args: {}, status: 'refused', result: 'plain', durationMs: null });
    const raw = db.prepare('SELECT args FROM actions_log WHERE action = ?').get('a').args;
    assert.ok(!raw.includes('1234567890abcdef'));
    const rows = listAudit(db, {});
    assert.deepEqual(rows.map((r) => r.action), ['b', 'a']);
    assert.equal(typeof rows[1].args, 'object');
    assert.equal(rows[0].result, 'plain');
    assert.equal(rows[0].durationMs, null);
    assert.deepEqual(listAudit(db, { project: 'P' }).map((r) => r.action), ['a']);
    for (let i = 0; i < 600; i++) recordAction(db, { at: `2026-11-03T00:${String(i % 60).padStart(2, '0')}:00Z`, who: 'l', action: 'z', project: 'Z', args: {}, status: 'ok', result: {}, durationMs: 1 });
    assert.equal(listAudit(db, { limit: 9999 }).length, 500);
  } finally { done(); }
});
