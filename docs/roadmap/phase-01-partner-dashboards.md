# Phase 1 — Partner dashboards (Host / Venue / Promoter)

**Status:** not started · **Depends on:** Phase 0 (done 2026-08-13 — auth + org/venue/event routes live)

## Carried over from Phase 0 (see phase-00-foundation.md §C for full context)

- **Organization invitations** (`GET /organizations/:organizationId/invitations`)
  — needs a real "pending invitation, not yet a member" domain concept added
  to `packages/core/src/domain/models/organization.ts` before a route can be
  built; today `inviteMember` adds a member immediately, there's nothing to
  list as "pending."
- **Venue menu** (`PUT/GET /venues/:venueId/menu`) — needs a `menu` field
  added to `VenuePublicProfile` (`domain/models/venue.ts`); doesn't exist yet.
- **Venue availability** (`GET /venues/:venueId/availability`) — needs a
  real availability computation distinct from the calendar's raw slot list
  (e.g. derived open/booked/blocked summary); no service method exists yet.
- **Event `review → published` gap** — with only the 6 documented lifecycle
  actions, `publish()` can never succeed from `review` status (it requires
  `scheduled`). Needs a product decision: allow `review → published`
  directly in the FSM, or add a `schedule`/`approve` action. Do not build
  Phase 1's own event-adjacent features assuming this is resolved.

This is the highest-value phase after Phase 0: it's what the most-built part
of the frontend (`apps/partner-dashboard`) actually needs. Every screen
currently renders a local fixture — see `*-model.ts` files under
`C1RCLE-FRONTEND/apps/partner-dashboard/src/components/{venue,host,promoter}/`.

## What the frontend already has a real (unused) contract for

`apps/partner-dashboard/src/lib/partner/api-partner-repositories.ts` is a
**complete, ready-to-activate** HTTP adapter for Host + Promoter, implementing
`HostRepository`/`PromoterRepository` from `contracts.ts`. It's currently dead
code (nothing imports it — see Phase 1 frontend note below) but it's the most
concrete spec available. Endpoint list it expects (adjust prefix per Phase 0's
nested-path convention, i.e. drop `/partner`, nest under
`/organizations/:organizationId/...` where the manifest agrees):

```
GET  /partner/organizations
GET  /partner/host/overview
GET  /partner/host/events
GET  /partner/host/partners
GET  /partner/host/finance
GET  /partner/host/profile
GET  /partner/events/:eventId
GET  /partner/events/:eventId/analytics
GET  /partner/promoter/overview
GET  /partner/promoter/events
GET  /partner/promoter/events/discover
GET  /partner/promoter/partners
GET  /partner/promoter/finance
GET  /partner/promoter/links
POST /partner/promoter/links
GET  /partner/promoter/profile
GET  /partner/promoter/network-profile
```

**No equivalent contract exists for Venue** despite Venue being the largest,
most-recently-built workspace — its data surface (events, event-detail
sub-tabs, orders, finance, partners, slot-requests, door-mode) must be
inferred from `Venue*Model`/`Venue*Record` TypeScript interfaces in
`apps/partner-dashboard/src/components/venue/*-model.ts` (esp.
`event-detail-model.ts`, `venue-finance-model.ts`, `venue-orders-model.ts`,
`overview-model.ts`, `venue-partners-model.ts`).

**Known frontend bug to flag/fix when this phase lands:**
`partnerRepositories.host`/`HostRepository`/`fixture-host-repository.ts` is
dead code — real Host screens import a separate, unrelated
`host-studio-model.ts` fixture directly. `docs/partner-dashboard-role-integration.md`
describes the `HostRepository` binding as the thing to replace at
integration time, but nothing in the UI currently calls it. Whoever builds
this phase's frontend wiring needs to fix that binding, not just the backend.

## v1 proven logic to port (`thec1rcle`)

- **RBAC / tab-visibility matrix** — `apps/api-gateway/src/lib/rbac-permissions.ts`.
  Venue roles (OWNER/MANAGER/FINANCE_ADMIN/STAFF/SECURITY-DOOR), Host roles
  (OWNER/COHOST/MANAGER/STAFF), Promoter roles (PROMOTER/TEAM_LEAD), each with
  an explicit permission set + tab-visibility map. Server-computed only —
  the frontend must never derive this locally (matches
  `docs/partner-dashboard-backend-handoff.md`'s security rules exactly).
- **Promoter commission tiers** (performance-based, global):
  `0→10% Base, 10→12% Silver, 25→15% Gold, 50→18% Platinum, 100→20% Diamond`.
- **Partnership graph** — `routes/v1/partnerships.ts` (Venue↔Host: request/
  approve/reject/block, both parties must be party to mutate) and
  `promoter-connections.ts` + `packages/core/promoter-engine.js` (Promoter↔
  Host/Venue: pending→approved/rejected/blocked/revoked).
- **`PromoterNetworkProfileData`** (per `docs/partner-dashboard-role-integration.md`):
  tickets moved, tracked conversion, events promoted, audience reach, repeat
  partners, response time, recent collaborators — **must never** include
  revenue/earnings/commission/payout/bank/settlement fields.
- **Analytics aggregates only** — venue/host analytics get precomputed
  aggregates, never raw guest records (security rule from the handoff doc);
  `AnalyticsService`/`AnalyticsReadModelRepository` already exist in
  `packages/core` for this — extend the read model, don't add per-request scans.

## Contracts additions needed

`PartnerEventSummary`, `PartnerEventDetail`, `PartnerAnalyticsSummary` (named
explicitly in `docs/partner-dashboard-backend-handoff.md` as "the current
frontend contracts") plus Host/Venue/Promoter overview DTOs, finance summary
DTOs (careful: promoter finance is private, never shown to venue/host).

## Firestore collections (new, v2-only, additive to Phase 0's)

`v2_partnerships`, `v2_promoter_connections`, `v2_promoter_links`,
`v2_promoter_commission_stats`.

## Session Log

(none yet)
