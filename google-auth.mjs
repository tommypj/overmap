// One-off CLI: node google-auth.mjs [--dry-run]
// Runs the Google consent flow for a Desktop-app OAuth client on a loopback port and PRINTS the refresh token.
// It never writes secrets.json: paste the printed line into it yourself.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSecrets } from './lib/secrets.mjs';
import { resolveHome } from './lib/home.mjs';
import { join } from 'node:path';
import { fetchJson } from './lib/http.mjs';
import { SCOPES, TOKEN_URL, TOKEN_HOST } from './lib/google-oauth.mjs';

export const redirectUri = (port) => `http://127.0.0.1:${port}/cb`;

export function buildConsentUrl({ clientId, port, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(port),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  if (state) q.set('state', state);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export const openCommand = (url) => ['rundll32', ['url.dll,FileProtocolHandler', url]];

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Overmap</title><p>${msg}</p>`;

async function main(argv) {
  if (argv.includes('--dry-run')) {
    console.log(buildConsentUrl({ clientId: 'CLIENT_ID', port: 'PORT' }));
    return 0;
  }
  const home = resolveHome();
  const { getSecret } = createSecrets(home);
  const clientId = getSecret('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = getSecret('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in secrets.json first.');
    return 1;
  }
  const state = randomUUID();
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/cb') { res.writeHead(404).end(); return; }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Invalid request.'));
      return; // keep waiting for the real callback
    }
    if (err || !code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Consent failed. Return to the terminal.'));
      rejectCode(new Error(err ? `consent refused: ${err}` : 'consent response had no code'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Done, you can close this tab.'));
    resolveCode(code);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const url = buildConsentUrl({ clientId, port, state });
  console.log(`Open this URL if the browser does not start:\n${url}\n`);
  const [exe, args] = openCommand(url);
  execFile(exe, args, { windowsHide: true }, () => {});
  const timer = setTimeout(() => rejectCode(new Error('timed out waiting for consent (5 min)')), 300_000);
  try {
    const code = await codePromise;
    const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(port), grant_type: 'authorization_code' }).toString();
    const res = await fetchJson(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, allowHosts: [TOKEN_HOST] });
    const token = res.json?.refresh_token;
    if (typeof token !== 'string' || !token) throw new Error('no refresh_token in response (revoke the app at myaccount.google.com/permissions and retry)');
    console.log(`Add this line inside the existing JSON object in ${join(home, 'secrets.json')} (mind the comma):`);
    console.log(`"GOOGLE_OAUTH_REFRESH_TOKEN": ${JSON.stringify(token)}`);
    return 0;
  } catch (e) {
    console.error(`google-auth failed: ${e.message}`);
    return 1;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
