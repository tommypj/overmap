---
type: doc
status: active
tags: [overmap]
relatedTo: []
---

# Contributing

Thanks for looking. Overmap is a small tool with a few hard rules. Read these before you open a change.

## Rules

- **Zero dependencies.** Node 22.13 or newer, the standard library, and `node:sqlite`. No `package.json` dependencies, no build step. Every file must stay readable.
- **No privacy leaks.** Nothing from a real person's machine, projects, clients, hosts or accounts goes into the tree, the tests, the fixtures, the screenshots or the commit messages. Sample and test data are invented.
- **The web side has no bundler.** Plain HTML, CSS and JavaScript. A web change is checked by running `node serve.mjs --sample` and opening every tab of the page, not only the one you touched, because nothing catches an undefined name in a page before the browser runs it.

## Before you open a change

```
node --test "test/*.test.mjs"
OVERMAP_DENYLIST=<your-denylist> node tools/publish-check.mjs .
```

The first runs the suite; it must end with `fail 0`. The second is the privacy scan. It flags drive-letter paths, user folders, tailnet hosts, email addresses and token shapes. Set `OVERMAP_DENYLIST` to a file of your own terms, one per line, to scan for those too; the file stays on your machine. A line containing `privacy-ok` is skipped by the scan, so use that marker only for a line that is safe by design, such as a test that checks the scanner itself. The scanner also skips files named `LICENSE`.

## Code

- Modules are `.mjs` with named exports. Keep models pure (no DOM, no file I/O) so they can be tested under `node:test`.
- A test goes next to the code it covers, in `test/<name>.test.mjs`, and uses `node:test` and `node:assert/strict`.
- A new connector follows [docs/connectors.md](docs/connectors.md) and comes with fixtures that use invented data.

## Documentation

If a change alters a command, a flag, a file format or a config field, change the matching page in `docs/` in the same commit. Documentation must match the code; when they disagree, the code is right and the page is wrong.

## Commits

Use a short subject in the form `type: summary` (for example `fix(map): ...`, `docs: ...`). Describe the why in the body when it is not obvious from the diff.

## Connectors and features

Connectors are worked examples. Contributions are welcome, but the maintainer does not promise to keep a connector working against a service that changes its API, and does not promise to add connectors for services they do not use.
