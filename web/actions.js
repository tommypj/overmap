// Actions client: csrf cache, POST helper, confirm sheet. No document access at import time.
import { h } from './ui.js';

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
