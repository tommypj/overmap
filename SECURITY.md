---
type: doc
status: active
tags: [overmap]
relatedTo: []
---

# Security

## Reporting a problem

Please do not open a public issue for a security problem. Message the maintainer privately through their GitHub profile (github.com/tommypj), and include what you found, the version or commit, and steps to reproduce it.

## What the security model is

- **Loopback by default.** The server listens on `127.0.0.1`. Only the machine it runs on can reach it unless you configure a proxy (see [docs/phone.md](docs/phone.md)).
- **Identity headers are trusted only from a proxy you configure.** A request is accepted as a tailnet request only when `allowedLogin` is set, the request comes from loopback, `x-forwarded-proto` is `https` and `Tailscale-User-Login` matches. A server reachable from elsewhere without such a proxy is misconfigured, and Overmap refuses requests whose `Host` is not the loopback address or the configured `proxyHost`.
- **POST actions** need a CSRF token and a matching origin. Each one is written to the audit log.
- **Secrets** live in `secrets.json`, which Overmap reads only when the file is protected from other users (see [docs/connectors.md](docs/connectors.md)). Values are masked in logs, errors and API responses.
- **Ask the graph** runs `graphify query` with arguments passed directly (no shell), in the project folder, with a 60-second limit. A question is refused when it is empty or longer than 500 characters, when it contains a control character, or when it starts with `-` after leading spaces are trimmed.
- **Files** are read only from registered folders, with path containment and a size cap.

## Out of scope

Overmap has no user accounts and no password. Anyone who can run commands as your user can read your instance folder, including `secrets.json` in its protected form. Protect the machine, not only the port.
