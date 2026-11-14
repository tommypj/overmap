const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function header(req, name) {
  const v = req.headers?.[name];
  return typeof v === 'string' ? v : undefined;
}

// Fail closed: anything not positively identified is null.
export function classify(req, config) {
  if (!LOOPBACK.has(req?.socket?.remoteAddress)) return null;
  const headers = req.headers ?? {};
  const login = header(req, 'tailscale-user-login');
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  const forwarded = keys.some((k) => k.startsWith('x-forwarded-'));
  const loginPresent = keys.includes('tailscale-user-login');
  if (!forwarded && !loginPresent) return 'laptop';
  const allowed = typeof config?.allowedLogin === 'string' ? config.allowedLogin.trim().toLowerCase() : '';
  if (
    allowed !== '' &&
    header(req, 'x-forwarded-proto') === 'https' &&
    login !== undefined &&
    login.trim().toLowerCase() === allowed
  ) {
    return 'tailnet';
  }
  return null;
}

// Loopback hosts, plus the configured proxy host (null = none configured, so only loopback passes).
export function hostOk(req, port = 3210, proxyHost = null) {
  const host = header(req, 'host')?.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || (!!proxyHost && host === proxyHost.toLowerCase());
}
