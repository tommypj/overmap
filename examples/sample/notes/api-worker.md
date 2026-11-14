---
type: project
dashboard: true
name: API worker
status: active
group: Shop
path: "@PROJECTS@/api-worker"
uses: []
connects: []
summary: "Background jobs for the shop API, run from a second worktree of the same repository."
---

# API worker

Runs queued jobs: confirmation emails, stock sync and cleanup. It shares its git history with the Shop API.
