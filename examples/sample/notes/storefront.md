---
type: project
dashboard: true
name: Storefront
status: active
group: Shop
path: "@PROJECTS@/storefront"
uses: [vercel, neon, stripe]
connects: []
summary: "Customer shop for Larkspur Bikes: catalog, cart and checkout."
---

# Storefront

The public shop. Catalog pages are server-rendered. The cart lives in the browser and checkout hands payment to the provider.

## Blockers

- [ ] 2026-11-10 — waiting on the payment provider's test-mode approval
