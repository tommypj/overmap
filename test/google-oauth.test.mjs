import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessToken, _resetTokenCache, SCOPES } from '../lib/google-oauth.mjs';
import { buildConsentUrl, openCommand } from '../google-auth.mjs';

const tok = JSON.parse(readFileSync(new URL('./fixtures/connectors/google-token.json', import.meta.url), 'utf8'));
beforeEach(() => _resetTokenCache());

function mk(startMs, { secrets, fail } = {}) {
  const s = secrets ?? { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec', GOOGLE_OAUTH_REFRESH_TOKEN: 'rtok' };
  const st = { t: startMs, calls: [] };
  st.ctx = {
    getSecret: (n) => s[n],
    now: () => st.t,
    async fetchJson(url, opts) {
      st.calls.push({ url, opts });
      if (fail) throw new Error('HTTP 400: invalid_grant');
      return { status: 200, json: structuredClone(tok), text: '' };
    },
  };
  return st;
}

test('refresh posts the right form to the token endpoint', async () => {
  const st = mk(1_000_000);
  assert.equal(await accessToken(st.ctx), tok.access_token);
  assert.equal(st.calls.length, 1);
  const { url, opts } = st.calls[0];
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(opts.allowHosts, ['oauth2.googleapis.com']);
  assert.equal(opts.headers['content-type'], 'application/x-www-form-urlencoded');
  const f = new URLSearchParams(opts.body);
  assert.deepEqual(Object.fromEntries(f), { client_id: 'cid', client_secret: 'csec', refresh_token: 'rtok', grant_type: 'refresh_token' });
});

test('cached until expires_in minus 60 s, then refreshed', async () => {
  const st = mk(1_000_000);
  await accessToken(st.ctx);
  st.t += (tok.expires_in - 61) * 1000;
  await accessToken(st.ctx);
  assert.equal(st.calls.length, 1);
  st.t += 1000; // now = expiresAt - 60 s exactly
  await accessToken(st.ctx);
  assert.equal(st.calls.length, 2);
});

test('concurrent callers share one refresh', async () => {
  const st = mk(1);
  await Promise.all([accessToken(st.ctx), accessToken(st.ctx), accessToken(st.ctx)]);
  assert.equal(st.calls.length, 1);
});

test('failure throws and is not cached; a missing secret is named without values', async () => {
  const bad = mk(1, { fail: true });
  await assert.rejects(accessToken(bad.ctx), /invalid_grant/);
  const again = mk(1);
  assert.equal(await accessToken(again.ctx), tok.access_token);
  _resetTokenCache();
  const none = mk(1, { secrets: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec' } });
  await assert.rejects(accessToken(none.ctx), /missing secret GOOGLE_OAUTH_REFRESH_TOKEN/);
  assert.equal(none.calls.length, 0);
});

test('a token response without access_token throws', async () => {
  const st = mk(1);
  st.ctx.fetchJson = async () => ({ status: 200, json: {}, text: '' });
  await assert.rejects(accessToken(st.ctx), /missing access_token/);
});

test('consent URL: both scopes, offline access, forced consent, loopback redirect', () => {
  const u = new URL(buildConsentUrl({ clientId: 'cid', port: 5555, state: 's1' }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = u.searchParams;
  assert.equal(p.get('client_id'), 'cid');
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:5555/cb');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('state'), 's1');
  assert.deepEqual(p.get('scope').split(' '), ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly']);
  assert.deepEqual(SCOPES, p.get('scope').split(' '));
});

test('openCommand never goes through cmd and passes the URL as one argv', () => {
  const url = buildConsentUrl({ clientId: 'cid', port: 1, state: 's' });
  const [exe, args] = openCommand(url);
  assert.equal(exe, 'rundll32');
  assert.deepEqual(args, ['url.dll,FileProtocolHandler', url]);
  assert.ok(url.includes('&'));
});

test('cache is keyed by refresh token too: a re-consent is not served the old token', async () => {
  const st = mk(1);
  await accessToken(st.ctx);
  const s2 = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csec', GOOGLE_OAUTH_REFRESH_TOKEN: 'other' };
  st.ctx.getSecret = (n) => s2[n];
  await accessToken(st.ctx);
  assert.equal(st.calls.length, 2);
});
