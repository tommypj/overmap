import { api, branchText, statusPill, h, enc, pill, unknownPill, bytes, ago, baseName, winPath, factNote, lastWork, isPhone } from '../ui.js';
import { runFlow, postAction, outputPanel, stateText, statePillClass } from '../actions.js';
import { backupSummary } from './overview.js';
import { renderDev } from './dev.js';
import { renderFiles } from './files.js';
import { renderMedia } from './media.js';
import { renderDocs } from './docs.js';
import { renderLive } from './live.js';

const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : null);

function repoPill(r) {
  const name = baseName(r.path);
  const f = r.git;
  if (!f || f.error || !f.value) return pill(`${name} · unknown (${f?.error || 'not scanned'})`, 'risk');
  const v = f.value;
  const remotesUnknown = v.remotes == null;
  const noRemote = Array.isArray(v.remotes) && v.remotes.length === 0;
  const unpushed = v.localOnlyCommits == null ? 'unpushed unknown' : `${v.localOnlyCommits} unpushed`;
  const bits = [name, branchText(v), remotesUnknown ? 'remotes unknown' : (noRemote ? 'no remote' : unpushed)];
  return pill(bits.join(' · '), noRemote ? 'risk' : (remotesUnknown ? 'unknown' : v.localOnlyCommits == null || v.localOnlyCommits > 0 ? 'warn' : ''));
}

function findUsed(text, projects) {
  const name = text.split('#')[0].trim();
  const key = name.toLowerCase();
  const hit = projects.find((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key || (p.noteId || '').toLowerCase() === key);
  return { name, hit };
}

function card(p, data) {
  const lw = lastWork(p);
  const repoAges = (p.repos || []).map((r) => r.git?.at).filter(Boolean).sort();
  const row = (label, ...kids) => h('div', { class: 'row' }, h('span', { class: 'k' }, label), h('span', { class: 'rowbody' }, ...kids));
  const c = h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h1', null, p.name), statusPill(p.status, 'status')),
    p.summary ? h('p', { class: 'summary' }, p.summary) : h('p', { class: 'muted' }, 'No summary in the vault note.'));

  c.append(row('Repos',
    (p.repos || []).length ? (p.repos).map(repoPill) : h('span', { class: 'muted' }, 'no repo'),
    repoAges.length ? factNote({ at: repoAges[0] }) : null));

  const deploy = (p.deploy || []).map((d) => pill(d));
  const links = (p.links || []).map((l) => (safeHref(l) ? h('a', { class: 'pill link', href: l, target: '_blank', rel: 'noopener noreferrer' }, l.replace(/^https?:\/\//, '') + ' ↗') : pill(l)));
  c.append(row('Runs on', deploy.length || links.length ? [deploy, links] : h('span', { class: 'muted' }, 'nothing recorded')));

  if ((p.uses || []).length) {
    c.append(row('Uses', p.uses.map((u) => {
      const { name, hit } = findUsed(u, data.projects);
      return hit ? h('a', { class: 'pill link', href: '#/p/' + enc(hit.id), title: u }, hit.name) : pill(name, '');
    })));
  }
  const b = backupSummary(p);
  c.append(row('Backup', pill(b.text, b.cls), factNote(p.backup)));
  c.append(row('Size', p.size ? pill(`code ${bytes(p.size.code)}`) : unknownPill('size not measured'), p.size ? pill(`deps ${bytes(p.size.deps)}`) : null,
    h('span', { class: 'k inline' }, 'Last work'),
    lw.at == null ? unknownPill(p.repos?.length ? 'no commit date' : 'no repo') : pill(ago(lw.at))));
  const bar = h('div', { class: 'actions' });
  c.append(bar);
  actionsBar(p, bar);
  return c;
}

// Actions bar: Open-in buttons (laptop only) and one row per declared action (Start/Stop/Restart/Output).
const OPEN_IN = [['explorer', 'Explorer'], ['vscode', 'VS Code'], ['terminal', 'Terminal'], ['claude', 'Claude']];

export async function actionsBar(p, el) {
  const panels = new Map(); // action id -> open outputPanel, kept across re-renders
  const flash = (row, text) => {
    row.querySelector('.note.risk')?.remove();
    const n = h('p', { class: 'note risk' }, text);
    row.append(n);
    setTimeout(() => n.remove(), 6000);
  };
  const run = async (row, a, op, btn) => {
    if (btn) btn.disabled = true;
    const r = await runFlow({ path: 'api/actions/run', body: { id: p.id, action: a.id, op }, title: `${op} ${a.label}` });
    await load(); // re-render with fresh state either way
    const fresh = el.querySelector(`[data-act="${a.id}"]`);
    fresh?.querySelector('button')?.focus(); // the sheet gave focus back to a node that no longer exists
    if (r.error && !r.cancelled) flash(fresh ?? el, r.error);
  };
  const openLocal = async (what, holder) => {
    const r = await postAction('api/actions/open-local', { id: p.id, what });
    if (r.error) flash(holder, r.error);
  };

  function actionRow(a) {
    const st = a.state;
    const running = st?.status === 'running';
    const row = h('div', { class: 'actwrap', 'data-act': a.id });
    const line = h('div', { class: 'actrow' },
      h('span', { class: 'lbl' }, a.label),
      a.cmd ? h('span', { class: 'mono clip', title: a.cmd }, a.cmd) : null,
      h('span', { class: 'stat' }, a.error ? pill(a.error, 'warn') : pill(stateText(st), statePillClass(st)),
        a.port != null ? (a.portOpen == null ? null : pill(`:${a.port} ${a.portOpen ? 'open' : 'closed'}`, a.portOpen ? 'ok' : '')) : null,
        ));
    if (!a.error) {
      const btns = h('span', { class: 'btns' });
      if (!running) btns.append(h('button', { class: 'btn', type: 'button', on: { click: (e) => run(row, a, 'start', e.currentTarget) } }, 'Start'));
      else btns.append(h('button', { class: 'btn danger', type: 'button', on: { click: (e) => run(row, a, 'stop', e.currentTarget) } }, 'Stop'),
        h('button', { class: 'btn', type: 'button', on: { click: (e) => run(row, a, 'restart', e.currentTarget) } }, 'Restart'));
      if (st) {
        btns.append(h('button', { class: 'btn', type: 'button', on: { click: () => {
          const open = panels.get(a.id);
          if (open) { open.stop(); open.remove(); panels.delete(a.id); return; }
          const panel = outputPanel(p.id, a.id, { onState: (s) => { if ((s?.status ?? null) !== (a.state?.status ?? null)) { a.state = s; load(); } } });
          panels.set(a.id, panel);
          row.append(panel);
        } } }, 'Output'));
      }
      line.append(btns);
    }
    row.append(line);
    if (panels.has(a.id)) row.append(panels.get(a.id));
    return row;
  }

  async function load() {
    const [ar, who] = await Promise.all([api(`api/actions?id=${enc(p.id)}`), api('api/whoami')]);
    if (!el.isConnected) { for (const pn of panels.values()) pn.stop(); return; }
    el.replaceChildren();
    if (ar.error) { el.append(h('p', { class: 'note risk' }, `Actions unknown (${ar.error})`)); return; }
    const d = ar.data || {};
    const body = h('div', { class: 'actbody' });
    const local = d.local || {};
    if (local.available) {
      const holder = h('div', { class: 'actwrap' });
      holder.append(h('div', { class: 'row' }, h('span', { class: 'k' }, 'Open in'),
        OPEN_IN.map(([what, label]) => h('button', { class: 'btn', type: 'button', on: { click: () => openLocal(what, holder) } }, label))));
      body.append(holder);
    } else {
      body.append(h('p', { class: 'muted small' }, local.why ?? `Open-in buttons work on the laptop only${who.data?.class ? ` (you are on ${who.data.class})` : ''}.`));
    }
    if (d.error) body.append(h('p', { class: 'note risk' }, `${d.error} (see actions/README.md in the cockpit folder)`));
    for (const a of d.actions || []) body.append(actionRow(a));
    el.append(body);
  }
  await load();
}

export async function renderProject(el, ctx) {
  const [, id, tabRaw, ...rest] = ctx.route;
  const p = ctx.data?.projects.find((x) => x.id === id);
  if (!p && ctx.error) {
    el.append(h('h1', null, 'Project'), h('p', { class: 'note risk' }, `unknown (${ctx.error})`));
    return;
  }
  if (!p) {
    el.append(h('h1', null, 'Unknown project'), h('p', null, `No project with id "${id}". `, h('a', { href: '#/' }, 'Back to the overview')));
    return;
  }
  const tab = ['dev', 'files', 'media', 'docs', 'live'].includes(tabRaw) ? tabRaw : 'dev';
  el.append(card(p, ctx.data));
  const base = '#/p/' + enc(p.id) + '/';
  const t = (key, label) => h('a', { class: 'tab' + (tab === key ? ' on' : ''), href: base + key }, label);
  el.append(h('nav', { class: 'tabs', 'aria-label': 'Project tabs' },
    t('dev', isPhone() ? 'Dev' : 'Development'), t('files', 'Files'), t('media', 'Media'), t('docs', isPhone() ? 'Docs' : 'Documents'),
    t('live', 'Live')));
  const body = h('div', { class: 'tabbody' });
  el.append(body);
  const sub = { p, ctx, rest, winRoot: (n) => winPath(p.roots?.[n] ?? '') };
  if (tab === 'dev') await renderDev(body, sub);
  else if (tab === 'files') await renderFiles(body, sub);
  else if (tab === 'live') await renderLive(body, sub);
  else if (tab === 'media') await renderMedia(body, sub);
  else await renderDocs(body, sub);
}
