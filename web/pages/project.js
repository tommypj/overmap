import { branchText, statusPill, h, enc, pill, unknownPill, bytes, ago, baseName, winPath, factNote, lastWork, isPhone } from '../ui.js';
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
  c.append(row('Size', p.size ? pill(`code ${bytes(p.size.code)}`) : unknownPill('size not measured'), p.size ? pill(`deps ${bytes(p.size.deps)}`) : null,
    h('span', { class: 'k inline' }, 'Last work'),
    lw.at == null ? unknownPill(p.repos?.length ? 'no commit date' : 'no repo') : pill(ago(lw.at))));
  return c;
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
