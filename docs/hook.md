---
type: doc
status: active
tags: [overmap, stop-hook, plan]
relatedTo: []
---

# The Stop hook, plans and test results

## What the hook does

Claude Code runs the Stop hook when a session tries to end. `hooks/plan-check.mjs` reads the session's working folder from its input and asks whether that folder belongs to a registered project:

- If the project's repos changed during the last four hours of work and its plan file was last touched more than 30 minutes before that change, the hook blocks the stop once. The reason tells Claude which plan file to update and how it is formatted.
- If the project has no plan file at all, the hook blocks once and asks for one.
- Otherwise the stop goes ahead.

Every failure path lets the stop through: a bad input, an unknown folder, a missing git, a git call over two seconds, or a total run past six seconds. The hook is read-only toward your projects.

## Registering the hook

Add the hook to `~/.claude/settings.json`, quoting both paths. `<overmap>` is your checkout; `<dir>` is your instance folder.

```json
"Stop": [
  { "type": "command", "command": "node \"<overmap>/hooks/plan-check.mjs\" --home \"<dir>\"", "timeout": 10 }
]
```

`--home` is optional. Without it, the hook reads `OVERMAP_HOME`, then `~/.overmap`. It reads `registry.json` from that folder, so run `make-registry.mjs` at least once first.

## Hand tests

Feed the hook a stop event by hand. Use a project folder you have registered.

bash:

```
echo '{"cwd":"/path/to/project","stop_hook_active":false}' | node /path/to/overmap/hooks/plan-check.mjs --home ~/.overmap
```

cmd (replace the angle-bracket parts; cmd does not expand `~`):

```
echo {"cwd":"<project home, forward slashes>","stop_hook_active":false} | node <overmap>\hooks\plan-check.mjs --home "<instance folder>"
```

Output is `{}` when the stop is allowed, or a JSON object with `"decision": "block"` and a reason. Setting `"stop_hook_active": true` always allows the stop, which is how the hook avoids blocking the same stop twice.

## PLAN.md

Overmap reads `PLAN.md` in the project home first. If there is none, it reads checkbox plans under `docs/superpowers/plans/` or `docs/plans/`.

The `PLAN.md` format:

```markdown
# Project title

## Milestone one (due 2026-12-01)

### Sprint one
- [x] Set up the repo
- [~] Write the importer #test
- [!] Wait for the API key @sam
- [ ] Ship the first version #idea

### Ideas
- [ ] Dark mode #idea
```

- `# ` is the plan title, `## ` a milestone, `### ` a sprint. Milestone and sprint headings may end with `(due YYYY-MM-DD)`.
- Items are `- [ ]` planned, `- [~]` in progress, `- [!]` blocked, `- [x]` or `- [X]` done. Items can be indented.
- `#bug`, `#idea` or `#test` on an item sets its kind. An item under a sprint or milestone titled `Ideas`, `Backlog` or `Improvements` counts as an idea.
- `@name` on an item sets its owner.
- Lines inside code fences are ignored.

Overmap shows the percentage of done items for each sprint, milestone and project. Ticking an item in `PLAN.md` is the whole update: the next scan picks it up.

## test-results.json

A project can report its last test run by writing `test-results.json` in its home folder, or in any of its repos or worktrees (the first one found wins). Overmap reads files up to 64 KiB.

```json
{
  "at": "2026-11-14T09:30:00Z",
  "passed": 128,
  "failed": 0,
  "skipped": 2,
  "total": 130,
  "durationMs": 8421,
  "command": "node --test \"test/*.test.mjs\""
}
```

`at` (an ISO timestamp), `passed` and `failed` are required. `skipped`, `total`, `durationMs` and `command` are optional; `total` defaults to the sum of the other counts. The `command` text is masked for secrets and cut to 200 characters. A file that does not parse shows its error on the project rather than hiding the project.

