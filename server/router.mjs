// Request gate + dispatch. Every response gets the hardening headers; auth runs before routing.
import { classify, hostOk } from './auth.mjs';
import { Forbidden, NotFound, BadRequest } from './fsapi.mjs';
import { originOk, readJsonBody } from './body.mjs';

const CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'";

const LEGACY_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

export function stripPrefix(pathname) {
  if (pathname === '/projects' || pathname === '/projects/') return '/';
  return pathname.startsWith('/projects/') ? pathname.slice('/projects'.length) : pathname;
}

export function sendJson(req, res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export { BadRequest };

// FIN first so the client can read the 400 (an immediate destroy with unread input sends RST and can eat it), then force-close.
function closeSoon(req) {
  req.socket?.end();
  setTimeout(() => req.destroy(), 250).unref();
}

// routes: { get: async (ctx) => void } keyed by exact path or prefix handlers in `match`.
export function createHandler({ config, port, routes }) {
  return async function handle(req, res) {
    res.setHeader('x-robots-tag', 'noindex');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', CSP);
    try {
      if (!hostOk(req, port) || classify(req, config) === null) {
        sendJson(req, res, 403, { error: 'not allowed from here' });
        return;
      }
      let url;
      try { url = new URL(String(req.url).replace(/^\/{2,}/, '/'), 'http://localhost'); } catch { throw new BadRequest('bad url'); }
      const path = stripPrefix(url.pathname);
      if (path.startsWith('/api/')) res.setHeader('cache-control', 'no-store');
      if (path === '/legacy') res.setHeader('content-security-policy', LEGACY_CSP);
      let body;
      if (req.method === 'POST') {
        // POST exists only for actions; the origin is checked before a single body byte is read.
        if (!path.startsWith('/api/actions/')) {
          res.setHeader('allow', 'GET, HEAD');
          sendJson(req, res, 405, { error: 'method not allowed' });
          return;
        }
        if (!originOk(req, port)) {
          sendJson(req, res, 403, { error: 'bad origin' });
          return;
        }
        try { body = await readJsonBody(req); } catch (e) {
          // A rejected body is not read on: once the 400 is out, FIN and a forced close bound the leftover input.
          if (e instanceof BadRequest) { res.once('finish', () => closeSoon(req)); }
          throw e;
        }
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        sendJson(req, res, 405, { error: 'method not allowed' });
        return;
      }
      if (url.pathname === '/projects') {
        res.writeHead(308, { location: '/projects/' });
        res.end();
        return;
      }
      const handled = await routes({ req, res, url, path, config, body });
      if (handled === false) sendJson(req, res, 404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof Forbidden) sendJson(req, res, 403, { error: e.message });
      else if (e instanceof NotFound) sendJson(req, res, 404, { error: e.message });
      else if (e instanceof BadRequest) sendJson(req, res, 400, { error: e.message });
      else {
        console.error(`${req.method} ${req.url}:`, e);
        sendJson(req, res, 500, { error: 'internal error' });
      }
    }
  };
}
