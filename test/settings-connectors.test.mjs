import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM, enough for h(): the page code builds nodes and never touches the network here.
class N {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.nodeType = 1; this.className = ''; }
  append(...k) { this.children.push(...k); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  get text() { return this.children.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join(''); }
}
globalThis.document = {
  createElement: (t) => new N(t),
  createTextNode: (s) => ({ nodeType: 3, text: String(s) }),
};

const { connectorsSection } = await import('../web/pages/settings.js');

test('the Connectors section renders with zero runs and with an empty list', () => {
  const none = connectorsSection({ data: [], error: null });
  assert.match(none.text, /Connectors/);
  assert.match(none.text, /No connectors have any project configured yet/);
  const never = connectorsSection({ data: [{ id: 'health', every: '5m', projects: [{ project: 'A', status: 'never_ran', at: null, error: null, missing: [] }] }], error: null });
  assert.match(never.text, /health \/ A/);
  assert.match(never.text, /never ran/);
  assert.match(never.text, /not run/);
});

test('not_configured names the exact missing secrets and registry fields; errors show the last error', () => {
  const sec = connectorsSection({ data: [{ id: 'gsc', every: '1d', projects: [
    { project: 'A', status: 'not_configured', at: null, error: null, missing: ['GOOGLE_OAUTH_CLIENT_ID', 'connectors.gsc.siteUrl'] },
    { project: 'B', status: 'error', at: '2026-10-31T10:00:00Z', error: 'HTTP 401', missing: [] },
    { project: 'C', status: 'ok', at: '2026-10-31T10:00:00Z', error: null, missing: [] },
  ] }], error: null });
  assert.match(sec.text, /missing: GOOGLE_OAUTH_CLIENT_ID, connectors\.gsc\.siteUrl/);
  assert.match(sec.text, /not configured/);
  assert.match(sec.text, /HTTP 401/);
});

test('a failed /api/connectors fetch renders as unknown with the reason', () => {
  const sec = connectorsSection({ data: null, error: 'HTTP 500' });
  assert.match(sec.text, /unknown \(HTTP 500\)/);
});
