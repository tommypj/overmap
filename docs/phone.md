---
type: doc
status: active
tags: [overmap, phone, tailscale]
relatedTo: []
---

# Phone access

Overmap listens on `127.0.0.1` and nothing else. By default only the machine it runs on can open it. To use it from a phone, put a reverse proxy in front of it that sends your identity, and let the server accept requests that come through that proxy.

The tested setup is Tailscale Serve. Point Tailscale Serve at `127.0.0.1` on the Overmap port (3210 by default), using the Serve command in Tailscale's own documentation for your version. Other proxies work if they send the same headers; they are not tested.

## Settings

Two fields in `overmap.config.json` enable the proxy path:

```json
{
  "allowedLogin": "you@your-tailnet-login",
  "proxyHost": "your-machine.your-tailnet.ts.net"
}
```

- `allowedLogin` is the identity your proxy reports. Empty (the default) means loopback only.
- `proxyHost` is the host name the proxy uses. It is accepted in the `Host` header and as the origin for POST requests. Empty means only loopback host names are accepted.

Restart `serve.mjs` after changing either field.

## What the server checks

Each request is classified before it is answered. Anything not positively identified is refused with a 403.

- **Laptop**: the connection comes from a loopback address and carries no forwarded headers (`x-forwarded-*`) and no `Tailscale-User-Login`. This is how you use Overmap on the machine it runs on.
- **Tailnet**: `allowedLogin` is set, the connection comes from loopback (the proxy), `x-forwarded-proto` is `https`, and `Tailscale-User-Login` matches `allowedLogin`, ignoring case and surrounding spaces.
- **Anything else** is refused.

The `Host` header must be `127.0.0.1` or `localhost` on the Overmap port, or the configured `proxyHost`. For POST requests (the actions), the `Origin` header must match the same hosts, and the request also needs a CSRF token. Request bodies are capped at 64 KiB.

## Checking it

From the machine itself, `http://127.0.0.1:3210` should show the dashboard. From the phone, open the proxy's HTTPS address. If it returns "not allowed from here", check that `allowedLogin` matches the login the proxy reports exactly, and that the proxy sends `x-forwarded-proto: https`.

Overmap has no login page and no tokens of its own. Access control is whatever your proxy enforces, plus the header check above. Do not expose the port on a public address without a proxy that authenticates users.
