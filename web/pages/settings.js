import { h, api, ago, dateText, pill } from '../ui.js';
import { runFlow } from '../actions.js';

export async function renderSettings(el, ctx) {
  el.append(h('h1', null, 'Settings'));
  const [who, set, conns] = await Promise.all([api('api/whoami'), api('api/settings'), api('api/connectors')]);
  if (ctx.stale()) return;
  const row = (k, v) => h('div', { class: 'row' }, h('span', { class: 'k wide' }, k), h('span', { class: 'rowbody mono' }, v));
  const unk = (r) => `unknown (${r.error})`;
  el.append(h('section', { class: 'blk' }, h('h3', null, 'This connection'),
    who.error ? row('Access class', unk(who)) : row('Access class', who.data.class),
    who.error ? null : row('Signed in as', who.data.login ?? 'not applicable on the laptop')));
  if (set.error) {
    el.append(h('section', { class: 'blk' }, h('h3', null, 'Cockpit'), h('p', { class: 'muted' }, unk(set))));
  } else {
    const s = set.data;
    const last = s.lastScan ? (s.lastScan.at ?? s.lastScan) : null;
    el.append(
      h('section', { class: 'blk' }, h('h3', null, 'Secrets file', h('span', { class: 'age' }, `checked ${ago(s.secrets?.cachedAt)}`)),
        row('Health', s.secrets?.file ?? 'unknown'),
        row('Extra principals', s.secrets?.extra == null ? 'unknown' : (s.secrets.extra.length ? s.secrets.extra.join(', ') : 'none'))),
      h('section', { class: 'blk' }, h('h3', null, 'Configuration paths'),
        row('Vault projects', s.config?.vaultProjectsDir ?? 'unknown'),
        row('Architecture file', s.config?.architectureFile ?? 'unknown')),
      h('section', { class: 'blk' }, h('h3', null, 'Scanning'),
        row('Last scan recorded', last ? `${dateText(last)} (${ago(last)})` : 'unknown (no scan recorded yet)'),
        row('Snapshot generated', ctx.data ? `${dateText(ctx.data.generatedAt)} (${ago(ctx.data.generatedAt)})` : 'unknown'),
        row('Scan duration', ctx.data?.scanSeconds == null ? 'unknown' : `${ctx.data.scanSeconds} s`),
        rescanRow()));
  }
  el.append(connectorsSection(conns));
}

function rescanRow() {
  const msg = h('span', { class: 'muted' });
  const btn = h('button', { class: 'btn', type: 'button' }, 'Rescan now');
  let timer = null;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const r = await runFlow({ path: 'api/actions/rescan', body: {}, title: 'Rescan' });
    btn.disabled = false;
    msg.textContent = r.cancelled ? '' : (r.error ? ` ${r.error}` : ' started');
    clearTimeout(timer);
    timer = setTimeout(() => { msg.textContent = ''; }, 6000);
  });
  return h('div', { class: 'row' }, h('span', { class: 'k wide' }, 'Scan now'), h('span', { class: 'rowbody' }, btn, msg));
}

const STATUS = {
  ok: ['ok', ''],
  error: ['error', 'risk'],
  not_configured: ['not configured', 'warn'],
  never_ran: ['never ran', 'unknown'],
};

// Connector x project table: status pill, last run age, last error or the exact missing names. Renders with zero runs.
export function connectorsSection(conns) {
  const head = h('h3', null, 'Connectors');
  if (conns.error) return h('section', { class: 'blk' }, head, h('p', { class: 'muted' }, `unknown (${conns.error})`));
  const rows = [];
  for (const c of conns.data ?? []) {
    const first = rows.length;
    for (const p of c.projects ?? []) {
      const [label, cls] = STATUS[p.status] ?? [p.status, 'unknown'];
      const detail = p.status === 'not_configured' ? `missing: ${(p.missing ?? []).join(', ')}` : (p.error ?? '');
      rows.push(h('div', { class: 'row' },
        h('span', { class: 'k wide' }, `${c.id} / ${p.project}`),
        h('span', { class: 'rowbody' }, pill(label, cls), detail ? h('span', { class: 'mono' }, ` ${detail}`) : null),
        h('span', { class: 'age', title: p.at || '' }, p.at ? `ran ${ago(p.at)}` : 'not run')));
    }
    if (rows.length > first && (c.note || c.discover)) {
      rows.push(h('div', { class: 'row' },
        h('span', { class: 'k wide' }, ''),
        h('span', { class: 'rowbody age' }, c.note ?? '', c.note && c.discover ? ' · ' : '',
          c.discover ? h('a', { href: 'api/connectors/discover?id=' + encodeURIComponent(c.id), target: '_blank', rel: 'noopener noreferrer' }, 'discover') : null)));
    }
  }
  return h('section', { class: 'blk' }, head, ...(rows.length ? rows : [h('p', { class: 'muted' }, 'No connectors have any project configured yet.')]));
}
