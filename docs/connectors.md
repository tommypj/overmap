---
type: doc
status: active
tags: [overmap, connectors]
relatedTo: []
---

# Connectors

A connector reads one service for one project and records what it finds as facts, daily series and events. The six in `connectors/` are worked examples: they show the pattern, and they are not a promise to support any particular service.

| Connector | Every | Secrets (in `secrets.json`) | Per-project settings (`connectors.<id>` in `registry.json`) |
| --- | --- | --- | --- |
| `health` | 5 min | none | `url` |
| `vercel` | 15 min | `VERCEL_TOKEN` | `project`, optional `teamId` |
| `sentry` | 15 min | `SENTRY_AUTH_TOKEN` | `org`, `project` |
| `lemonsqueezy` | 1 h | `LEMONSQUEEZY_API_KEY` | `storeId` |
| `gsc` (Search Console) | 1 h | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | `siteUrl` |
| `ga4` (Analytics) | 1 h | the same three Google secrets | `propertyId` |

Connector settings are per project, in the `connectors` object of that project's entry in `registry.json`:

```json
"connectors": {
  "health": { "url": "https://app.example/healthz" },
  "vercel": { "project": "my-app", "teamId": "team_example" }
}
```

You can also edit them on the Settings page. For Sentry, Vercel, Lemon Squeezy, Search Console and GA4 the Settings page has a Discover link once the secret is set; it lists the org, project, store, site or property names so you can copy the right one.

## Secrets

Secrets go in `secrets.json` in your instance folder:

```json
{
  "VERCEL_TOKEN": "paste-your-token-here"
}
```

Overmap releases these values only when the file is protected. On Windows, `icacls` must show no one but you, `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators`. Elsewhere, the file must have no group or other permission bits (`chmod 600 secrets.json`). If the file fails the check, no connector runs and the Settings page says why.

Every secret value is masked in logs, in error text and in the API. Token shapes that Overmap recognises (bearer and basic credentials, Anthropic, GitHub and Google tokens, Sentry tokens, JWTs, credentials in URLs) are masked even when they are not in `secrets.json`.

## Google helper

The Google connectors need a refresh token for an OAuth client of the Desktop-app type. `google-auth.mjs` runs the consent flow on a loopback port and prints the refresh token:

```
node google-auth.mjs
```

It never writes `secrets.json`. It prints a line; paste it into the file yourself, with a comma after the previous entry. `node google-auth.mjs --dry-run` prints the consent URL with placeholder values and does not start a server.

## Runs

- The scheduler starts one timer per connector. The first run comes 60 seconds after start, each connector 5 seconds after the previous one. Targets run one after another, and a connector never overlaps itself.
- A connector whose secrets or settings are missing is recorded as `not_configured`, and the facts it had go stale. Nothing is fetched.
- Each run has a 30-second limit by default. A run that is cut off or returns the wrong shape is recorded as an error, with its message cut to 300 characters. The facts from before the run stay.
- Successful results are written in one transaction, so a bad response never leaves half the facts updated.

Outbound requests go through `lib/http.mjs`: a host allow-list per request, no redirects, a 20-second timeout by default, and a 5 MiB body cap. A connector that follows pagination links must stay on its own host, as the Lemon Squeezy connector does.

## Writing one

A connector is a module that default-exports an object. `connectors/health.mjs` is the smallest example and the best place to start.

```js
export default {
  id: 'example',                 // shows in the API and the Settings page
  every: '1h',                   // '5m', '15m', '1h' or '1d'
  secrets: ['EXAMPLE_TOKEN'],    // names that must be set, or the run is not_configured
  required: ['account'],         // per-project fields that must be set
  note: 'account is your account slug',   // optional help text on Settings
  targets(registry) { /* one target per project that configures this connector */ },
  async fetch(target, ctx) { /* ctx.getSecret, ctx.fetchJson, ctx.now */ },
  parse(raw, target) {
    return {
      facts: [{ key: 'example.status', value: 'up' }],        // key, JSON value
      series: [{ metric: 'example.visits', day: '2026-11-14', value: 12, merge: null }],
      events: [],                                              // kind, at, title, url, external_id, json
    };
  },
  // Optional: async discover(ctx) returns candidates for the Settings page.
};
```

Rules the runner enforces:

- Fact keys are strings. A value under a key that ends in `.reason` or `.error` is treated as an error message and masked.
- Series rows need a metric, a `YYYY-MM-DD` day and a finite number. `merge: 'max'` keeps the larger of two writes for the same day.
- Events need an `external_id`, an `at` that parses as a date, and a title. The same event is updated, not duplicated.
- Read responses strictly. `lib/need.mjs` has `need`, `needArr`, `needNum` and `registryTargets`; the GA4 and Search Console examples treat a missing `rows` key as a real zero, not an error.

Tests for connectors live in `test/connector*.test.mjs` and use the fixtures under `test/fixtures/connectors/`. Fixtures must use invented data.
