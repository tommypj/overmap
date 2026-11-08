// File preview shared by Files, Documents and the media lightbox.
import { renderMarkdown } from './md.js';
import { h, fileUrl, winPath, copyButton, errorNote, bytes } from './ui.js';

const EXT = {
  image: 'png jpg jpeg gif webp avif',
  video: 'mp4 webm mov m4v',
  audio: 'mp3 wav m4a ogg flac',
  markdown: 'md',
  pdf: 'pdf',
  office: 'doc docx xls xlsx ppt pptx odt csv',
  text: 'txt json yaml yml toml log ts tsx js mjs py php css html sql sh ps1 svg',
};
const KIND = new Map();
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND.set(e, k);

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}
export function kindOfName(name) { return KIND.get(extOf(name)) || 'other'; }

export const PREVIEW_CAP = 512 * 1024;

// Resolve a relative link found in a markdown file at `filePath` (rel to the root) to a path in the same root.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function resolveRelPath(filePath, rel) {
  const clean = rel.split('#')[0].split('?')[0];
  const parts = filePath.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(safeDecode(seg));
  }
  return parts.join('/');
}

export function previewFile({ id, root, path, name, rootPath, size }) {
  const kind = kindOfName(name);
  const url = fileUrl(id, root, path);
  const box = h('div', { class: 'preview' });
  const full = rootPath ? winPath(`${rootPath}/${path}`) : winPath(path);
  const foot = h('div', { class: 'pfoot' },
    h('span', { class: 'mono pathtext', title: full }, full),
    size != null ? h('span', { class: 'age' }, bytes(size)) : null,
    copyButton(full), h('a', { class: 'btn', href: url, download: name }, 'Download'));
  const body = h('div', { class: 'pbody' });
  box.append(body, foot);

  if (kind === 'image') body.append(h('img', { class: 'pimg', src: url, alt: name }));
  else if (kind === 'video') body.append(h('video', { class: 'pmedia', src: url, controls: true, preload: 'metadata' }));
  else if (kind === 'audio') body.append(h('audio', { class: 'paudio', src: url, controls: true, preload: 'metadata' }));
  else if (kind === 'pdf') body.append(h('iframe', { class: 'pframe', src: url, title: name }));
  else if (kind === 'markdown' || kind === 'text') loadText(body, url, kind, { id, root, path });
  else body.append(h('p', { class: 'muted' }, kind === 'office'
    ? 'Office files open in their Windows app. Use Download, or Copy path and open it on the laptop.'
    : 'No preview for this file type. Use Download or Copy path.'));
  return box;
}

async function loadText(body, url, kind, { id, root, path }) {
  body.append(h('p', { class: 'muted' }, 'Loading...'));
  try {
    const r = await fetch(url, { headers: { Range: `bytes=0-${PREVIEW_CAP - 1}` } });
    if (r.status === 416 && /^bytes \*\/0$/.test(r.headers.get('content-range') || '')) {
      body.replaceChildren(h('p', { class: 'muted' }, 'Empty file (0 bytes).'));
      return;
    }
    if (!r.ok && r.status !== 206) { body.replaceChildren(errorNote(`HTTP ${r.status}`)); return; }
    const text = await r.text();
    body.replaceChildren();
    const m = (r.headers.get('content-range') || '').match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    const truncated = r.status === 206 && (m && m[3] !== '*' ? Number(m[3]) > Number(m[2]) + 1 : true);
    if (truncated) {
      body.append(h('p', { class: 'note warn' }, `Showing the first ${bytes(PREVIEW_CAP)}. File truncated; use Download for the rest.`));
    }
    if (text.includes('\u0000')) { body.append(h('p', { class: 'muted' }, 'Binary content; no text preview.')); return; }
    if (kind === 'markdown') {
      const md = h('div', { class: 'md' });
      md.innerHTML = renderMarkdown(text, {
        resolveRel: (rel) => {
          const target = resolveRelPath(path, rel);
          return target == null ? '#' : fileUrl(id, root, target);
        },
      });
      body.append(md);
    } else body.append(h('pre', { class: 'ptext' }, text));
  } catch (e) {
    body.replaceChildren(errorNote(e.message));
  }
}
