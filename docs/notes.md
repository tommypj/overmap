---
type: doc
status: active
tags: [overmap]
relatedTo: []
---

# Project notes

Overmap's registry is your notes. Each project is one Markdown note in the folder named by `vaultProjectsDir` (in `overmap.config.json`), usually an Obsidian vault folder. `make-registry.mjs` reads those notes and writes `registry.json` in your instance folder; `scan.mjs` then reads the registry on every scan.

## Frontmatter

```yaml
---
type: project
dashboard: true
name: My App
status: active
group: Client X
path: ~/code/my-app
repos: [~/code/my-app, ~/code/my-app-wt1]
deploy: https://my-app.example
uses: [neon, vercel]
connects: [other-app]
links: [https://my-app.example/docs]
---
```

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | must be `project` |
| `dashboard` | yes | must be `true`, otherwise the note is ignored |
| `path` | yes | the project's home folder; `~` is expanded |
| `name` | no | defaults to the file name |
| `status` | no | shown as written; use `active`, `paused`, `archived` or `terminated` |
| `group` | no | the cluster the project sits in on the map |
| `repos` | no | more repos or worktrees |
| `deploy` | no | shown on the Dev tab |
| `uses` | no | shared services, drawn as hubs on the map |
| `connects` | no | declared links to other projects |
| `links` | no | URLs listed on the project |

Put comments in the note's body, not after a value: the frontmatter reader does not strip `# ...` text, so a trailing comment becomes part of the value.

`type` and `dashboard` must match exactly. `path` is required; a note without it is skipped. `status` is shown as written, so keep to the four values above to keep the map consistent.

`uses` names shared services. Names are lower-cased and spaces become hyphens. A few aliases are folded together: `neon eu`, `neon db` and `neon database` become `neon`, and `vercel.com` becomes `vercel`. Any other name is a hub of its own.

`connects` names other projects by file name (the note's id), by `name` or by note id, ignoring case. Two projects that share a git remote, or where one is a worktree of the other, are linked automatically.

## Blockers

Open blockers go in a `## Blockers` section. One line each:

```markdown
## Blockers
- [ ] 2026-11-02 — waiting for the signed contract
- [x] 2026-10-20 — resolved: the domain is live
```

Unchecked lines show on the project; checked lines are kept as history and do not show.

## Registry files

`make-registry.mjs` builds `<home>/registry.json` from the notes. Entries that already exist in `registry.json` are never overwritten, so settings you add there (see [connectors](connectors.md)) survive a rebuild.

For a folder that has no note, add it to `<home>/registry.extra.json`:

```json
{
  "projects": {
    "scratch-tool": {
      "home": "~/code/scratch-tool",
      "name": "Scratch tool",
      "family": "Tools",
      "kind": "project",
      "uses": ["vercel"],
      "connects": []
    }
  }
}
```

`kind` is `project` by default; the other values the code accepts are `shared`, `tool`, `data` and `media`. `family` plays the same role as `group`.

## Example

```markdown
---
type: project
dashboard: true
name: Shop API
status: active
group: Shop
path: ~/code/shop-api
repos: [~/code/shop-api, ~/code/shop-api-wt1]
uses: [neon, vercel]
connects: [storefront]
---

# Shop API

## Blockers
- [ ] 2026-11-10 — payment webhook still returns 500 on retries
```

Overmap's sample workspace in `examples/sample/notes/` has five of these notes to copy from.
