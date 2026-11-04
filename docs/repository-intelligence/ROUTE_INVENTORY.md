# Route Inventory

- Versioned route manifest: `apps/api-gateway/src/routes/v2/route-manifest.ts`.
- Domains observed: auth, public/discovery, checkout/payment, orders, wallet, door/scanner, partner/events/venues/analytics, admin/communications and internal checks.
- Middleware and provider boundaries are in `apps/api-gateway/src`; core operations are in `packages/core/src/application`.
- Exact method/auth/schema details belong to the route files and shared contracts; this report does not infer missing routes from filenames.
