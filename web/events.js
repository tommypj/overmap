// Pure helpers for the Overview deltas and feed. No DOM here.
export const GLYPH = { message: '✉', claim: '\u{1F464}', order: '\u{1F4B6}', error: '⚠', deploy: '\u{1F680}', approval: '✅', run_finished: '\u{1F916}' };
const LABEL = {
  message: ['message', 'messages'], claim: ['claim', 'claims'], order: ['order', 'orders'], error: ['error', 'errors'],
  deploy: ['deploy', 'deploys'], approval: ['approval to decide', 'approvals to decide'], run_finished: ['run finished', 'runs finished'],
};
const ORDER = ['claim', 'order', 'message', 'approval', 'run_finished', 'error', 'deploy'];

export function isFailedDeploy(e) {
  if (e.kind !== 'deploy') return false;
  let state;
  try { state = (typeof e.json === 'string' ? JSON.parse(e.json) : e.json)?.state; } catch { state = undefined; }
  if (typeof state === 'string') return state === 'ERROR';
  return /^\S+ ERROR\b/.test(e.title ?? ''); // rows written before json.state existed
}

// Health dot colour: grey when stale or older than 15 min.
export function healthClass(hl, nowMs = Date.now()) {
  if (!hl || hl.stale) return 'unk';
  const t = Date.parse(hl.at);
  return Number.isNaN(t) || nowMs - t > 15 * 60_000 ? 'unk' : hl.status;
}

// events -> Map(project -> parts[]) with parts like "+3 claims", "deploy failed".
export function deltaByProject(events) {
  const per = new Map();
  for (const e of events) {
    if (!LABEL[e.kind]) continue;
    const key = isFailedDeploy(e) ? 'deploy_failed' : e.kind;
    const c = per.get(e.project) ?? new Map();
    c.set(key, (c.get(key) ?? 0) + 1);
    per.set(e.project, c);
  }
  const out = new Map();
  for (const [project, c] of per) {
    const parts = [];
    for (const kind of ORDER) {
      const n = c.get(kind);
      if (n) parts.push(`+${n} ${LABEL[kind][n === 1 ? 0 : 1]}`);
    }
    const f = c.get('deploy_failed');
    if (f) parts.push(f === 1 ? 'deploy failed' : `${f} deploys failed`);
    out.set(project, parts);
  }
  return out;
}

const KEY = 'cockpit.lastVisit';
export function readLastVisit(storage = globalThis.localStorage) {
  try {
    const v = storage.getItem(KEY);
    const t = v == null ? NaN : Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  } catch { return null; }
}
// The timestamp of the delta request the page last showed. Persisted by leaveOverview() or when the page is
// hidden/unloaded while the Overview is open, never Date.now().
let pendingVisit = null;
export const notePendingVisit = (iso) => { pendingVisit = iso; };
export function leaveOverview(storage = globalThis.localStorage, session = globalThis.sessionStorage) {
  clearBaseline(session);
  if (pendingVisit === null) return false;
  writeLastVisit(storage, Date.parse(pendingVisit));
  pendingVisit = null;
  return true;
}
// Same write, but the Overview stays open (tab hidden, pagehide): pending is kept for a later leave.
export function persistPendingVisit(storage = globalThis.localStorage) {
  if (pendingVisit === null) return false;
  writeLastVisit(storage, Date.parse(pendingVisit));
  return true;
}

// The baseline the Overview shows its deltas against. A reload in the same tab keeps showing the baseline it first
// used (sessionStorage; 'none' = it was a first visit), instead of the lastVisit a pagehide has since persisted.
export const BASELINE_KEY = 'cockpit.deltaBaseline';
const validIso = (v) => { const t = v == null ? NaN : Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
export function baselineFor({ session, stored }) {
  if (session === 'none') return null;
  return validIso(session) ?? validIso(stored);
}
export function readBaseline(session = globalThis.sessionStorage) {
  try { return session.getItem(BASELINE_KEY); } catch { return null; }
}
export function saveBaseline(iso, session = globalThis.sessionStorage) {
  try { session.setItem(BASELINE_KEY, iso ?? 'none'); } catch { /* storage blocked */ }
}
export function clearBaseline(session = globalThis.sessionStorage) {
  try { session.removeItem(BASELINE_KEY); } catch { /* storage blocked */ }
}
export function writeLastVisit(storage = globalThis.localStorage, now = Date.now()) {
  try { storage.setItem(KEY, new Date(now).toISOString()); } catch { /* storage blocked */ }
}
