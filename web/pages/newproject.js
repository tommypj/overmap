import { h, api, enc } from '../ui.js';
import { runFlow } from '../actions.js';
import { slugify } from '../slug.js';

const POLL_MS = 3000;
const POLL_MAX_MS = 60_000;

export async function renderNewProject(el, ctx) {
  el.append(h('h1', null, 'New project'));
  const projects = ctx.data?.projects ?? [];
  const families = [...new Set(projects.filter((p) => p.kind === 'project' && p.group).map((p) => p.group))].sort();
  const parents = projects.filter((p) => p.kind === 'project').sort((a, b) => a.name.localeCompare(b.name));
  const shared = projects.filter((p) => p.kind === 'shared').sort((a, b) => a.name.localeCompare(b.name));

  const fieldNote = (name) => h('p', { class: 'note risk', hidden: true, 'data-field': name });
  const notes = { name: fieldNote('name'), family: fieldNote('family'), purpose: fieldNote('purpose'), branchesOff: fieldNote('branchesOff'), uses: fieldNote('uses') };
  const top = h('p', { class: 'note risk', hidden: true });

  const name = h('input', { id: 'np-name', type: 'text', autocomplete: 'off', maxlength: '80' });
  const slug = h('p', { class: 'muted small' }, 'Folder name: unknown until you type a name');
  name.addEventListener('input', () => {
    const s = slugify(name.value);
    slug.textContent = s ? `Folder name: ${s}` : 'Folder name: unknown until you type a name';
  });
  const family = h('input', { id: 'np-family', type: 'text', list: 'families', autocomplete: 'off' });
  const dl = h('datalist', { id: 'families' }, ...families.map((f) => h('option', { value: f })));
  const branches = h('select', { id: 'np-branches' }, h('option', { value: '' }, 'none'), ...parents.map((p) => h('option', { value: p.id }, p.name)));
  const purpose = h('textarea', { id: 'np-purpose', maxlength: '200', rows: '3' });
  const usesBoxes = shared.map((p) => ({ p, box: h('input', { type: 'checkbox', value: p.id }) }));
  const uses = h('div', { class: 'checks' }, ...(usesBoxes.length
    ? usesBoxes.map(({ p, box }) => h('label', { class: 'check' }, box, ' ', p.name))
    : [h('span', { class: 'muted' }, 'No shared projects')]));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create project');

  const field = (id, label, control, note) => h('div', { class: 'field' }, h('label', { for: id }, label), control, note);
  const form = h('form', { class: 'npform', novalidate: true },
    top,
    field('np-name', 'Name', name, notes.name), slug,
    field('np-family', 'Family', family, notes.family), dl,
    field('np-branches', 'Branches off', branches, notes.branchesOff),
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Uses'), uses, notes.uses),
    field('np-purpose', 'Purpose', purpose, notes.purpose),
    h('div', { class: 'row' }, submit));
  el.append(form);

  const clearErrors = () => {
    top.hidden = true; top.textContent = '';
    for (const n of Object.values(notes)) { n.hidden = true; n.textContent = ''; }
  };
  const showErrors = (r) => {
    const errs = r.errors && typeof r.errors === 'object' ? r.errors : null;
    const extra = [];
    if (errs) {
      for (const [k, msg] of Object.entries(errs)) {
        if (notes[k]) { notes[k].textContent = String(msg); notes[k].hidden = false; }
        else extra.push(`${k}: ${msg}`);
      }
    }
    const matched = errs && Object.keys(errs).some((k) => notes[k]);
    const lines = matched ? extra : [r.error || 'failed', ...extra];
    if (lines.length) { top.textContent = lines.join('; '); top.hidden = false; }
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    clearErrors();
    const body = {
      name: name.value,
      family: family.value,
      purpose: purpose.value,
      branchesOff: branches.value || null,
      uses: usesBoxes.filter(({ box }) => box.checked).map(({ box }) => box.value),
    };
    const r = await runFlow({ path: 'api/actions/new-project', body, title: 'Create project' });
    if (r.cancelled) { submit.disabled = false; return; }
    if (r.status === 201) { startPolling(el, ctx, r.data?.id); return; }
    if (r.status === 400) {
      showErrors(r);
    } else {
      top.textContent = r.error || 'failed';
      top.hidden = false;
    }
    submit.disabled = false;
  });
}

function startPolling(el, ctx, id) {
  const msg = h('p', null, `Created ${id}, scanning…`);
  const box = h('div', null, msg);
  el.replaceChildren(h('h1', null, 'New project'), box);
  const started = Date.now();
  const tick = async () => {
    if (ctx.stale() || !box.isConnected) return; // route changed: stop
    const r = await api('api/projects');
    if (ctx.stale() || !box.isConnected) return;
    if (!r.error && r.data?.projects?.some((p) => p.id === id)) { location.hash = '#/p/' + enc(id); return; }
    if (Date.now() - started >= POLL_MAX_MS) {
      box.replaceChildren(h('p', null, 'Created; the scan has not picked it up yet. '), h('a', { href: '#/' }, 'Back to the overview'));
      return;
    }
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}
