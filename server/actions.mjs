// Action routes: CSRF tokens, the audit trail, a rescan trigger, and new-project creation.
// Nothing from a request body reaches a command line.
import { sendJson } from './router.mjs';
import { listAudit, recordAction } from '../lib/audit.mjs';
import { maskText } from '../lib/mask.mjs';
import { validateNewProject, createProject } from '../lib/new-project.mjs';

// A refusal: ends the request with this status and is audited as `refused`.
class Refuse extends Error {
  constructor(status, payload) { super(typeof payload === 'string' ? payload : 'refused'); this.status = status; this.payload = typeof payload === 'string' ? { error: payload } : payload; }
}

export function createActionRoutes({
  now = Date.now, getDb, getRegistry, tokens, who, rescan = null, isScanning = () => false,
  registryFile, projectsDir = null, vaultDir,
}) {
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

  async function handler({ req, res, url, path, body }) {
    if (req.method === 'POST') {
      switch (path) {
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
      default: return false;
    }
  }
  handler.tokens = tokens;
  return handler;
}
