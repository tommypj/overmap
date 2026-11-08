// Action routes: CSRF tokens, the audit trail, and the allowlisted actions (list, run/stop/restart, output, files).
// Nothing from a request body ever reaches a command line: the body only picks a project id and an action id
// out of the allowlist files (actions/<id>.json), and the argv comes from there.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson, BadRequest } from './router.mjs';
import { NotFound } from './fsapi.mjs';
import { listAudit, recordAction } from '../lib/audit.mjs';
import { maskText } from '../lib/mask.mjs';
import { spawn } from 'node:child_process';
import { Conflict, taskkillTree } from '../lib/runner.mjs';
import { matchProcesses, isProtected, currentUser, sameUser } from '../scan/system.mjs';
import { rootsOf } from '../registry.mjs';
import { actionsCache } from '../lib/actions-config.mjs';
import { validateNewProject, createProject } from '../lib/new-project.mjs';

const OPS = ['start', 'stop', 'restart'];
const LOCAL_WHY = 'open-on-laptop works only from the laptop page';

// A refusal: ends the request with this status and is audited as `refused`.
class Refuse extends Error {
  constructor(status, payload) { super(typeof payload === 'string' ? payload : 'refused'); this.status = status; this.payload = typeof payload === 'string' ? { error: payload } : payload; }
}

export function findVsCode({ env = process.env, exists = existsSync } = {}) {
  const c = [env.LOCALAPPDATA ? `${env.LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe` : null, 'C:/Program Files/Microsoft VS Code/Code.exe']; // privacy-ok
  const hit = c.find((p) => p && exists(p));
  return hit ? hit.replaceAll('/', '\\') : null;
}

// Detached so the opened window outlives the dashboard; resolves once the child exists, rejects on ENOENT etc.
const defaultSpawnOpen = (file, args) => new Promise((res, rej) => {
  const c = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
  c.once('error', rej);
  c.once('spawn', () => { c.unref(); res(); });
});

// Descendants of proc by ppid; a child must not predate its parent (pid reuse), and cycles end the walk.
function descendantsOf(procs, proc) {
  const seen = new Set([proc.pid]);
  const out = [];
  const queue = [proc];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of procs) {
      if (seen.has(p.pid) || p.ppid !== parent.pid) continue;
      const a = Date.parse(p.created);
      const b = Date.parse(parent.created);
      if (Number.isFinite(a) && Number.isFinite(b) && a < b) continue; // older than its parent = reused pid; unknown times fail closed
      seen.add(p.pid); out.push(p); queue.push(p);
    }
  }
  return out;
}

export function createActionRoutes({
  now = Date.now, getDb, getRegistry, getSnapshot, refreshSnapshot = getSnapshot, runner, tokens, actionsDir, who, env = process.env,
  spawnOpen = defaultSpawnOpen, codeExe, killTree = taskkillTree, rescan = null, isScanning = () => false,
  registryFile, projectsDir = '/projects', vaultDir, readProjects = null,
}) {
  const cache = actionsCache(actionsDir);
  const keyOf = (id, action) => `${id}/${action.id}`;
  const entryOf = (id) => (typeof id === 'string' ? getRegistry().get(id) : undefined);
  const view = (e) => { const r = cache.get(e); return { ...r, error: r.error == null ? null : maskText(r.error) }; };

  function audit(w, action, project, args, status, result, started) {
    try {
      recordAction(getDb(), { at: new Date(now()).toISOString(), who: `${w.class}:${w.login ?? ''}`, action, project, args, status, result, durationMs: now() - started });
    } catch (e) { console.error('audit write failed:', e.message); }
  }

  async function list(req, res, url) {
    const id = url.searchParams.get('id');
    if (!id) throw new BadRequest('id required');
    const e = entryOf(id);
    if (!e) throw new NotFound('unknown project');
    const loaded = view(e);
    // listeners: null/absent when the snapshot failed; unknown is never "closed"
    let listeners = null;
    if (loaded.actions.some((a) => a.port !== null)) {
      try { const s = await getSnapshot(); listeners = Array.isArray(s?.value?.listeners) ? s.value.listeners : null; } catch { listeners = null; }
    }
    const cls = who(req).class;
    sendJson(req, res, 200, {
      at: loaded.at,
      local: { available: cls === 'laptop', why: cls === 'laptop' ? null : LOCAL_WHY },
      protected: e.protected === true,
      error: loaded.error,
      actions: loaded.actions.map((a) => ({
        id: a.id, label: a.label, kind: a.kind, confirm: a.confirm, port: a.port,
        portOpen: a.port === null || listeners === null ? null : listeners.some((l) => l.port === a.port),
        cmd: maskText(a.cmd.join(' ')), cwd: a.cwd, error: a.error == null ? null : maskText(a.error),
        state: runner.state(keyOf(id, a)),
      })),
    });
  }

  function output(req, res, url) {
    const id = url.searchParams.get('id');
    const actionId = url.searchParams.get('action');
    if (!id || !actionId) throw new BadRequest('id and action required');
    const raw = url.searchParams.get('after');
    const after = raw === null || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(after) || after < 0) throw new BadRequest('bad after');
    const e = entryOf(id);
    if (!e) throw new NotFound('unknown project');
    const out = runner.output(`${id}/${actionId}`, after);
    if (out.state === null) throw new NotFound('never started');
    sendJson(req, res, 200, out); // lines are masked by the runner
  }

  function files(req, res) {
    const out = [];
    for (const e of getRegistry().values()) {
      if (!existsSync(join(actionsDir, `${e.id}.json`))) continue;
      const r = view(e);
      out.push({ project: e.id, file: `${e.id}.json`, count: r.actions.length, error: r.error });
    }
    sendJson(req, res, 200, out);
  }

  // The shared frame of every POST: csrf check, Refuse -> audited `refused`, anything else -> audited `failed`.
  // fn gets { done, csrf, confirm, w } and sends the response itself. A 409 handshake is not an outcome: not audited.
  async function guarded(req, res, body, action, fn, { noProject = false } = {}) {
    const started = now();
    const w = who(req);
    const { csrf, confirm, ...rest } = body ?? {};
    const args = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}...` : v]));
    const project = !noProject && typeof body?.id === 'string' ? body.id : null;
    const done = (status, result) => audit(w, action, project, args, status, result, started);
    try {
      if (!tokens.check(csrf, w.class, w.login)) throw new Refuse(403, 'bad csrf');
      await fn({ done, csrf, confirm, w });
      return true;
    } catch (err) {
      if (err instanceof Refuse) {
        done('refused', { error: err.payload.error ?? err.message });
        sendJson(req, res, err.status, err.payload);
        return true;
      }
      done('failed', { error: maskText(String(err?.message ?? err)) });
      throw err;
    }
  }

  // True when it answered 409 with a fresh nonce (the caller returns); false when the confirm nonce was valid and spent.
  function handshake(req, res, csrf, confirm, bind, title, detail) {
    if (confirm === undefined || confirm === null || confirm === '') {
      const nonce = tokens.issueNonce(csrf, bind);
      if (!nonce) throw new Refuse(403, 'bad csrf');
      sendJson(req, res, 409, { confirm: { nonce, title, detail } });
      return true;
    }
    if (!tokens.consumeNonce(csrf, confirm, bind)) throw new Refuse(403, 'bad confirm');
    return false;
  }

  const run = (req, res, body) => guarded(req, res, body, 'run', async ({ done, csrf, confirm }) => {
    const e = entryOf(body.id);
    if (!e) throw new Refuse(404, 'unknown project');
    const op = body.op === undefined ? 'start' : body.op;
    if (!OPS.includes(op)) throw new Refuse(400, 'bad op');
    const loaded = view(e);
    const action = typeof body.action === 'string' ? loaded.actions.find((a) => a.id === body.action) : undefined;
    if (!action) throw new Refuse(404, 'unknown action');
    if (action.error !== null) throw new Refuse(400, `action disabled: ${maskText(action.error)}`);
    const key = keyOf(e.id, action);
    const running = runner.state(key)?.status === 'running';
    if (op === 'start' && running) throw new Refuse(409, 'already running');
    if (op !== 'start' && !running) throw new Refuse(409, 'not running');
    if ((op !== 'start' || action.confirm) &&
        handshake(req, res, csrf, confirm, `run|${e.id}|${action.id}|${op}`, `${op} ${action.label}`, [maskText(action.cmd.join(' ')), action.cwd])) return;
    let state;
    let stopped = false;
    try {
      if (op !== 'start') { state = await runner.stop(key); stopped = true; }
      if (op !== 'stop') state = runner.start(key, action);
    } catch (err) {
      if (err instanceof Conflict) { // lost a race with another request
        if (op === 'restart' && stopped) { done('failed', { error: 'stopped; restart lost race' }); sendJson(req, res, 409, { error: 'already running' }); return; }
        throw new Refuse(409, /not running/.test(err.message) ? 'not running' : 'already running');
      }
      throw err;
    }
    if (state.status === 'failed') done('failed', { error: maskText(String(state.error ?? 'failed')) });
    else done('ok', { status: state.status, pid: state.pid });
    sendJson(req, res, 200, { state });
  });

  // Fixed argv per `what`; the only variable parts are the registry home and the VS Code path found on disk.
  const OPEN_WHAT = ['explorer', 'vscode', 'terminal', 'claude'];
  const openLocal = (req, res, body) => guarded(req, res, body, 'open-local', async ({ done, w }) => {
    if (w.class !== 'laptop') throw new Refuse(403, 'laptop only');
    const e = entryOf(body.id);
    if (!e) throw new Refuse(404, 'unknown project');
    if (!OPEN_WHAT.includes(body.what)) throw new Refuse(400, 'bad what');
    const home = String(e.home).replaceAll('/', '\\');
    let argv;
    if (body.what === 'explorer') argv = ['explorer.exe', home];
    else if (body.what === 'terminal') argv = ['wt.exe', '-d', home];
    else if (body.what === 'claude') argv = ['wt.exe', '-d', home, 'cmd.exe', '/k', 'claude'];
    else {
      const exe = codeExe !== undefined ? codeExe : findVsCode({ env, exists: existsSync });
      if (!exe) throw new Refuse(404, 'VS Code not found');
      argv = [exe, home];
    }
    try { await spawnOpen(argv[0], argv.slice(1)); } catch (err) {
      const msg = maskText(String(err?.message ?? err));
      done('failed', { error: msg });
      sendJson(req, res, 502, { error: msg });
      return;
    }
    done('ok', { what: body.what });
    sendJson(req, res, 200, { ok: true });
  });

  const stopProcess = (req, res, body) => guarded(req, res, body, 'stop-process', async ({ done, csrf, confirm }) => {
    const e = entryOf(body.id);
    if (!e) throw new Refuse(404, 'unknown project');
    if (!Number.isInteger(body.pid) || body.pid <= 0) throw new Refuse(400, 'bad pid');
    if (body.pid === process.pid) throw new Refuse(403, 'protected');
    if (typeof body.created !== 'string' || body.created === '') throw new Refuse(400, 'bad created');
    const snap = await refreshSnapshot(); // never the cached one: pid and start time are checked against now
    const value = snap?.value;
    if (!value || !Array.isArray(value.processes)) throw new Refuse(502, 'process list unavailable');
    const proc = value.processes.find((p) => p.pid === body.pid);
    if (!proc) throw new Refuse(404, 'no such process');
    if (proc.created !== body.created) throw new Refuse(409, 'process changed');
    // the same roots /api/live matched with (home + repos + discovered worktrees); the registry's own roots when the scan has no entry
    let roots = rootsOf(e);
    try {
      const sp = readProjects?.()?.projects?.find((x) => x.id === e.id);
      if (sp && Array.isArray(sp.roots)) roots = sp.roots;
    } catch { /* no scan yet: registry roots */ }
    const mine = (matchProcesses(value, roots) ?? []).find((p) => p.pid === body.pid);
    if (!mine) throw new Refuse(403, "not this project's process");
    if (e.protected === true || isProtected(proc, getRegistry())) throw new Refuse(403, 'protected');
    if (proc.user == null) throw new Refuse(403, 'owner unknown');
    if (!sameUser(proc.user, currentUser(env))) throw new Refuse(403, 'not your process');
    // taskkill /T takes the whole tree down: every descendant must be as stoppable as the target itself
    const kids = descendantsOf(value.processes, proc);
    const me = currentUser(env);
    const reg = getRegistry();
    if (kids.some((k) => k.pid === process.pid || isProtected(k, reg) || k.user == null || !sameUser(k.user, me))) throw new Refuse(403, 'protected descendant');
    const detail = [maskText(proc.cmd ?? ''), mine.ports];
    if (kids.length) detail.push(`also stops: ${kids.map((k) => `${k.name} (${k.pid})`).join(', ')}`);
    if (handshake(req, res, csrf, confirm, `stop-process|${e.id}|${body.pid}|${body.created}`, `stop ${proc.name} (${body.pid})`, detail)) return;
    try { await killTree(body.pid); } catch (err) {
      const msg = maskText(String(err?.message ?? err));
      done('failed', { error: msg });
      sendJson(req, res, 502, { error: msg });
      return;
    }
    done('ok', { pid: body.pid, name: proc.name });
    sendJson(req, res, 200, { ok: true });
  });

  const rescanRoute = (req, res, body) => guarded(req, res, body, 'rescan', async ({ done }) => {
    if (typeof rescan !== 'function') throw new Refuse(503, 'scheduler disabled');
    if (isScanning()) throw new Refuse(409, 'scan already running');
    Promise.resolve().then(() => rescan(false)).catch((err) => console.error('rescan failed:', err?.message));
    done('ok', { full: false });
    sendJson(req, res, 200, { started: true });
  }, { noProject: true });

  const newProject = (req, res, body) => guarded(req, res, body, 'new-project', async ({ done, csrf, confirm }) => {
    if (!projectsDir || !vaultDir) throw new Refuse(503, 'new project not configured');
    const v = validateNewProject(body, { registry: getRegistry(), projectsDir, vaultDir });
    if (!v.ok) throw new Refuse(400, { error: `invalid: ${Object.keys(v.errors).join(', ')}`, errors: v.errors });
    const { slug, home, note } = v.value;
    if (handshake(req, res, csrf, confirm, `new-project|${slug}|${note}`, `create ${slug}`, [home, note])) return;
    let out;
    try { out = createProject(v.value, { now, registryFile }); } catch (err) {
      const msg = maskText(String(err?.message ?? err));
      done('failed', { error: msg, created: err.created ?? [] });
      sendJson(req, res, 500, { error: msg, created: err.created ?? [] });
      return;
    }
    if (typeof rescan === 'function') Promise.resolve().then(() => rescan(false)).catch((err) => console.error('rescan failed:', err?.message));
    done('ok', { id: out.id, home: out.home });
    sendJson(req, res, 201, out);
  }, { noProject: true });

  async function handler({ req, res, url, path, body }) {
    if (req.method === 'POST') {
      switch (path) {
        case '/api/actions/run': return run(req, res, body);
        case '/api/actions/open-local': return openLocal(req, res, body);
        case '/api/actions/stop-process': return stopProcess(req, res, body);
        case '/api/actions/rescan': return rescanRoute(req, res, body);
        case '/api/actions/new-project': return newProject(req, res, body);
        default: return false;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    switch (path) {
      case '/api/csrf': {
        const w = who(req);
        sendJson(req, res, 200, { ...tokens.issue(w.class, w.login), class: w.class });
        return true;
      }
      case '/api/audit': {
        const raw = url.searchParams.get('limit');
        const limit = raw === null || raw === '' ? 100 : Number(raw);
        sendJson(req, res, 200, listAudit(getDb(), { limit, project: url.searchParams.get('project') || null }));
        return true;
      }
      case '/api/actions': await list(req, res, url); return true;
      case '/api/actions/output': output(req, res, url); return true;
      case '/api/actions/files': files(req, res); return true;
      default: return false;
    }
  }
  handler.tokens = tokens;
  handler.runner = runner;
  return handler;
}
