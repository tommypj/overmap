import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Each entry is applied once, in order; schema holds the single current version row.
const MIGRATIONS = [
  `CREATE TABLE facts (
     project TEXT, source TEXT, key TEXT, at TEXT, status TEXT, json TEXT,
     PRIMARY KEY (project, source, key)
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY, project TEXT, source TEXT, kind TEXT, at TEXT,
     title TEXT, url TEXT, json TEXT, external_id TEXT,
     UNIQUE (source, external_id)
   );
   CREATE TABLE series (
     project TEXT, metric TEXT, day TEXT, value REAL,
     PRIMARY KEY (project, metric, day)
   );
   CREATE TABLE actions_log (
     id INTEGER PRIMARY KEY, at TEXT, action TEXT, project TEXT, args TEXT,
     result TEXT, duration_ms INTEGER
   );
   CREATE TABLE manual_entries (
     id INTEGER PRIMARY KEY, month TEXT, kind TEXT, provider TEXT, project TEXT,
     amount REAL, note TEXT
   );
   CREATE TABLE scan_runs (at TEXT, seconds INTEGER, projects INTEGER);`,
  `CREATE TABLE connector_runs (
     connector TEXT, project TEXT, at TEXT, status TEXT, error TEXT, duration_ms INTEGER,
     PRIMARY KEY (connector, project)
   );
   CREATE INDEX events_at ON events(at);`,
  // v3: an event is unique per project too (connectors with several targets share a source).
  `CREATE TABLE events_new (
     id INTEGER PRIMARY KEY, project TEXT, source TEXT, kind TEXT, at TEXT,
     title TEXT, url TEXT, json TEXT, external_id TEXT,
     UNIQUE (project, source, external_id)
   );
   INSERT INTO events_new(id, project, source, kind, at, title, url, json, external_id)
     SELECT id, project, source, kind, at, title, url, json, external_id FROM events;
   DROP TABLE events;
   ALTER TABLE events_new RENAME TO events;
   CREATE INDEX events_at ON events(at);`,
  // v4: when the cockpit first saw (or last saw change) an event, as distinct from when it happened.
  `ALTER TABLE events ADD COLUMN ingested_at TEXT NOT NULL DEFAULT '';
   UPDATE events SET ingested_at = at;
   CREATE INDEX events_ingested ON events(ingested_at);`,
  // v5: who ran an action and how it ended.
  `ALTER TABLE actions_log ADD COLUMN who TEXT;
   ALTER TABLE actions_log ADD COLUMN status TEXT;
   CREATE INDEX actions_log_at ON actions_log(at);`,
];

export function openDb(file) { // the caller always passes the file (<home>/data/overmap.db)
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL)');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema').get();
    const current = row?.v ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[v]);
        db.exec('DELETE FROM schema');
        db.prepare('INSERT INTO schema(version) VALUES (?)').run(v + 1);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
