---
type: project
dashboard: true
name: Shop API
status: active
group: Shop
path: "@PROJECTS@/shop-api"
uses: [neon, resend]
connects: [storefront]
summary: "JSON API behind the shop: cart, checkout, orders and stock."
---

# Shop API

Serves the storefront and the mobile app. Orders are written to the database and confirmations go out by email.

## Blockers

- [ ] 2026-11-12 — retry budget for the mail provider is not decided
