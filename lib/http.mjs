// Outbound HTTP for connectors: host allow-list, no redirects, hard timeout, GET by default.
import { maskText } from './mask.mjs';

export class HttpError extends Error {
  constructor(status, bodySnippet = '') {
    super(bodySnippet ? `HTTP ${status}: ${bodySnippet}` : `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

const UA = 'project-cockpit/stage2';
const MAX_BODY = 5 * 1024 * 1024;

// Streams the body and gives up (cancelling the stream) as soon as the running total passes the cap.
async function readCapped(res) {
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BODY) throw new HttpError(0, 'body too large');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* ignore */ } throw new HttpError(0, 'body too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export async function fetchJson(url, { headers = {}, method = 'GET', body, fetchImpl = fetch, timeoutMs = 20000, allowHosts = [] } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`scheme not allowed: ${u.protocol}`);
  if (!allowHosts.some((h) => String(h).toLowerCase() === u.host)) throw new Error(`host not allowed: ${u.host}`);
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs);
  });
  try {
    const run = (async () => {
      const res = await fetchImpl(u.href, { method, redirect: 'manual', signal: ac.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers }, ...(body === undefined ? {} : { body }) });
      const declared = Number(res.headers?.get?.('content-length'));
      if (declared > MAX_BODY) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new HttpError(0, 'body too large'); }
      const text = new TextDecoder().decode(await readCapped(res));
      if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, maskText(text).slice(0, 200));
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text };
    })();
    run.catch(() => {}); // a late rejection after the timeout won
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
