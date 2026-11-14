// Read-only route handlers.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson, BadRequest } from './router.mjs';
import { classify } from './auth.mjs';
import { resolveSafe, listDir, indexFiles, sendFile, NotFound, Forbidden } from './fsapi.mjs';
import { maskSecrets } from '../scan/refs.mjs';
import { systemSnapshot, matchProcesses, isProtected, currentUser, sameUser } from '../scan/system.mjs';
import { loadRegistry } from '../registry.mjs';
import { openDb } from '../lib/db.mjs';
import { CONNECTORS, byId } from '../connectors/index.mjs';
import { connectorOverview, sanitiseError } from '../lib/connector.mjs';
import { fetchJson } from '../lib/http.mjs';
import { maskText } from '../lib/mask.mjs';
import { createSecrets } from '../lib/secrets.mjs';
import { createTokens } from '../lib/csrf.mjs';
import { createActionRoutes } from './actions.mjs';
import { createRunner } from '../lib/runner.mjs';
import { ACTIONS_DIR } from '../lib/actions-config.mjs';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const LIVE_TTL = 30_000;
const INDEX_TTL = 10 * 60_000;
const EVENTS_DEFAULT_MS = 24 * 3_600_000;
const EVENTS_MAX_MS = 7 * 24 * 3_600_000;
const EVENT_KINDS = ['message', 'claim', 'order', 'error', 'deploy', 'approval', 'run_finished'];

const SECRET_KEY = /secret|token|key|password|auth/i;
const looksSecret = (v) => typeof v === 'string' && (maskText(v) !== v || /:\/\/[^/\s]*@/.test(v));
// Registry connector config minus anything secret-looking: such keys (at any depth) and strings that mask differently or carry userinfo.
function cleanConfig(o) {
  if (Array.isArray(o)) return o.filter((x) => !looksSecret(x)).map((x) => (x !== null && typeof x === 'object' ? cleanConfig(x) : x));
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (SECRET_KEY.test(k) || looksSecret(v)) continue;
    out[k] = v !== null && typeof v === 'object' ? cleanConfig(v) : v;
  }
  return out;
}

// The first vercel.teamId in the registry: lets Vercel discovery scope its project list to the team.
function firstTeamId(reg) {
  for (const e of reg.values()) { const t = e?.connectors?.vercel?.teamId; if (typeof t === 'string' && t) return t; }
  return null;
}

export function createRoutes({ config, env = process.env, now = Date.now, snapshot = systemSnapshot, connectors = CONNECTORS, secrets = createSecrets(config.home), getSecret = secrets.getSecret, fetchJsonImpl = fetchJson, tokens = createTokens({ now }), runner = createRunner({ now }), spawnOpen, codeExe, killTree, rescan, isScanning, actionsDir = ACTIONS_DIR }) {
  const connById = (id) => connectors.find((c) => c.id === id) ?? byId(id);
  const dataFile = join(config.home, 'data', 'projects.json');
  const webDir = resolve(HERE, 'web');
  const registryFile = join(config.home, 'registry.json');
  const legacyFile = join(HERE, 'legacy', 'dashboard.html');

  let db = null;
  const getDb = () => (db ??= openDb(join(config.home, 'data', 'overmap.db')));

  // Re-read when registry.json changes (mtime/size), so Settings and Live reflect edits without a restart.
  let registry = null;
  let registrySig;
  const getRegistry = () => {
    let sig = null;
    try { const st = statSync(registryFile); sig = `${st.mtimeMs}:${st.size}`; } catch { /* missing file */ }
    if (registry && sig === registrySig) return registry;
    registrySig = sig;
    try { registry = loadRegistry(registryFile); } catch { registry = new Map(); }
    return registry;
  };

  let snap = null; // { at: ms, promise }
  const getSnapshot = () => {
    if (!snap || now() - snap.at > LIVE_TTL) {
      const entry = { at: now(), promise: snapshot() };
      entry.promise.catch(() => { if (snap === entry) snap = null; });
      snap = entry;
    }
    return snap.promise;
  };

  const refreshSnapshot = () => { snap = null; return getSnapshot(); };

  const indexCache = new Map(); // `${id}\0${kind}` -> { at, value }

  const readProjects = () => {
    try { return JSON.parse(readFileSync(dataFile, 'utf8')); } catch { throw new NotFound('no scan yet'); }
  };
  function project(url, data) {
    const id = url.searchParams.get('id');
    if (!id) throw new BadRequest('id required');
    const p = (data ?? readProjects()).projects?.find((x) => x.id === id);
    if (!p) throw new NotFound('unknown project');
    return p;
  }
  const rootsOf = (p) => (Array.isArray(p.roots) ? p.roots : []);
  const rootParam = (url) => {
    const raw = url.searchParams.get('root') ?? '0';
    if (!/^\d+$/.test(raw)) throw new Forbidden('bad root');
    return Number(raw);
  };

  function serveStatic(req, res, rel) {
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { throw new BadRequest('bad path'); }
    if (decoded.includes('\0')) throw new Forbidden('bad path');
    const target = resolve(webDir, '.' + sep + decoded.replaceAll('\\', '/'));
    const base = webDir.endsWith(sep) ? webDir : webDir + sep;
    if (!(target + sep).startsWith(base) || !existsSync(target)) throw new NotFound();
    sendFile(req, res, target, { safeTypes: false, disposition: false, cacheControl: 'no-cache', checkSecrets: false });
  }

  const who = (req) => {
    const cls = classify(req, config);
    return { class: cls, login: cls === 'tailnet' ? String(req.headers['tailscale-user-login'] ?? '') : null };
  };
  const actionRoutes = createActionRoutes({ now, getDb, getRegistry, getSnapshot, refreshSnapshot, runner, tokens, who, env, spawnOpen, codeExe, killTree, rescan, isScanning, registryFile, projectsDir: config.projectsDir, vaultDir: config.vaultProjectsDir, readProjects, actionsDir });

  async function routes(ctx) {
    const { req, res, url, path, config: cfg } = ctx;
    if (path === '/api/csrf' || path === '/api/audit' || path === '/api/actions' || path.startsWith('/api/actions/')) return actionRoutes(ctx);
    switch (path) {
      case '/':
        serveStatic(req, res, 'index.html');
        return true;
      case '/legacy':
        sendFile(req, res, legacyFile, { safeTypes: false, disposition: false, cacheControl: 'no-cache', checkSecrets: false });
        return true;
      case '/setup': {
        const buf = Buffer.concat([readFileSync(join(HERE, 'docs', 'SETUP-stage2.md')), Buffer.from('\n\n---\n\n'), readFileSync(join(HERE, 'docs', 'SETUP-stage3.md')), Buffer.from('\n\n---\n\n'), readFileSync(join(HERE, 'docs', 'SETUP-stage4.md'))]);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return true;
      }
      case '/api/whoami': {
        const cls = classify(req, cfg);
        const login = cls === 'tailnet' ? String(req.headers['tailscale-user-login'] ?? '') : null;
        sendJson(req, res, 200, { class: cls, login });
        return true;
      }
      case '/api/projects': {
        const buf = Buffer.from(JSON.stringify(readProjects()));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return true;
      }
      case '/api/live': {
        const p = project(url);
        const s = await getSnapshot();
        const matched = s.value ? matchProcesses(s.value, rootsOf(p)) : null;
        const reg = getRegistry();
        const me = currentUser(env);
        const processes = matched === null ? null : matched.map((proc) => {
          const prot = isProtected(proc, reg) || reg.get(p.id)?.protected === true;
          const why = prot ? 'protected' : proc.user == null ? 'owner unknown' : !sameUser(proc.user, me) ? 'not your process' : null;
          return { ...proc, cmd: proc.cmd == null ? proc.cmd : maskSecrets(proc.cmd), protected: prot, stoppable: { ok: why === null, why } };
        });
        sendJson(req, res, 200, { at: s.at, processes, ...(s.error ? { error: s.error } : {}) });
        return true;
      }
      case '/api/ls': {
        const p = project(url);
        const idx = rootParam(url);
        const rel = url.searchParams.get('path') ?? '';
        const abs = resolveSafe(rootsOf(p), idx, rel);
        let listing;
        try { listing = listDir(abs); } catch (e) {
          if (e.code === 'ENOTDIR') throw new BadRequest('not a directory');
          throw new NotFound();
        }
        sendJson(req, res, 200, { root: idx, path: rel.replaceAll('\\', '/'), ...listing });
        return true;
      }
      case '/api/index': {
        const p = project(url);
        const kind = url.searchParams.get('kind');
        if (kind !== 'media' && kind !== 'docs') throw new BadRequest('kind must be media or docs');
        const key = `${p.id}\0${kind}`;
        let hit = indexCache.get(key);
        if (!hit || now() - hit.at > INDEX_TTL) {
          hit = { at: now(), value: indexFiles(rootsOf(p), kind) };
          indexCache.set(key, hit);
        }
        sendJson(req, res, 200, { at: new Date(hit.at).toISOString(), ...hit.value });
        return true;
      }
      case '/api/file': {
        const p = project(url);
        const abs = resolveSafe(rootsOf(p), rootParam(url), url.searchParams.get('path') ?? '');
        sendFile(req, res, abs);
        return true;
      }
      case '/api/settings': {
        let lastScan = null;
        try { lastScan = getDb().prepare('SELECT at, seconds, projects FROM scan_runs ORDER BY at DESC LIMIT 1').get() ?? null; } catch { /* db unavailable */ }
        if (lastScan) lastScan = { ...lastScan };
        sendJson(req, res, 200, {
          secrets: secrets.health(),
          config: { home: cfg.home, vaultProjectsDir: cfg.vaultProjectsDir, architectureFile: cfg.architectureFile },
          lastScan,
        });
        return true;
      }
      case '/api/connectors': {
        let projectsJson = {};
        try { projectsJson = readProjects(); } catch { /* no scan yet */ }
        const d = getDb();
        sendJson(req, res, 200, connectors.map((c) => connectorOverview(c, getRegistry(), projectsJson, d, getSecret)));
        return true;
      }
      case '/api/connectors/config': {
        const id = url.searchParams.get('id');
        if (!id) throw new BadRequest('id required');
        const cfgs = getRegistry().get(id)?.connectors ?? {};
        const out = {};
        for (const [cid, c] of Object.entries(cfgs)) {
          if (c === null || typeof c !== 'object' || Array.isArray(c)) continue;
          out[cid] = cleanConfig(c);
        }
        sendJson(req, res, 200, out);
        return true;
      }
      case '/api/connectors/discover': {
        const conn = connById(url.searchParams.get('id') ?? '');
        if (!conn) throw new NotFound('unknown connector');
        if (!conn.discover) throw new NotFound('no discovery');
        const missingSecrets = (conn.secrets ?? []).filter((n) => getSecret(n) === undefined);
        if (missingSecrets.length) {
          sendJson(req, res, 409, { error: 'not configured', missing: missingSecrets });
          return true;
        }
        let found;
        try { found = await conn.discover({ getSecret, fetchJson: fetchJsonImpl, now, registry: getRegistry(), teamId: firstTeamId(getRegistry()) }); } catch (e) {
          sendJson(req, res, 502, { error: sanitiseError(e, (conn.secrets ?? []).map((n) => getSecret(n)).filter(Boolean)) });
          return true;
        }
        sendJson(req, res, 200, found);
        return true;
      }
      case '/api/facts': {
        const id = url.searchParams.get('id');
        if (!id) throw new BadRequest('id required');
        const out = {};
        for (const r of getDb().prepare('SELECT source, key, at, status, json FROM facts WHERE project = ?').all(id)) {
          let v = null;
          try { v = JSON.parse(r.json); } catch { /* keep null */ }
          (out[r.source] ??= {})[r.key] = r.status === 'ok' ? { at: r.at, value: v } : r.status === 'stale' ? { at: r.at, value: v, stale: true } : { at: r.at, error: v };
        }
        sendJson(req, res, 200, out);
        return true;
      }
      case '/api/series': {
        const id = url.searchParams.get('id');
        const metric = url.searchParams.get('metric');
        if (!id || !metric) throw new BadRequest('id and metric required');
        const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30, 1), 365);
        const since = new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
        sendJson(req, res, 200, getDb().prepare('SELECT day, value FROM series WHERE project = ? AND metric = ? AND day >= ? ORDER BY day').all(id, metric, since).map((r) => ({ ...r })));
        return true;
      }
      case '/api/facts/health': {
        const out = {};
        for (const r of getDb().prepare("SELECT project, at, status, json FROM facts WHERE source = 'health' AND key = 'health.status'").all()) {
          if (r.status !== 'ok' && r.status !== 'stale') continue;
          let v = null;
          try { v = JSON.parse(r.json); } catch { /* keep null */ }
          if (v === 'up' || v === 'down') out[r.project] = { status: v, at: r.at, ...(r.status === 'stale' ? { stale: true } : {}) };
        }
        sendJson(req, res, 200, out);
        return true;
      }
      case '/api/events': {
        const id = url.searchParams.get('id');
        const inRange = (t) => !Number.isNaN(t) && t >= Date.UTC(1970, 0, 1) && t < Date.UTC(2101, 0, 1);
        const floor = now() - EVENTS_MAX_MS;
        const bound = (name) => {
          const raw = url.searchParams.get(name);
          if (raw === null) return null;
          const t = Date.parse(raw);
          if (!inRange(t)) throw new BadRequest('bad ' + name);
          return Math.max(t, floor);
        };
        let sinceMs = bound('since');
        const ingestedMs = bound('sinceIngested');
        if (sinceMs === null && ingestedMs === null) sinceMs = now() - EVENTS_DEFAULT_MS;
        const rawBefore = url.searchParams.get('before');
        let beforeIso = null;
        if (rawBefore !== null) {
          const t = Date.parse(rawBefore);
          if (!inRange(t)) throw new BadRequest('bad before');
          beforeIso = new Date(t).toISOString();
        }
        const rawKinds = url.searchParams.get('kinds');
        let kinds = null;
        if (rawKinds !== null) {
          kinds = [...new Set(rawKinds.split(','))];
          if (!kinds.length || kinds.some((k) => !EVENT_KINDS.includes(k))) throw new BadRequest('bad kinds');
        }
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
        const where = [];
        const args = [];
        if (sinceMs !== null) { where.push('at >= ?'); args.push(new Date(sinceMs).toISOString()); }
        if (ingestedMs !== null) { where.push('ingested_at >= ?'); args.push(new Date(ingestedMs).toISOString()); }
        if (id) { where.push('project = ?'); args.push(id); }
        const rawBeforeId = url.searchParams.get('beforeId');
        if (rawBeforeId !== null && (beforeIso === null || !/^\d{1,15}$/.test(rawBeforeId))) throw new BadRequest('bad beforeId');
        if (beforeIso && rawBeforeId !== null) { where.push('(at < ? OR (at = ? AND id < ?))'); args.push(beforeIso, beforeIso, Number(rawBeforeId)); }
        else if (beforeIso) { where.push('at < ?'); args.push(beforeIso); }
        if (kinds) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
        const sql = `SELECT id, project, source, kind, at, title, url, json FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ?`;
        sendJson(req, res, 200, getDb().prepare(sql).all(...args, limit).map((r) => ({ ...r })));
        return true;
      }
      default:
        if (path.startsWith('/web/')) {
          serveStatic(req, res, path.slice('/web/'.length));
          return true;
        }
        return false;
    }
  }
  routes.tokens = tokens;
  routes.runner = runner;
  routes.close = () => { try { db?.close(); } catch { /* already closed */ } db = null; };
  return routes;
}
