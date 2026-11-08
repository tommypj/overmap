// In-memory CSRF tokens (bound to request class + login) and single-use nonces (bound to a token and an action string).
import { randomBytes } from 'node:crypto';

const MAX_TOKENS = 1000;
const rand = () => randomBytes(24).toString('base64url');

export function createTokens({ now = Date.now, ttlMs = 600_000, nonceTtlMs = 60_000 } = {}) {
  const tokens = new Map(); // token -> { cls, login, exp }
  const nonces = new Map(); // nonce -> { token, bind, exp }

  function prune() {
    const t = now();
    for (const [k, v] of tokens) if (v.exp <= t) tokens.delete(k);
    for (const [k, v] of nonces) if (v.exp <= t || !tokens.has(v.token)) nonces.delete(k);
  }

  return {
    issue(cls, login) {
      prune();
      const token = rand();
      while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value); // oldest first
      const expiresAt = now() + ttlMs;
      tokens.set(token, { cls, login: login ?? null, exp: expiresAt });
      return { token, expiresAt };
    },
    check(token, cls, login) {
      if (typeof token !== 'string') return false;
      const e = tokens.get(token);
      return !!e && e.exp > now() && e.cls === cls && e.login === (login ?? null);
    },
    issueNonce(token, bind) {
      prune();
      const parent = tokens.get(token);
      if (!parent || parent.exp <= now()) return null;
      const nonce = rand();
      nonces.set(nonce, { token, bind, exp: now() + nonceTtlMs });
      return nonce;
    },
    consumeNonce(token, nonce, bind) {
      const e = typeof nonce === 'string' ? nonces.get(nonce) : undefined;
      if (!e) return false;
      nonces.delete(nonce); // single use, even on a mismatch
      const parent = tokens.get(token);
      return e.token === token && e.bind === bind && e.exp > now() && !!parent && parent.exp > now();
    },
    size() { return tokens.size; },
  };
}
