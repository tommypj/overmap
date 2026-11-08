// Audit trail for cockpit actions. Everything free-form is masked before it is stored.
import { maskText } from './mask.mjs';

const enc = (v) => maskText(JSON.stringify(v ?? null));
const txt = (v) => (v == null ? null : maskText(v));
const dec = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return s; } };

export function recordAction(db, { at, who, action, project, args, status, result, durationMs }) {
  db.prepare('INSERT INTO actions_log(at, who, action, project, args, status, result, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(at, txt(who), txt(action), txt(project), enc(args), status, enc(result), durationMs ?? null);
}

export function listAudit(db, { limit = 100, project = null } = {}) {
  const parsed = Math.trunc(Number(limit));
  const n = Math.min(500, Math.max(1, Number.isNaN(parsed) ? 100 : parsed));
  const rows = project
    ? db.prepare('SELECT * FROM actions_log WHERE project = ? ORDER BY at DESC, id DESC LIMIT ?').all(project, n)
    : db.prepare('SELECT * FROM actions_log ORDER BY at DESC, id DESC LIMIT ?').all(n);
  return rows.map((r) => ({
    id: r.id, at: r.at, who: r.who, action: r.action, project: r.project, status: r.status,
    args: dec(r.args), result: dec(r.result), durationMs: r.duration_ms ?? null,
  }));
}
