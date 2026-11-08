// Connector runner: gate on secrets/config, fetch, parse, write everything in one transaction.
import { maskText } from './mask.mjs';

export const EVERY_MS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000 };

// Mask known token shapes and literal secret values, then cut.
export function sanitiseError(msg, secretValues = []) {
  return maskText(msg instanceof Error ? msg.message : String(msg ?? ''), secretValues).slice(0, 300);
}

// Masks every string leaf (keys of the object are left alone) so the JSON stays valid.
function maskDeep(v, secretValues) {
  if (typeof v === 'string') return maskText(v, secretValues);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, secretValues));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, secretValues)]));
  return v;
}

// Names of secrets and registry fields that stop this connector from running for this target.
export function missingFor(conn, target, getSecret) {
  const missing = [];
  for (const n of conn.secrets ?? []) if (getSecret(n) === undefined) missing.push(n);
  // `project` is the registry key on every target, so a connector whose own field is called `project` keeps it under
  // another target key and maps the name back here via `fieldNames`.
  for (const f of conn.required ?? []) if (target[f] == null) missing.push(`connectors.${conn.id}.${conn.fieldNames?.[f] ?? f}`);
  return missing;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Throws a descriptive error on any shape problem, so nothing half-written reaches the database.
function validate(out, secretValues = []) {
  if (out === null || typeof out !== 'object') throw new Error('parse returned no result');
  const { facts = [], series = [], events = [] } = out;
  if (!Array.isArray(facts) || !Array.isArray(series) || !Array.isArray(events)) throw new Error('parse result lists must be arrays');
  const f = facts.map((x) => {
    if (typeof x?.key !== 'string' || !x.key) throw new Error('fact without a key');
    let v = x.value === undefined ? null : x.value;
    if (typeof v === 'string' && /\.(reason|error)$/.test(x.key)) v = sanitiseError(v, secretValues);
    const json = JSON.stringify(v);
    return { key: x.key, json };
  });
  const s = series.map((x) => {
    if (typeof x?.metric !== 'string' || !DAY.test(String(x.day))) throw new Error(`bad series row ${x?.metric}`);
    if (typeof x.value !== 'number' || !Number.isFinite(x.value)) throw new Error(`series ${x.metric} ${x.day}: value is not a number`);
    return { metric: x.metric, day: x.day, value: x.value, merge: x.merge === 'max' ? 'max' : null };
  });
  const e = events.map((x) => {
    if (typeof x?.external_id !== 'string' || !x.external_id) throw new Error('event without external_id');
    if (typeof x.at !== 'string' || typeof x.title !== 'string') throw new Error(`event ${x.external_id}: at/title must be strings`);
    const t = new Date(x.at).getTime();
    if (Number.isNaN(t)) throw new Error(`event ${x.external_id}: invalid at`);
    return { kind: String(x.kind ?? ''), at: new Date(t).toISOString(), title: sanitiseError(x.title, secretValues), url: x.url == null ? null : maskText(String(x.url), secretValues), external_id: x.external_id, json: x.json === undefined ? null : JSON.stringify(maskDeep(x.json, secretValues)) };
  });
  return { f, s, e };
}

export async function runConnector(conn, target, ctx, db) {
  const t0 = Date.now();
  const at = new Date(ctx.now()).toISOString();
  const project = target.project;
  const source = conn.id;
  // extraSecretValues(ctx): values derived from secrets (e.g. a base64 Basic credential) that must be masked too.
  const secretValues = [...(conn.secrets ?? []).map((n) => ctx.getSecret(n)), ...(conn.extraSecretValues?.(ctx) ?? [])];

  const recordRun = (status, error = null) => {
    db.prepare('INSERT OR REPLACE INTO connector_runs(connector, project, at, status, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(source, project, at, status, error, Date.now() - t0);
  };

  const missing = missingFor(conn, target, ctx.getSecret);
  if (missing.length) {
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE facts SET status = 'stale' WHERE project = ? AND source = ?").run(project, source);
      recordRun('not_configured', `missing: ${missing.join(', ')}`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
    return { status: 'not_configured', missing };
  }

  try {
    const timeoutMs = ctx.timeoutMs ?? 30_000;
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000} s`)), timeoutMs); });
    let out;
    try {
      const work = (async () => conn.parse(await conn.fetch(target, ctx), target))();
      work.catch(() => {});
      out = await Promise.race([work, limit]);
    } finally { clearTimeout(timer); }
    const { f, s, e } = validate(out, secretValues);
    db.exec('BEGIN');
    try {
      const putFact = db.prepare('INSERT INTO facts(project, source, key, at, status, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, source, key) DO UPDATE SET at=excluded.at, status=excluded.status, json=excluded.json');
      for (const x of f) putFact.run(project, source, x.key, at, 'ok', x.json);
      db.prepare("DELETE FROM facts WHERE project = ? AND source = ? AND key = '_error'").run(project, source);
      const putSeries = db.prepare('INSERT INTO series(project, metric, day, value) VALUES (?, ?, ?, ?) ON CONFLICT(project, metric, day) DO UPDATE SET value = excluded.value');
      const putMax = db.prepare('INSERT INTO series(project, metric, day, value) VALUES (?, ?, ?, ?) ON CONFLICT(project, metric, day) DO UPDATE SET value = MAX(series.value, excluded.value)');
      for (const x of s) (x.merge === 'max' ? putMax : putSeries).run(project, x.metric, x.day, x.value);
      const putEvent = db.prepare('INSERT INTO events(project, source, kind, at, title, url, json, external_id, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, source, external_id) DO UPDATE SET at = CASE WHEN events.title IS excluded.title AND events.json IS excluded.json THEN events.at ELSE excluded.at END, ingested_at = CASE WHEN events.title IS excluded.title AND events.json IS excluded.json THEN events.ingested_at ELSE excluded.ingested_at END, title=excluded.title, json=excluded.json, url=excluded.url');
      for (const x of e) putEvent.run(project, source, x.kind, x.at, x.title, x.url, x.json, x.external_id, at);
      recordRun('ok');
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction */ }
      throw err;
    }
    return { status: 'ok' };
  } catch (err) {
    const message = sanitiseError(err, secretValues);
    try {
      db.exec('BEGIN');
      db.prepare('INSERT INTO facts(project, source, key, at, status, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project, source, key) DO UPDATE SET at=excluded.at, status=excluded.status, json=excluded.json')
        .run(project, source, '_error', at, 'error', JSON.stringify(message));
      recordRun('error', message);
      db.exec('COMMIT');
    } catch (e2) {
      try { db.exec('ROLLBACK'); } catch { /* none */ }
      console.error(`connector ${source}/${project}: could not record error:`, sanitiseError(e2, secretValues));
    }
    return { status: 'error', error: message };
  }
}

// Live view for /api/connectors: not_configured is computed now (secrets and fields), else the last run row.
export function connectorOverview(conn, registry, projectsJson, db, getSecret) {
  let targets = [];
  try { targets = conn.targets(registry, projectsJson) ?? []; } catch { targets = []; }
  const runs = new Map(db.prepare('SELECT * FROM connector_runs WHERE connector = ?').all(conn.id).map((r) => [r.project, r]));
  const projects = targets.map((t) => {
    const missing = missingFor(conn, t, getSecret);
    const run = runs.get(t.project);
    if (missing.length) return { project: t.project, status: 'not_configured', at: null, error: null, missing };
    if (!run || run.status === 'not_configured') return { project: t.project, status: 'never_ran', at: null, error: null, missing: [] };
    return { project: t.project, status: run.status, at: run.at, error: run.error ?? null, missing: [] };
  });
  return { id: conn.id, every: conn.every, ...(conn.note ? { note: conn.note } : {}), ...(conn.discover ? { discover: true } : {}), projects };
}
