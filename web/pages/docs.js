import { h, api, enc, ago, dateText, bytes, emptyNote, errorNote, winPath } from '../ui.js';
import { previewFile, kindOfName, extOf } from '../preview.js';

export const docHash = (id, root, path) => '#/p/' + [enc(id), 'docs', String(root), ...String(path).split('/').filter(Boolean).map(enc)].join('/');

const FILTERS = [
  ['all', 'All', () => true],
  ['markdown', 'Markdown', (f) => extOf(f.name) === 'md'],
  ['word', 'Word', (f) => ['doc', 'docx', 'odt'].includes(extOf(f.name))],
  ['ppt', 'PowerPoint', (f) => ['ppt', 'pptx'].includes(extOf(f.name))],
  ['excel', 'Excel', (f) => ['xls', 'xlsx', 'csv'].includes(extOf(f.name))],
  ['pdf', 'PDF', (f) => extOf(f.name) === 'pdf'],
  ['text', 'Text', (f) => kindOfName(f.name) === 'text'],
];
const ICON = { markdown: '📝', pdf: '📕', office: '📊', text: '📄' };
const PAGE = 200;

export async function renderDocs(el, { p, rest, ctx }) {
  if (rest.length >= 2 && /^\d+$/.test(rest[0])) {
    const root = Number(rest[0]);
    const path = rest.slice(1).join('/');
    const name = rest[rest.length - 1];
    el.append(h('p', null, h('a', { href: '#/p/' + enc(p.id) + '/docs' }, '← All documents')),
      h('h2', null, name),
      previewFile({ id: p.id, root, path, name, rootPath: p.roots?.[root] }));
    return;
  }
  const holder = h('div', null, emptyNote('Indexing documents...'));
  el.append(holder);
  const r = await api(`api/index?id=${enc(p.id)}&kind=docs`);
  if (ctx.stale()) return;
  holder.replaceChildren();
  if (r.error) { holder.append(errorNote(r.error)); return; }
  const files = r.data.files || [];
  let cur = 'all', shown = PAGE;
  const filt = h('div', { class: 'filt' });
  const tbody = h('tbody');
  const more = h('div', { class: 'more' });
  const paint = () => {
    filt.replaceChildren(...FILTERS.filter(([k, , fn]) => k === 'all' || files.some(fn)).map(([k, label, fn]) =>
      h('button', { class: 'pill chip' + (cur === k ? ' on' : ''), type: 'button', on: { click: () => { cur = k; shown = PAGE; paint(); } } }, `${label} ${files.filter(fn).length}`)));
    const fn = FILTERS.find((x) => x[0] === cur)[2];
    const list = files.filter(fn).sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
    tbody.replaceChildren(...list.slice(0, shown).map((f) => {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const title = f.name.replace(/\.[^.]+$/, '');
      return h('tr', { class: 'clickrow' },
        h('td', null, h('span', { class: 'ico' }, ICON[kindOfName(f.name)] ?? '📄'), ' ', h('a', { href: docHash(p.id, f.root, f.path), title: winPath(f.path) }, f.name === title ? f.name : f.name)),
        h('td', { class: 'mono clip' }, (f.root ? `[${f.root}] ` : '') + dir),
        h('td', { title: f.mtime }, f.mtime ? ago(f.mtime) : 'unknown'), h('td', { class: 'num' }, bytes(f.size)));
    }));
    more.replaceChildren(list.length > shown ? h('button', { class: 'btn', type: 'button', on: { click: () => { shown += PAGE; paint(); } } }, `Show more (${list.length - shown} left)`) : null);
  };
  holder.append(h('p', { class: 'age' }, `indexed ${ago(r.data.at)}`), filt,
    h('div', { class: 'tablewrap' }, h('table', { class: 'grid-table' }, h('thead', null, h('tr', null, ...['Document', 'Folder', 'Modified', 'Size'].map((t) => h('th', null, t)))), tbody)), more);
  if (!files.length) holder.append(emptyNote('No documents found in this project.'));
  if (r.data.truncated) holder.append(h('p', { class: 'note warn' }, 'Index truncated: the project has more documents than the cockpit lists.'));
  holder.append(h('p', { class: 'muted small' }, 'Markdown and PDF open as a preview here. Word, PowerPoint and Excel files can be downloaded or their path copied.'));
  paint();
}
