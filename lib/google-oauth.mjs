import { createHash } from 'node:crypto';
// Google OAuth for the Search Console and GA4 connectors: refresh token -> short-lived access token, cached in memory.
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const TOKEN_HOST = 'oauth2.googleapis.com';
export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

const SKEW_MS = 60_000;
const cache = new Map(); // clientId -> { token, expiresAt }
const inflight = new Map(); // clientId -> Promise<string>

export function _resetTokenCache() {
  cache.clear();
  inflight.clear();
}

function secret(ctx, name) {
  const v = ctx.getSecret(name);
  if (typeof v !== 'string' || !v) throw new Error(`missing secret ${name}`);
  return v;
}

export async function accessToken(ctx) {
  const clientId = secret(ctx, 'GOOGLE_OAUTH_CLIENT_ID');
  const refresh = secret(ctx, 'GOOGLE_OAUTH_REFRESH_TOKEN');
  const key = `${clientId}:${createHash('sha256').update(refresh).digest('hex').slice(0, 16)}`;
  const hit = cache.get(key);
  if (hit && ctx.now() < hit.expiresAt - SKEW_MS) return hit.token;
  if (inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret(ctx, 'GOOGLE_OAUTH_CLIENT_SECRET'),
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }).toString();
    const res = await ctx.fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      allowHosts: [TOKEN_HOST],
    });
    const token = res?.json?.access_token;
    if (typeof token !== 'string' || !token) throw new Error('missing access_token in token response');
    const ttl = Number(res.json.expires_in);
    const expiresIn = Number.isFinite(ttl) && ttl > 0 ? ttl : 3600;
    cache.set(key, { token, expiresAt: ctx.now() + expiresIn * 1000 });
    return token;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}
