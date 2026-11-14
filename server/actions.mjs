// Action routes: CSRF tokens, the audit trail, a rescan trigger, and new-project creation.
// Nothing from a request body reaches a command line.
import { sendJson } from './router.mjs';
import { listAudit, recordAction } from '../lib/audit.mjs';
import { maskText, maskSecrets } from '../lib/mask.mjs';
import { validateNewProject, createProject } from '../lib/new-project.mjs';
import { which as realWhich } from '../lib/which.mjs';
import { spawn as realSpawn } from 'node:child_process';

const ASK_MAX = 500; // characters in a question
const ASK_CAP = 64 * 1024; // bytes of graphify output kept, stdout and stderr together
const ASK_TIMEOUT_MS = 60_000;
const ASK_INFLIGHT = 2; // graphify runs at once, across all clients
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHIM = /\.(cmd|bat)$/i;
const SHIM_MSG = 'graphify not found (.cmd/.bat shims are not supported; install an .exe)';

class TimedOut extends Error {}
class ClientClosed extends Error {}

// Runs `<exe> query <question>` in cwd. Resolves { text, truncated, exitCode, killedAtCap }. Rejects on spawn error,
// timeout or abort(). The child is killed when the output cap is reached, on timeout, and on abort.
function runGraph({ spawn, exe, question, cwd, timeoutMs }) {
  let abortNow = () => {};
  const promise = new Promise((resolve, reject) => {
    let child;
    try { child = spawn(exe, ['query', question], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (err) { reject(err); return; }
    const chunks = [];
    let size = 0;
    let truncated = false;
    let killedAtCap = false;
    let settled = false;
    let timer = null;
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    timer = setTimeout(() => { kill(); finish(reject, new TimedOut('timed out')); }, timeoutMs);
    abortNow = () => { if (settled) return; kill(); finish(reject, new ClientClosed('client closed')); };
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = ASK_CAP - size;
      if (buf.length > room) {
        if (room > 0) chunks.push(buf.subarray(0, room));
        size = ASK_CAP;
        truncated = true;
        if (!killedAtCap) { killedAtCap = true; kill(); }
      } else { chunks.push(buf); size += buf.length; }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => finish(resolve, { text: Buffer.concat(chunks).toString('utf8'), truncated, exitCode: code ?? null, killedAtCap }));
  });
  return { promise, abort: () => abortNow() };
}

// A refusal: ends the request with this status and is audited as `refused`.
class Refuse extends Error {
  constructor(status, payload) { super(typeof payload === 'string' ? payload : 'refused'); this.status = status; this.payload = typeof payload === 'string' ? { error: payload } : payload; }
}

export function createActionRoutes({
  now = Date.now, getDb, getRegistry, tokens, who, rescan = null, isScanning = () => false,
  registryFile, projectsDir = null, vaultDir,
  askGraph = {},
}) {
  const { which: findExe = realWhich, spawn = realSpawn, command = 'graphify', readProjects = () => ({ projects: [] }), timeoutMs = ASK_TIMEOUT_MS } = askGraph;
  let askInFlight = 0;
  function audit(w, action, project, args, status, result, started) {
    try {
      recordAction(getDb(), { at: new Date(now()).toISOString(), who: `${w.class}:${w.login ?? ''}`, action, project, args, status, result, durationMs: now() - started });
    } catch (e) { console.error('audit write failed:', e.message); }
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

  // Ask a project's knowledge graph: `graphify query <question>` in the project home. Nothing spawns before every check passes.
  const askGraphRoute = (req, res, body) => guarded(req, res, body, 'ask-graph', async ({ done }) => {
    const q = body?.question;
    if (typeof q !== 'string' || q.length < 1 || q.length > ASK_MAX || CONTROL.test(q) || q.trimStart().startsWith('-')) throw new Refuse(400, 'bad question');
    let projects = [];
    try { projects = readProjects()?.projects ?? []; } catch { projects = []; }
    const p = projects.find((x) => x.id === body?.id);
    if (!p) throw new Refuse(404, 'unknown project');
    if (!p.home || !p.graph?.value) throw new Refuse(404, 'no graph');
    if (SHIM.test(command)) throw new Refuse(409, { error: SHIM_MSG });
    const exe = findExe(command);
    if (!exe) {
      if (findExe(command, { allowShims: true })) throw new Refuse(409, { error: SHIM_MSG });
      throw new Refuse(409, { error: 'graphify not found' });
    }
    if (SHIM.test(exe)) throw new Refuse(409, { error: SHIM_MSG });
    if (askInFlight >= ASK_INFLIGHT) throw new Refuse(429, { error: 'busy' });
    askInFlight += 1;
    const started = now();
    let out;
    try {
      const job = runGraph({ spawn, exe, question: q, cwd: p.home, timeoutMs });
      res.on('close', () => { if (!res.writableEnded) job.abort(); });
      out = await job.promise;
    } catch (err) {
      if (err instanceof ClientClosed) { done('failed', { error: 'client closed' }); return; }
      if (err instanceof TimedOut) {
        done('failed', { error: 'timed out' });
        sendJson(req, res, 504, { error: 'timed out' });
        return;
      }
      const msg = maskText(String(err?.message ?? err));
      done('failed', { error: msg });
      sendJson(req, res, 500, { error: msg });
      return;
    } finally { askInFlight -= 1; }
    const ms = now() - started;
    const answer = maskSecrets(out.text);
    const ok = out.exitCode === 0 || out.killedAtCap; // we stopped it at the cap: the answer is complete enough to show
    done(ok ? 'ok' : 'failed', { ms, truncated: out.truncated, exitCode: out.exitCode });
    sendJson(req, res, 200, { answer, truncated: out.truncated, ms, exitCode: out.exitCode });
  });

  async function handler({ req, res, url, path, body }) {
    if (req.method === 'POST') {
      switch (path) {
        case '/api/actions/rescan': return rescanRoute(req, res, body);
        case '/api/actions/new-project': return newProject(req, res, body);
        case '/api/actions/ask-graph': return askGraphRoute(req, res, body);
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
      default: return false;
    }
  }
  handler.tokens = tokens;
  return handler;
}
