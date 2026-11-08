import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/db.mjs';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

test('openDb creates the tables and records the latest schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-db-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    const t = tables(db);
    for (const n of ['schema', 'facts', 'events', 'series', 'actions_log', 'manual_entries', 'scan_runs', 'connector_runs']) {
      assert.ok(t.includes(n), `missing table ${n}`);
    }
    const rows = db.prepare('SELECT version FROM schema').all();
    assert.deepEqual(rows.map((r) => r.version), [5]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('openDb is idempotent and keeps data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-db-'));
  const file = join(dir, 'c.db');
  try {
    let db = openDb(file);
    db.prepare('INSERT INTO scan_runs(at, seconds, projects) VALUES (?, ?, ?)').run('now', 2, 21);
    db.close();
    db = openDb(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scan_runs').get().n, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('busy_timeout is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-db-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    assert.equal(Object.values(db.prepare('PRAGMA busy_timeout').get())[0], 5000);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('uniqueness constraints are enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-db-'));
  const db = openDb(join(dir, 'c.db'));
  try {
    const ins = () => db.prepare('INSERT INTO events(project, source, kind, at, external_id) VALUES (?,?,?,?,?)').run('p', 's', 'k', 't', 'x1');
    ins();
    assert.throws(ins);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
