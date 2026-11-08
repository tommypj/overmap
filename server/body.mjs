// POST body + origin checks. The body read is bounded: it stops at the limit instead of buffering the rest.
import { BadRequest } from './fsapi.mjs';

export function originOk(req, port) {
  const o = req.headers?.origin;
  return typeof o === 'string' && (o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}` || o === 'https://host.tail0000.ts.net'); // privacy-ok
}

export function readJsonBody(req, { limit = 65_536 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] ?? '').trim())) return reject(new BadRequest('content-type must be application/json'));
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > limit) return reject(new BadRequest('body too large'));
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => { if (done) return; done = true; req.removeAllListeners('data'); reject(e); };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail(new BadRequest('body too large'));
      chunks.push(c);
    });
    req.on('error', () => fail(new BadRequest('read error')));
    req.on('end', () => {
      if (done) return;
      done = true;
      let v;
      try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new BadRequest('invalid JSON')); }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new BadRequest('body must be a JSON object'));
      resolve(v);
    });
  });
}
