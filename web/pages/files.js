import { h, api, enc, bytes, ago, winPath, emptyNote, errorNote, pill, copyButton } from '../ui.js';
import { previewFile, kindOfName } from '../preview.js';

export const filesHash = (id, root, path) => '#/p/' + [enc(id), 'files', String(root), ...String(path).split('/').filter(Boolean).map(enc)].join('/');

const ICON = { dir: '📁', image: '🖼', video: '🎬', audio: '♪', pdf: '📕', markdown: '📝', office: '📊', text: '📄' };

export async function renderFiles(el, { p, rest, winRoot }) {
  const roots = p.roots || [];
  if (!roots.length) { el.append(emptyNote('This project has no readable folder.')); return; }
  const root = /^\d+$/.test(rest[0] ?? '') ? Number(rest[0]) : 0;
  const segs = rest.slice(1);
  let path = segs.join('/');
  let selected = null;

  let r = await api(`api/ls?id=${enc(p.id)}&root=${root}&path=${enc(path)}`);
  if (r.error && segs.length) {
    // not a folder: treat the last segment as a file and list its parent
    selected = segs[segs.length - 1];
    path = segs.slice(0, -1).join('/');
    r = await api(`api/ls?id=${enc(p.id)}&root=${root}&path=${enc(path)}`);
  }

  const picker = h('select', { class: 'rootpick', 'aria-label': 'Root folder' }, ...roots.map((rp, i) => h('option', { value: String(i), selected: i === root }, `${i === 0 ? 'Home' : 'Root ' + i}  ${winPath(rp)}`)));
  picker.addEventListener('change', () => { location.hash = filesHash(p.id, picker.value, ''); });

  const crumbs = h('div', { class: 'crumb mono' }, h('a', { href: filesHash(p.id, root, '') }, winPath(roots[root] ?? '')));
  let acc = '';
  for (const s of path.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.append(' › ', h('a', { href: filesHash(p.id, root, acc) }, s));
  }
  el.append(h('div', { class: 'filebar' }, picker, copyButton(winPath(roots[root] + (path ? '/' + path : '')), 'Copy path')), crumbs);

  if (r.error) { el.append(errorNote(r.error)); return; }
  const entries = [...r.data.entries].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const join = (name) => (path ? `${path}/${name}` : name);
  const panel = h('div', { class: 'previewpanel' });
  const show = (e) => {
    panel.replaceChildren(h('div', { class: 'phead' }, h('strong', null, e.name), h('button', { class: 'btn', type: 'button', on: { click: () => panel.replaceChildren() } }, 'Close')),
      previewFile({ id: p.id, root, path: join(e.name), name: e.name, rootPath: roots[root], size: e.size }));
    panel.scrollIntoView({ block: 'nearest' });
  };

  const tbody = h('tbody');
  if (path) tbody.append(h('tr', null, h('td', { colspan: '4' }, h('a', { href: filesHash(p.id, root, path.split('/').slice(0, -1).join('/')) }, '← up one folder'))));
  for (const e of entries) {
    const kind = e.dir ? 'dir' : kindOfName(e.name);
    const tr = h('tr', { class: (e.dep ? 'dep ' : '') + (selected === e.name ? 'sel' : '') });
    const nameCell = e.dir
      ? h('a', { href: filesHash(p.id, root, join(e.name)) }, e.name)
      : h('span', { class: 'fname', tabindex: '0', title: 'Double-click to preview' }, e.name);
    tr.append(h('td', null, h('span', { class: 'ico' }, ICON[kind] ?? '📄'), ' ', nameCell, e.dep ? h('span', { class: 'age' }, ' dependencies') : null),
      h('td', null, e.mtime ? ago(e.mtime) : 'unknown'), h('td', { class: 'num' }, e.dir ? '' : bytes(e.size)),
      h('td', null, e.dir ? null : h('button', { class: 'btn small', type: 'button', on: { click: () => show(e) } }, 'Preview')));
    if (!e.dir) {
      tr.addEventListener('dblclick', () => show(e));
      nameCell.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') show(e); });
    }
    tbody.append(tr);
    if (selected === e.name) queueMicrotask(() => show(e));
  }
  el.append(h('div', { class: 'tablewrap' }, h('table', { class: 'grid-table files' },
    h('thead', null, h('tr', null, ...['Name', 'Modified', 'Size', ''].map((t) => h('th', null, t)))), tbody)));
  if (!entries.length) el.append(emptyNote('Empty folder.'));
  if (r.data.truncated) el.append(h('p', { class: 'note warn' }, 'Listing truncated: this folder has more entries than the cockpit shows.'));
  el.append(h('p', { class: 'muted small' }, 'Double-click a file (or press Preview) to look at it here. Office files: Download or Copy path.'), panel);
}
