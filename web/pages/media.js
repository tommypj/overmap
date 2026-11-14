import { h, api, enc, fileUrl, ago, bytes, emptyNote, errorNote, pill } from '../ui.js';
import { previewFile, kindOfName, extOf } from '../preview.js';

const PAGE = 120;

export function openLightbox(p, f) {
  const lb = document.getElementById('lightbox');
  const close = () => {
    lb.hidden = true;
    lb.replaceChildren();
    lb.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const onBackdrop = (e) => { if (e.target === lb) close(); };
  const closeBtn = h('button', { class: 'btn', type: 'button', on: { click: close } }, 'Close');
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', f.name);
  lb.replaceChildren(h('div', { class: 'lbbar' }, h('strong', null, f.name), closeBtn),
    h('div', { class: 'lbbody' }, previewFile({ id: p.id, root: f.root, path: f.path, name: f.name, rootPath: p.roots?.[f.root], size: f.size })));
  lb.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  lb.hidden = false;
  closeBtn.focus();
}

// One observer per media tab: sources are attached only when a tile nears the viewport.
function makeLoader() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const el = e.target.querySelector('[data-src]');
      if (el) {
        if (el.tagName === 'VIDEO') el.setAttribute('preload', 'metadata');
        const done = () => el.classList.add('ready');
        el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', done, { once: true });
        el.addEventListener('error', () => el.classList.add('failed'), { once: true });
        el.setAttribute('src', el.dataset.src);
      }
    }
  }, { rootMargin: '200px' });
  return io;
}

function tile(p, f, io) {
  const kind = kindOfName(f.name);
  const url = fileUrl(p.id, f.root, f.path);
  let thumb;
  if (kind === 'image' && extOf(f.name) !== 'svg') thumb = h('img', { alt: f.name, decoding: 'async', 'data-src': url });
  else if (kind === 'video') thumb = h('video', { muted: true, playsinline: true, tabindex: '-1', 'data-src': url + '#t=0.5' });
  else thumb = h('span', { class: 'glyph' }, kind === 'audio' ? '♪' : extOf(f.name) || 'file');
  const t = h('button', { class: 'thumb', type: 'button', title: f.path, on: { click: () => openLightbox(p, f) } },
    h('span', { class: 'img ' + kind }, kind === 'video' || kind === 'image' ? h('span', { class: 'glyph ph' }, kind === 'video' ? '▶' : '') : null, thumb, kind === 'video' ? h('span', { class: 'playmark' }, '▶') : null),
    h('span', { class: 'cap' }, f.name));
  if (thumb.dataset?.src) io.observe(t);
  return t;
}

export async function renderMedia(el, { p, ctx }) {
  const holder = h('div', null, emptyNote('Indexing media files...'));
  el.append(holder);
  const r = await api(`api/index?id=${enc(p.id)}&kind=media`);
  if (ctx.stale()) return;
  holder.replaceChildren();
  if (r.error) { holder.append(errorNote(r.error)); return; }
  const files = r.data.files || [];
  const groups = [['all', 'All', () => true], ['image', 'Images', (f) => kindOfName(f.name) === 'image'], ['video', 'Video', (f) => kindOfName(f.name) === 'video'], ['audio', 'Audio', (f) => kindOfName(f.name) === 'audio']];
  const io = makeLoader();
  window.addEventListener('hashchange', () => io.disconnect(), { once: true });
  let cur = 'all', shown = PAGE;
  const filt = h('div', { class: 'filt' });
  const grid = h('div', { class: 'mgrid' });
  const more = h('div', { class: 'more' });
  const paint = () => {
    filt.replaceChildren(...groups.map(([k, label, fn]) => h('button', { class: 'pill chip' + (cur === k ? ' on' : ''), type: 'button', on: { click: () => { cur = k; shown = PAGE; paint(); } } }, `${label} ${files.filter(fn).length}`)));
    const fn = groups.find((g) => g[0] === cur)[2];
    const list = files.filter(fn).sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    io.disconnect();
    grid.replaceChildren(...list.slice(0, shown).map((f) => tile(p, f, io)));
    more.replaceChildren(list.length > shown ? h('button', { class: 'btn', type: 'button', on: { click: () => { shown += PAGE; paint(); } } }, `Show ${Math.min(PAGE, list.length - shown)} more (${list.length - shown} left)`) : null);
  };
  holder.append(h('p', { class: 'age' }, `indexed ${ago(r.data.at)}`), filt, grid, more);
  if (!files.length) holder.append(emptyNote('No images, video or audio found in this project.'));
  if (r.data.truncated) holder.append(h('p', { class: 'note warn' }, 'Index truncated: the project has more media files than Overmap lists.'));
  holder.append(h('p', { class: 'muted small' }, 'Click a thumbnail to play or open it full size.'));
  paint();
}
