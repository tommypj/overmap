// Actions client: csrf cache, POST helper, confirm sheet, live output panel. No document access at import time.
import { h, ago, enc, pill } from './ui.js';

// ---- csrf ------------------------------------------------------------------
let csrf = null; // { token, expiresAt }
export const clearCsrf = () => { csrf = null; };
export async function getCsrf(fetchImpl = fetch) {
  if (csrf && Date.now() <= csrf.expiresAt - 30_000) return csrf.token;
  const r = await fetchImpl('api/csrf', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`csrf HTTP ${r.status}`);
  const b = await r.json();
  csrf = { token: b.token, expiresAt: Number(b.expiresAt) || 0 };
  return csrf.token;
}

// POST JSON with the csrf token. Never throws: { status, data, error, confirm }.
export async function postAction(path, body, fetchImpl = fetch) {
  try {
    const token = await getCsrf(fetchImpl);
    const r = await fetchImpl(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, csrf: token }),
    });
    let b = null;
    try { b = await r.json(); } catch { /* empty body */ }
    if (r.status === 403 && b?.error === 'bad csrf') clearCsrf();
    if (r.ok) return { status: r.status, data: b, error: null, confirm: null };
    return { status: r.status, data: null, error: b?.error || `HTTP ${r.status}`, errors: b?.errors ?? null, confirm: r.status === 409 ? b?.confirm ?? null : null };
  } catch (e) {
    return { status: 0, data: null, error: e.message || 'network error', confirm: null };
  }
}

// POST, ask for confirmation when the server wants it, retry once on a stale csrf/nonce.
export async function runFlow({ path, body, title }, opts = {}) {
  const { fetchImpl = fetch, confirm = confirmSheet, attempt = 0 } = opts;
  let r = await postAction(path, body, fetchImpl);
  if (r.confirm) {
    const ok = await confirm({ title: r.confirm.title ?? title, detail: r.confirm.detail ?? [], labels: ['Run', 'Cancel'] });
    if (!ok) return { status: 0, data: null, error: 'cancelled', confirm: null, cancelled: true };
    r = await postAction(path, { ...body, confirm: r.confirm.nonce }, fetchImpl);
  }
  if (r.status === 403 && (r.error === 'bad confirm' || r.error === 'bad csrf') && attempt === 0) {
    clearCsrf();
    return runFlow({ path, body, title }, { fetchImpl, confirm, attempt: 1 });
  }
  return r;
}

// ---- confirm sheet ---------------------------------------------------------
export function confirmSheet({ title, detail = [], labels = ['Run', 'Cancel'] }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      sheet.remove();
      if (prev && typeof prev.focus === 'function') prev.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    const cancel = h('button', { class: 'btn', type: 'button', on: { click: () => done(false) } }, labels[1]);
    const run = h('button', { class: 'btn primary', type: 'button', on: { click: () => done(true) } }, labels[0]);
    const box = h('div', { class: 'box' }, h('h2', { id: 'sheet-title' }, title), detail.map((d) => h('div', { class: 'mono detail' }, d)), h('div', { class: 'row' }, run, cancel));
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title', on: { click: (e) => { if (e.target === sheet) done(false); } } }, box);
    document.addEventListener('keydown', onKey, true);
    document.body.append(sheet);
    cancel.focus();
  });
}

// ---- state helpers ---------------------------------------------------------
export function stateText(s) {
  if (!s) return 'idle';
  if (s.status === 'running') return 'running since ' + ago(s.startedAt);
  if (s.status === 'exited') return `exited ${s.exitCode ?? 'unknown'} ${ago(s.endedAt)}`;
  if (s.status === 'killed') return 'killed ' + ago(s.endedAt);
  if (s.status === 'failed') return 'failed: ' + (s.error ?? 'unknown');
  return 'unknown';
}
export function statePillClass(s) {
  if (!s) return '';
  if (s.status === 'running') return 'ok';
  if (s.status === 'exited') return s.exitCode === 0 ? '' : 'warn';
  if (s.status === 'killed') return 'warn';
  if (s.status === 'failed') return 'risk';
  return 'unknown';
}

// ---- output panel ----------------------------------------------------------
const MAX_LINES = 1000;
const POLL_MS = 1500;

export function outputPanel(projectId, actionId, { onState } = {}) {
  const status = h('div', { class: 'row outstatus' });
  const stopBtn = h('button', { class: 'btn danger', type: 'button', hidden: true, on: { click: onStop } }, 'Stop');
  const dropped = h('div', { class: 'muted small', hidden: true });
  const pre = h('pre', { class: 'out mono' });
  const panel = h('div', { class: 'outpanel' }, h('div', { class: 'row between' }, status, stopBtn), dropped, pre);
  let errCount = 0, lastRunning = false;
  let after = 0, timer = null, ended = false, seenAttached = false, lastStatus = undefined, tailDone = false;

  function render(state) {
    status.replaceChildren(pill(stateText(state), statePillClass(state)),
      state?.pid != null ? h('span', { class: 'age' }, `pid ${state.pid}`) : null,
      state?.startedAt ? h('span', { class: 'age' }, `started ${ago(state.startedAt)}`) : null);
    stopBtn.hidden = state?.status !== 'running';
  }
  function append(lines) {
    if (!lines.length) return;
    const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    for (const l of lines) pre.append(document.createTextNode(l.s + '\n'));
    while (pre.childNodes.length > MAX_LINES) pre.firstChild.remove();
    if (pinned) pre.scrollTop = pre.scrollHeight;
  }
  async function tick() {
    timer = null;
    if (ended) return;
    if (panel.isConnected) seenAttached = true;
    else if (seenAttached) { ended = true; return; } // removed from the page (route change): stop polling
    let r;
    try {
      const res = await fetch(`api/actions/output?id=${enc(projectId)}&action=${enc(actionId)}&after=${after}`, { headers: { accept: 'application/json' } });
      r = res.ok ? await res.json() : { none: res.status === 404, error: `HTTP ${res.status}` };
    } catch (e) { r = { error: e.message || 'network error' }; }
    if (ended) return;
    if (r.none) { render(null); pre.replaceChildren('(no output yet)'); return; }
    if (r.error) {
      errCount++;
      status.replaceChildren(pill(`output unknown (${r.error})`, 'warn'));
      if (errCount >= 3 && !lastRunning) return; // persistent error while not running: stop polling, error stays shown
      schedule();
      return;
    }
    errCount = 0;
    lastRunning = r.state?.status === 'running';
    if (pre.firstChild && pre.childNodes.length === 1 && pre.textContent === '(no output yet)') pre.replaceChildren();
    after = r.next ?? after;
    append(r.lines || []);
    if (r.dropped) { dropped.hidden = false; dropped.textContent = `dropped ${r.dropped} older lines`; }
    render(r.state);
    lastStatus = r.state?.status;
    if (onState) onState(r.state);
    if (r.state?.status === 'running') { tailDone = false; schedule(); }
    else if (!tailDone) { tailDone = true; schedule(400); } // one more poll to catch the tail
  }
  function schedule(ms = POLL_MS) { if (!ended && timer == null) timer = setTimeout(tick, ms); }
  async function onStop() {
    stopBtn.disabled = true;
    const r = await runFlow({ path: 'api/actions/run', body: { id: projectId, action: actionId, op: 'stop' }, title: 'Stop' });
    stopBtn.disabled = false;
    if (r.error && !r.cancelled) {
      const n = h('p', { class: 'note risk' }, r.error);
      panel.prepend(n);
      setTimeout(() => n.remove(), 6000);
    }
    errCount = 0;
    tailDone = false;
    if (timer != null) clearTimeout(timer);
    timer = null;
    schedule(300);
  }
  panel.stop = () => { ended = true; if (timer != null) clearTimeout(timer); timer = null; };
  panel.lastStatus = () => lastStatus;
  timer = setTimeout(tick, 0);
  return panel;
}
