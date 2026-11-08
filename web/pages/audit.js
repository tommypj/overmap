import { h, api, enc, pill, ago, dateText, emptyNote, errorNote } from '../ui.js';

const STATUS_CLS = { ok: '', refused: 'warn', failed: 'risk' };

function argsText(args) {
  let o = args;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return o; } }
  if (o == null || typeof o !== 'object') return o == null ? '' : String(o);
  return Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

function resultText(r) {
  let o = r;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return o; } }
  if (o == null || typeof o !== 'object') return o == null ? '' : String(o);
  if (o.error) return String(o.error);
  return [o.status, o.pid != null ? `pid ${o.pid}` : null].filter(Boolean).join(' ');
}

export function durationText(row) {
  return row?.durationMs == null ? 'unknown' : `${row.durationMs} ms`;
}

export async function renderAudit(el, ctx) {
  el.append(h('h1', null, 'Actions log'));
  const projects = ctx.data?.projects ?? [];
  const filter = h('select', { id: 'audit-project' }, h('option', { value: '' }, 'all projects'),
    ...projects.map((p) => h('option', { value: p.id }, p.id)));
  filter.value = ctx.route[1] ?? '';
  const body = h('div', null, emptyNote('Loading...'));
  el.append(h('div', { class: 'row' }, h('label', { for: 'audit-project', class: 'k' }, 'Project'), filter), body);

  let seq = 0;
  async function load() {
    const mine = ++seq;
    const project = filter.value;
    const r = await api('api/audit?limit=200' + (project ? '&project=' + enc(project) : ''));
    if (ctx.stale() || mine !== seq) return;
    body.replaceChildren();
    if (r.error) { body.append(errorNote(r.error)); return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) { body.append(emptyNote('Nothing has been run from the page yet.')); return; }
    body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'grid-table' },
      h('thead', null, h('tr', null, ...['When', 'Who', 'Action', 'Project', 'Args', 'Result', 'Duration'].map((t) => h('th', null, t)))),
      h('tbody', null, ...rows.map((x) => {
        const args = argsText(x.args);
        const res = resultText(x.result);
        return h('tr', null,
          h('td', { title: x.at ?? '' }, dateText(x.at), ' ', h('span', { class: 'age' }, ago(x.at))),
          h('td', null, x.who ?? 'unknown'),
          h('td', null, x.action ?? 'unknown'),
          h('td', null, x.project ?? ''),
          h('td', { class: 'mono clip', title: typeof x.args === 'string' ? x.args : JSON.stringify(x.args ?? null) }, args),
          h('td', null, pill(x.status ?? 'unknown', STATUS_CLS[x.status] ?? 'unknown'), res ? h('span', { class: 'mono' }, ' ' + res) : null),
          h('td', { class: 'num' }, durationText(x)));
      })))));
  }
  filter.addEventListener('change', load);
  await load();
}
