# Phase 1 — Partner dashboards (Host / Venue / Promoter)

**Status:** substantially done (2026-08-13) — finance endpoints blocked on Phase 6 · **Depends on:** Phase 0

## Carried over from Phase 0 (see phase-00-foundation.md §C for full context)

- ~~**Organization invitations**~~ — **done 2026-08-13**, ahead of this phase:
  `OrganizationInvitation` aggregate + state machine + repository (memory and
  Firestore adapters) + the four routes. See `docs/architecture/decisions.md`
  D-013. Covered by `packages/core/src/domain/invitation.test.ts` and
  `apps/api-gateway/src/routes/v2/partner/invitations.test.ts`.
- ~~**Venue menu**~~ — **done 2026-08-13**, ahead of this phase: `VenueMenu`
  added to `VenuePublicProfile`, with `GET`/`PUT` routes (replace-wholesale).
  See `docs/architecture/decisions.md` D-016.
- ~~**Venue availability**~~ — **done 2026-08-13**, ahead of this phase:
  `computeVenueAvailability` derives an open/booked/blocked summary (plus
  bookable minutes) from the calendar's slots, and the route is registered and
  cached. See `docs/architecture/decisions.md` D-014 and
  `packages/core/src/domain/availability.test.ts`.
- ~~**Event `review → published` gap**~~ — **resolved before Phase 1 started**
  (`docs/architecture/decisions.md` D-010): `publish()` walks
  `review → scheduled → published` inside one service call. Phase 1 may assume
  publishing works from `review`. No product decision outstanding.

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

- 2026-08-13 — **Phase 0 carry-overs cleared, and the first Phase 1 domain
  landed.** Nothing from Phase 0's scope is outstanding any more (invitations,
  venue menu, availability, RBAC/rate-limit/cache enforcement, compare-and-set,
  durable idempotency — see `phase-00-foundation.md` and D-012…D-016).
  - **Built here:** `domain/models/partnership.ts` — the venue↔host graph
    ported from v1 `routes/v1/partnerships.ts`, plus the promoter commission
    tiers ported verbatim from v1 `lib/rbac-permissions.ts`. 21 tests.
  - **Two v1 behaviours deliberately tightened** (both were latent bugs, not
    intentional design):
    1. v1 let the **requester approve their own request** — it only checked
       "are you a party to this?". V2 requires the *counterparty*.
    2. v1's `blocked` was just another string in a `statusMap`, so a later
       `approve` silently un-blocked. V2 makes `blocked` terminal; unblocking
       is a new request.
  - **Commission rounds DOWN** (`Math.floor`). Rounding a half-paisa up on
    every order pays out money the platform never collected.
  - **Partnership repository/service/routes now built too** (same day):
    `PartnershipRepository` (memory + Firestore), `PartnershipService`, and
    `GET /organizations/:organizationId/partnerships`, `POST /partnerships`,
    `POST /partnerships/:partnershipId/{approve,reject,block,end}`. 11 route
    tests. Notes worth keeping:
    - the venue's owning organization is resolved **from the venue**, so a
      client cannot address a request at an org that does not own it
    - resolution is four POST actions, not a PATCH of `status` — approve and
      block are different authorities, and collapsing them into one mutable
      field is what let v1's `statusMap` silently un-block a partnership
    - a partnership between two other organizations reads as **404**, not 403
    - the Firestore adapter denormalizes `partyIds` so one `array-contains`
      query serves "either side of the graph" (Firestore has no cross-field OR)
  - **RBAC tab-visibility matrix ported** (`domain/models/partner-access.ts`,
    22 tests) and served by `GET /organizations/:organizationId/access` —
    permissions + tab visibility computed server-side, which is what v1's own
    "the frontend must NEVER define or evaluate these" comment demands. Notes:
    - `tabVisibility: null` preserves v1's "no restriction" answer rather than
      expanding to an all-true map; the tab LIST is the frontend's to own, the
      backend says only what is withheld
    - two role vocabularies now coexist deliberately: `OrganizationRole`
      (owner/admin/manager/member) authorizes the API, `PartnerRole`
      (OWNER/DOOR/COHOST/…) drives the dashboard. A venue's DOOR staff and a
      host's COHOST are both "member" in V2 terms but see different tabs
    - V2 `admin` maps to partner MANAGER, not OWNER: running the tenant should
      not silently inherit payout and settings authority
    - an unrecognized role falls back to the least-privileged one, never to an
      empty permission set that renders as a broken dashboard
  - **Referral links built** (`domain/models/referral-link.ts` + service +
    both adapters + routes, 12 domain / 6 route tests). The rule that shapes
    the model: **a link carries attribution, it never owns it.** Attribution is
    written onto the order at purchase time (Phase 4), so a link holds no money
    and no commission rate — deactivating or renaming one can never rewrite
    what a past order earned. Other decisions:
    - codes use an alphabet with no `O/0/I/1/L`: they are read aloud, printed
      on flyers and typed by hand, so look-alikes cost real conversions
    - `clicks`/`conversions` do NOT bump `version` — a high-frequency counter
      under optimistic locking would make a popular link unwritable under
      contention, and a lost click is not a lost order
    - a duplicate code for one event is refused: a collision would silently
      hand one promoter another's attribution
    - deactivate, never delete, so past attributions stay explicable
    - the guest-side click tracker is deliberately NOT here — a click is
      anonymous traffic, and putting it behind partner policy would be wrong.
      It belongs to Phase 4's public routes.
  - **Analytics routes built** — `GET /organizations/:id/analytics/overview`
    and `GET /events/:eventId/analytics`, read-model only.
  - **Promoter connections built** — the promoter↔host/venue graph, kept
    separate from partnerships because the parties and allowed actions differ.
    v1's asymmetry is preserved and tested: the RECIPIENT approves/rejects,
    only the PROMOTER revokes (withdrawing is not the counterparty refusing
    you). v1's own "BUG-2" fix is kept: a live connection blocks on pending OR
    active, not pending alone.

### What is left in this phase, and why

- **Finance dashboard endpoints are BLOCKED on Phase 6, not skipped.** There
  is no ledger yet, so a `/finance` route could only return invented numbers —
  precisely what rule 10 forbids. The phase doc's own warning ("promoter
  finance is private, never shown to venue/host") is a *ledger* access rule; it
  cannot be honoured before the ledger exists. Build these immediately after
  Phase 6.
- **Overview endpoints** are served today by
  `GET /organizations/:id/analytics/overview` (read-model). Richer per-role
  overviews (Host vs Venue vs Promoter shapes) need the same read model
  extended with per-capability projections — additive work, not a redesign.
- **`PartnerEventSummary` / `PartnerEventDetail`** contracts are not yet
  written: the existing `eventDtoSchema` covers what the dashboard needs today,
  and inventing narrower DTOs before a screen consumes them would be guesswork.
    (Host/Venue/Promoter overview, events, finance, analytics) plus their
    `PartnerEventSummary`/`PartnerEventDetail`/`PartnerAnalyticsSummary`
    contracts.
