// Confined, read-only filesystem access for the cockpit API.
import { readdirSync, statSync, realpathSync, createReadStream, readFileSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { pipeline } from 'node:stream';
import { norm, isUnder, isSecretName, DEP_DIRS } from '../lib/paths.mjs';

export class Forbidden extends Error {
  constructor(msg = 'forbidden') { super(msg); this.name = 'Forbidden'; this.status = 403; }
}
export class BadRequest extends Error {
  constructor(msg = 'bad request') { super(msg); this.name = 'BadRequest'; this.status = 400; }
}
export class NotFound extends Error {
  constructor(msg = 'not found') { super(msg); this.name = 'NotFound'; this.status = 404; }
}

const EXT_KIND = {
  image: 'png jpg jpeg gif webp svg avif',
  video: 'mp4 webm mov m4v',
  audio: 'mp3 wav m4a ogg flac',
  markdown: 'md',
  pdf: 'pdf',
  office: 'doc docx xls xlsx ppt pptx odt csv',
  text: 'txt json yaml yml toml log ts tsx js mjs py php css html sql sh ps1',
};
const KIND_BY_EXT = new Map();
for (const [kind, exts] of Object.entries(EXT_KIND)) for (const e of exts.split(' ')) KIND_BY_EXT.set(e, kind);

const extOf = (name) => extname(name).slice(1).toLowerCase();
export const kindOf = (name) => KIND_BY_EXT.get(extOf(name)) ?? 'other';

const TEXT = 'text/plain; charset=utf-8';
const CONTENT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: TEXT, log: TEXT, csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  yaml: TEXT, yml: TEXT, toml: TEXT, ts: TEXT, tsx: TEXT, py: TEXT, php: TEXT, sql: TEXT, sh: TEXT, ps1: TEXT,
};
const ACTIVE_TYPES = new Set(['svg', 'html', 'htm', 'xhtml', 'xml', 'js', 'mjs', 'cjs', 'css']); // never served as active content from /api/file
export function contentTypeOf(name, { safe = true } = {}) {
  const e = extOf(name);
  if (safe && ACTIVE_TYPES.has(e)) return TEXT;
  return CONTENT_TYPES[e] ?? 'application/octet-stream';
}

const hidden = (name) => name.toLowerCase() === '.git' || isSecretName(name);

export function resolveSafe(roots, rootIndex, rel) {
  if (!Number.isInteger(rootIndex) || rootIndex < 0 || rootIndex >= roots.length) throw new Forbidden('bad root');
  if (typeof rel !== 'string' || rel.includes('\0')) throw new Forbidden('bad path');
  const slashed = rel.replaceAll('\\', '/');
  if (slashed.startsWith('/') || /^[a-z]:/i.test(slashed)) throw new Forbidden('absolute path');
  const segs = slashed.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new Forbidden('parent segment');
  if (segs.some((s) => s.toLowerCase() === '.git')) throw new Forbidden('.git is hidden');
  if (segs.some((s) => s.includes(':') || s.endsWith('.') || s.endsWith(' '))) throw new Forbidden('unsupported name');
  if (segs.some((s) => isSecretName(s))) throw new Forbidden('secret file');
  const root = roots[rootIndex];
  const target = join(root, ...segs);
  let realRoot;
  let realTarget;
  try { realRoot = realpathSync.native(root); } catch { throw new NotFound('root missing'); }
  try { realTarget = realpathSync.native(target); } catch { throw new NotFound(); }
  if (!isUnder(norm(realTarget), norm(realRoot))) throw new Forbidden('outside root');
  // Re-check the canonical names: realpath expands 8.3 short names and fixes case.
  for (const seg of relative(realRoot, realTarget).split(/[/\\]/)) {
    if (seg && hidden(seg)) throw new Forbidden('hidden file');
  }
  return realTarget;
}

export function listDir(abs, { cap = 2000 } = {}) {
  const dirents = readdirSync(abs, { withFileTypes: true }).filter((d) => !hidden(d.name));
  const rows = dirents.map((d) => {
    let st = null;
    try { st = statSync(join(abs, d.name)); } catch { /* dangling link, stat race */ }
    const dir = st ? st.isDirectory() : d.isDirectory();
    return {
      name: d.name,
      dir,
      size: dir || !st ? null : st.size,
      mtime: st ? st.mtime.toISOString() : null,
      kind: dir ? 'dir' : kindOf(d.name),
      dep: DEP_DIRS.has(d.name),
    };
  });
  rows.sort((x, y) => (x.dir === y.dir ? x.name.toLowerCase().localeCompare(y.name.toLowerCase()) : x.dir ? -1 : 1));
  const truncated = rows.length > cap;
  return { entries: truncated ? rows.slice(0, cap) : rows, truncated };
}

const INDEX_KINDS = {
  media: new Set(['image', 'video', 'audio']),
  docs: new Set(['markdown', 'pdf', 'office']),
};

export function indexFiles(roots, kind, { cap = 5000 } = {}) {
  const wanted = INDEX_KINDS[kind];
  if (!wanted) throw new Error(`unknown index kind ${kind}`);
  const files = [];
  let truncated = false;
  outer: for (let r = 0; r < roots.length; r++) {
    const stack = [[roots[r], '']];
    while (stack.length) {
      const [dir, rel] = stack.pop();
      let dirents;
      try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (d.name.toLowerCase() === '.git' || DEP_DIRS.has(d.name) || isSecretName(d.name)) continue;
          stack.push([join(dir, d.name), childRel]);
        } else if (d.isFile()) {
          if (isSecretName(d.name)) continue;
          const k = kindOf(d.name);
          if (!wanted.has(k)) continue;
          if (files.length >= cap) { truncated = true; break outer; }
          let st = null;
          try { st = statSync(join(dir, d.name)); } catch { /* vanished */ }
          files.push({ root: r, path: childRel, name: d.name, size: st?.size ?? null, mtime: st ? st.mtime.toISOString() : null, kind: k });
        }
      }
    }
  }
  return { files, truncated };
}

// Single-range header. Returns {start,end} | 'unsatisfiable' | null (ignore the header).
export function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (start >= total || start > end) return 'unsatisfiable';
  return { start, end };
}

const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/, /"private_key"\s*:/, /refresh_token/, /pcp_(board|agent)_[A-Za-z0-9]/,
  /sk-ant-[A-Za-z0-9_-]{20}/, /gh[pousr]_[A-Za-z0-9]{30}/, /AKIA[0-9A-Z]{16}/, /xoxb-|xoxp-/,
];
const CONTENT_SCAN_MAX = 1024 * 1024;

// Text-ness is decided by bytes, not extension: no NUL in the first 8 KiB (or a UTF-16 BOM) means text.
function textOf(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  if (body.subarray(0, 8192).includes(0)) return null;
  return body.toString('latin1');
}

export function sendFile(req, res, abs, { safeTypes = true, disposition = true, cacheControl, checkSecrets = true } = {}) {
  let st;
  try { st = statSync(abs); } catch { throw new NotFound(); }
  if (!st.isFile()) throw new NotFound('not a file');
  const total = st.size;
  const name = basename(abs);
  const headers = {
    'content-type': contentTypeOf(name, { safe: safeTypes }),
    'accept-ranges': 'bytes',
    'last-modified': st.mtime.toUTCString(),
  };
  if (disposition) headers['content-disposition'] = `inline; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`;
  if (cacheControl) headers['cache-control'] = cacheControl;
  if (checkSecrets && total <= CONTENT_SCAN_MAX) {
    let buf;
    try { buf = readFileSync(abs); } catch { throw new NotFound(); }
    const text = textOf(buf);
    if (text !== null && SECRET_CONTENT.some((re) => re.test(text))) throw new Forbidden('file looks like it holds a secret');
  }
  let status = 200;
  let range = null;
  if (req.headers.range) {
    const r = parseRange(req.headers.range, total);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${total}`, 'content-length': 0 });
      res.end();
      return;
    }
    if (r) { range = r; status = 206; headers['content-range'] = `bytes ${r.start}-${r.end}/${total}`; }
  }
  const length = range ? range.end - range.start + 1 : total;
  headers['content-length'] = length;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || length === 0) { res.end(); return; }
  const stream = createReadStream(abs, range ? { start: range.start, end: range.end } : {});
  pipeline(stream, res, () => { /* client abort or read error: pipeline destroys both */ });
}
