# C1RCLE-BACKEND — Decisions Log

> Every architectural decision that must survive a session: the **problem**,
> the **options**, the **choice**, and the **why**. Append on change — do not
> rewrite history.

## D-001 · Auth = Better Auth (library), not hand-rolled JWT, not Firebase
- **Date / Status:** 2026-08-07 · confirmed by user
- **Context:** The old backend did Firebase ID-token verification (T15). The
  user's confirmed decision for this repo is a full auth *library*.
- **Choice:** `better-auth`, cookie-based sessions (httpOnly, SameSite,
  Secure-in-prod, rotation enabled) as the durable credential;
  short-lived access token returned to the client in memory.
- **Why it helps the frontend:** session-store keeps the access token
  in-memory only (XSS-safe); page reload restores the session from the
  httpOnly cookie — the "no session breakage" requirement.
- **To respect when implementing (B10):**
  - `POST /api/v2/auth/login` sets the cookie AND returns
    `{ user, accessToken, expiresAt }`.
  - `POST /api/v2/auth/refresh` verifies cookie, rotates, returns the same
    shape (reload-restore path).
  - `POST /api/v2/auth/logout` destroys session + clears cookie.
  - `GET /api/v2/auth/session` → current session or 401.
  - Frontend contract stays fixed: `Session { user, expiresAt }`,
    `Authorization: Bearer <accessToken>`.
- **Implemented 2026-08-13 (B10):** all four routes live in
  `plugins/auth.ts`/`routes/v2/auth/index.ts`, backed by `better-auth-firestore`
  (same project as D-002's Firestore adapter). Access token = Better Auth's
  own session token (Bearer plugin), not a separate JWT — see "Open
  questions" #3 below, now resolved. Full account:
  `docs/roadmap/phase-00-foundation.md`.

## D-002 · Repository-first storage (in-memory → Firestore → Postgres)

- **Date / Status:** 2026-08-07 · **chosen** (B12)
- **Options considered:** Firestore (old stack) vs PostgreSQL (dream plan).
- **Choice:** Nothing in shipped code depends on a concrete store. The domain
  depends on `interface …Repository` (T07). First real adapter = **Firestore**
  (mirrors the old repo's proven patterns, fastest parity); Postgres is the
  destination per the dream plan and slots in behind the same interfaces and
  the same contract suite.
- **Now:** `packages/core/src/infrastructure/memory/memory-repositories.ts`
  is the dev/test/parity adapter (still the default, `STORAGE_DRIVER=memory`).
- **Implemented 2026-08-13 (B12), partially:** Firestore adapters for all 7
  repository ports (`packages/core/src/infrastructure/firestore/`), selected
  via `STORAGE_DRIVER=firestore`. **Not done:** transactional outbox writes
  and compare-and-set — writes are read-check-write today, same race
  characteristics as the memory adapter. Real limitation, not silently
  claimed as solved; revisit before this matters under real concurrent load.

## D-003 · Contracts are backend-owned; frontend copies are parity-checked

- **Date / Status:** 2026-08-07 · **chosen**
- **Choice:** `packages/contracts` is the single source. It must mirror
  `C1RCLE-FRONTEND/packages/types` + `api-client/src/schemas.ts` **1:1**.
  A parity script (`scripts/contract-parity.mjs`, planned) diffs JSON
  shape/snapshots between the repos. When they drift → **fail**, fix
  frontend copy, no silent divergence.
- **Why:** two repos, one wire contract, no published package yet.

## D-004 · Error envelope single-sourced in `packages/contracts`

- **Date / Status:** 2026-08-07 · **chosen**
- **Choice:** `buildV2ErrorResponse`, `STATUS_CODE_TO_ERROR_CODE`, and
  `zodToFieldErrors` live in `packages/contracts/src/index.ts` (not duplicated
  in the gateway). The gateway maps `DomainError`→HTTP via
  `plugins/error-handler.ts`. V1's flat `{ success, error }` shape is **not**
  ported (fresh V2 only).
- **Why it helps the frontend:** the frontend `statusToErrorCode` map and the
  `{ code, message, status, requestId, fieldErrors }` parse match backend
  exactly; only one place to keep in sync.

## D-005 · Route = thin. Service = decisions. Model = rules.

- **Date / Status:** 2026-08-07 · **chosen (architecture rule 3)**
- **Choice:** route files only: validate → auth → policy/scope → ONE service
  call → serialize. No `.collection(`/`.doc(`, no inline business enums, no
  `process.env`. Enforced by `scripts/check-boundaries.mjs` + eslint
  `no-restricted-*`.

## D-006 · BLOCKED slices are absent, not stubbed (404, never 501)

- **Date / Status:** 2026-08-07 · **chosen**
- **Choice:** anything not in the route manifest (orders, payments, refunds,
  payouts, door, webhooks, admin, …) is simply **not registered**. Fastify's
  `setNotFoundHandler` returns the canonical 404 envelope. A test asserts no
  501 exists. (Registration authority pattern mirrors thec1rcle T14.)

## D-007 · Page-based pagination on the wire (mirror frontend)

- **Date / Status:** 2026-08-07 · **chosen**
- **Choice:** repositories stay **cursor**-based (T07, faithful port) but the
  gateway adapts to **page-based `PageInfo{page,pageSize,total,hasNextPage}`**
  (B05 — the frontend shape). No cursor leaks to the client; no hidden
  offset issues.

## D-008 · Scope expanded to a phased full-platform roadmap

- **Date / Status:** 2026-08-13 · confirmed by user
- **Context:** Every prior doc in this repo (`task.md`, `docs/reference/frontend-api-map.md`)
  froze the build to "Auth + Organizations + Venues + Events; everything else
  BLOCKED, never registered, never stubbed." That framing was correct for
  getting a first slice shipped, but it described BLOCKED as permanent
  ("no manifest entry exists ... they are BLOCKED, not planned"), which no
  longer reflects the user's intent once the frozen slice is complete.
- **Choice:** Build toward full v1↔v2 parity, phased across sessions. The
  phase breakdown, endpoint lists, v1 business-logic references, and
  Firestore collection plans live in `docs/roadmap/ROADMAP.md` and its
  per-phase files — that directory is now the source of truth for scope
  beyond the original frozen slice, superseding the "BLOCKED forever"
  language in `docs/reference/frontend-api-map.md`.
- **What does NOT change:** D-006 (BLOCKED slices stay absent/404, never
  stubbed) still applies *within* whichever phase is currently in flight — a
  phase not yet started still 404s by absence. This decision only changes
  what "eventually planned" means; it does not authorize speculative stub
  routes ahead of their phase landing.
- **Persistence tie-in:** the same session decided to wire the first real
  storage adapter (B12) now rather than later, reusing the existing
  `thec1rcle-india` Firebase project's service-account credentials (found at
  `thec1rcle/apps/api-gateway/.env.development`) rather than provisioning a
  new project. V2 data lives in new `v2_*`-prefixed collections in that same
  project — D-002's "Firestore first" choice, exercised now instead of
  deferred, with V1/V2 collections kept fully separate per architecture rule 8.

## D-009 · The error envelope is flat everywhere

- **Date / Status:** 2026-08-13 · **chosen** (bug fix, found independently in
  two parallel sessions working this repo — see D-011 below)
- **Context:** routes sent `buildV2ErrorResponse(...)` directly (flat
  `{ status, code, message, requestId }`), but `app.ts`'s `setNotFoundHandler`
  and `plugins/error-handler.ts`'s global handler both wrapped the same body
  in `{ error: {...} }`. The frontend's `ApiClientError` parses the flat
  shape, so it would have failed to parse precisely the errors it most needs
  to understand — every 404 and every unhandled 5xx.
- **Choice:** one flat envelope from every path, no exceptions. `app.test.ts`
  now asserts the flat shape directly (`body.code`, not `body.error.code`).

## D-010 · `publish()` walks the FSM instead of widening the transition table

- **Date / Status:** 2026-08-13 · **chosen** (bug fix — also found
  independently in the parallel session, see D-011)
- **Context:** `EVENT_TRANSITIONS` has no `review → published` edge, and
  nothing in the documented lifecycle actions (`review/publish/pause-sales/
  resume-sales/cancel/duplicate`) reaches `scheduled` on its own — so an
  event sent to review could never actually be published. This was flagged
  as an open finding in `docs/roadmap/phase-00-foundation.md` needing "a
  product decision, not a silent fix."
- **Choice:** `EventService.publish()` walks `review → scheduled →
  published`, one validated FSM edge at a time, inside the same service
  call. The transition table itself is unchanged — `draft → published`
  stays illegal (review is not skippable) because the `scheduled` step only
  runs when the event is currently `review`.

## D-011 · Reconciled with a parallel session's independent B08–B12 work

- **Date / Status:** 2026-08-13 · confirmed by user
- **Context:** While this session was mid-flight, a different contributor
  (Sagar, `rautsagar1625@gmail.com`, co-authored with Claude Opus 5) pushed
  an independent, thorough implementation of the same B08–B12 scope directly
  to `origin/main` (commit `80cca2c`). It diverged architecturally in real
  ways: SQLite (`node:sqlite`) instead of Firestore for durable storage
  (their own note: chosen because Firestore credentials weren't available to
  them — this session had and used them), plus RBAC/rate-limit/cache
  plugins and a much larger test suite (133 tests) that this session had
  deferred. It also independently found and fixed the same two bugs as
  D-009/D-010, which is reassuring cross-validation that both were real.
- **Choice, given "keep the stack we have (Firestore)" and "best of both":**
  kept this session's Firestore-backed foundation as the base (live-verified,
  matches D-002's original choice) rather than rebasing onto SQLite. Ported
  onto it, reviewed and adapted rather than blindly merged: the RBAC
  (`plugins/rbac.ts`), rate-limit (`plugins/rate-limit.ts`), and cache
  (`plugins/cache.ts`) plugins; the `scripts/contract-parity.mjs` script;
  both independently-found bug fixes (D-009, D-010).
- **Deliberately NOT ported this pass:** the SQLite adapter itself
  (`infrastructure/sqlite/`, 462 lines, keyset pagination — a different
  scheme than this repo's offset-based `paginateQuery`) and Sagar's
  `repository-contract.ts` multi-adapter test-suite pattern. A rushed port of
  a storage engine under time pressure is exactly the kind of change that
  should not be rushed; this is tracked as real, available, valuable work
  for a future session in `docs/roadmap/phase-00-foundation.md`, not
  silently dropped. `requirePermission`/`cached` are registered and
  available but not yet wired into partner routes for the same reason —
  wiring RBAC permissions to the wrong routes is worse than not wiring them
  yet.
- **A raw `git merge` was attempted first and aborted** — the two branches
  renamed the same core abstractions (event bus, outbox, service locator)
  differently enough that automatic conflict resolution risked producing
  inconsistent code. Reconciliation was done by hand-reviewing and adapting
  Sagar's additions onto this session's foundation instead.

## D-012 · Policy order: rate-limit → validate → authorize → cache

- **Date / Status:** 2026-08-13 · **chosen** (closes the "registered but not
  wired" gap left by D-011)
- **Context:** `requirePermission` and `cached` were registered as decorators
  but referenced by **no partner route** — policy that exists, typechecks and
  denies nobody. Partner routes also had no rate limiting at all (only the auth
  routes did).
- **Choice:** every partner route now declares
  `rateLimit → validateV2 → requirePermission → cached`, in that order:
  - **rate-limit first** — cheapest, and it must protect the work that follows.
  - **validate before authorize** — a missing `X-Organization-Id` should answer
    "you omitted a required header" (422), not a bare 403 that hides the real
    problem. It is also safer: ABAC compares `params.organizationId`, and that
    param should be schema-validated before it is trusted.
  - **cache last** — never serve a cached body to a caller policy would refuse.
- **Behaviour change:** reading an organization the caller is not scoped to now
  returns **403 at the policy layer** instead of 404 from the service. This is
  not an existence oracle: the answer is identical whether or not that
  organization exists, so the IDOR guarantee is unchanged — it is simply
  enforced one layer earlier. `organizations.test.ts` records the new contract.
- **Permissions added** for routes this repo has that the ported enum did not
  cover: `venue.schedule` (accept/reject a slot request) and
  `slot-request.create` (the host side of the same conversation).
- **Guarded by** `plugins/rbac.test.ts` — asserts real denials, plus that no
  declared permission is unreachable (dead policy that can only ever deny).

## D-013 · Invitations are a first-class aggregate, addressed by email

- **Date / Status:** 2026-08-13 · **chosen** (closes the Phase 0 carry-over)
- **Context:** `inviteMember` added a member immediately, so there was no
  "pending" state to list and `GET /organizations/:id/invitations` could not be
  built without returning a hardcoded empty array — which rule 10 forbids.
- **Choice:** `OrganizationInvitation` is its own aggregate with its own state
  machine (`pending → accepted | revoked | expired`, all terminal), stored in
  its own repository. Key points:
  - **Addressed by email, not user id** — the whole purpose is inviting someone
    who may not have an account yet. Emails are normalized (trimmed,
    lower-cased) so `A@x.com` and `a@x.com` cannot both be pending.
  - **Expiry is evaluated on read** (`effectiveInvitationStatus`), not by a
    sweeper job, so a lapsed invitation is never usable even if no cleanup ran.
  - **One pending invitation per address per org** — two live invitations would
    let one person join with whichever role they happened to click.
  - **Owner cannot be invited** — ownership is transferred deliberately, never
    granted by accepting a link. Enforced in the domain *and* at the schema.
  - **Acceptance requires `pending`.** The generic same-state transition is a
    no-op, which would have let a second `accept` silently grant a duplicate
    membership — possibly to a different user. Caught by
    `packages/core/src/domain/invitation.test.ts`; guarded explicitly now.
  - `inviteMember` (immediate membership by user id) stays for the internal
    case where the user is already known.
- **Routes:** `GET|POST /organizations/:organizationId/invitations`,
  `POST /invitations/:invitationId/{revoke,accept}`. Accept carries no
  `requirePermission`: membership of the target org is exactly what it grants.

## D-014 · Availability is derived, never stored

- **Date / Status:** 2026-08-13 · **chosen** (closes the Phase 0 carry-over)
- **Context:** `GET /venues/:venueId/availability` was left unregistered
  because "no distinct availability computation exists beyond the calendar's
  raw slot list."
- **Choice:** `computeVenueAvailability` derives the summary from the same
  slots the calendar route returns. It is **not** stored: a persisted summary
  would be a second source of truth that goes stale the moment a slot changes.
  Two judgements worth keeping:
  - **`cancelled` slots are excluded, not counted as unavailable.** A cancelled
    slot no longer exists; it is not one that is taken.
  - **An empty window is NOT `fullyBooked`.** Nothing published is a different
    answer from everything taken, and conflating them would tell a host their
    venue is busy when its calendar is blank.
- **Cached** with the `AVAILABILITY` class (30s) — cheap to recompute, and the
  response echoes the requested window so a cached body is self-describing.
- **Still not registered:** `/venues/:venueId/menu`. There is no `menu` field
  anywhere in `VenuePublicProfile`/`VenuePrivateProfile`, so the route would
  have nothing real to return. Tracked in Phase 1.

## D-015 · Compare-and-set closes the lost-update race (completes D-002)

- **Date / Status:** 2026-08-13 · **chosen**
- **Context:** D-002 admitted the gap plainly: Firestore writes were
  read-check-write with "same race characteristics as the memory adapter."
  Services check `expectedVersion` and then save, which is not atomic — two
  callers can both read version 1, both pass the check, and both write version
  2, the second erasing the first. `If-Match` looked enforced while lost
  updates happened anyway.
- **Choice:** enforce it in the adapter, where atomicity actually exists, using
  an invariant the domain already guarantees: `bumpVersion` always increments
  by exactly one, so **a write of version N must find N-1 in storage**.
  - Firestore: the check and the write run inside `runTransaction`.
  - Memory: the same rule, with no `await` between read and write.
  - Version 1 is exempt — a create has no predecessor, ids are generated, and
    keeping creates a plain `set` leaves seeding idempotent.
  - A missing row under version > 1 is also a conflict: the state the caller
    decided against is gone, which is the same failure as a stale version.
- **Why this shape:** it makes a lost update impossible even for a service that
  forgets to check `expectedVersion`. Correctness stops depending on every
  future call site remembering.
- **Both drivers enforce it identically**, which is what lets one suite prove
  the behaviour for both — a memory adapter that quietly allowed lost updates
  would make every test passing on it worthless as evidence about production.
- **Guarded by** `packages/core/src/infrastructure/compare-and-set.test.ts`.

## D-016 · Durable idempotency, and the menu as public-profile data

- **Date / Status:** 2026-08-13 · **chosen**
- **Sessions were already durable** — worth stating because an earlier note in
  this repo claimed otherwise: `plugins/auth.ts` has used `better-auth-firestore`
  since Phase 0. The in-memory session store belonged to the parallel
  implementation reconciled away in D-011, not to this codebase.
- **Idempotency:** `FirestoreIdempotencyStore` replaces the memory store on the
  firestore driver. The memory store loses every record on restart and shares
  nothing between instances, so replay protection silently stopped working
  exactly when it mattered most — a deploy mid-retry, or a second instance
  behind a load balancer, turning a client's retry into a second business
  result. `claim` uses Firestore's `create()` (which fails when the document
  exists) so the winner is decided atomically, not by a read-then-write.
  An expired record is treated as absent, so an abandoned claim cannot block a
  key forever.
- **Menu:** `VenueMenu` is part of `VenuePublicProfile` — it is menu copy a
  guest reads, not commercial terms. Prices are integer paise like every other
  money field, and `null` is allowed ("market price" is a real menu concept).
  `PUT` replaces the menu **wholesale**: a merge could not express removing an
  item, which is the edit a venue makes most often.
- Both are covered by `idempotency-store-contract.test.ts` and `menu.test.ts`.

## D-017 · Platform authority is not organization authority

- **Date / Status:** 2026-08-14 · **chosen**
- Phase 2 needed an "admin" who can approve any partner. The tempting shortcut
  was to reuse `OrganizationRole` — an org `owner` with some flag. We did not:
  an org role answers "what may you do inside your own tenant", and a platform
  role answers "what may you do to everyone else's". Collapsing them is how a
  partner ends up able to approve their own onboarding.
- So `PlatformAdmin` is its own aggregate in `v2_admins`, keyed by the auth
  user id, and `AdminAuthorityService.requireAdmin` is the only way to become
  one. Admin routes carry **no** `requirePermission` — deliberately, because
  checking an org permission there would be checking the wrong question.
- A deactivated admin is refused with the same `unauthorized` as a stranger:
  once authority is revoked, whether the account ever held it is not something
  the caller needs told.
- **Revocation is not dual-controlled** even though provisioning is. Making it
  hard to *remove* authority is the wrong failure mode when an account is
  compromised; granting it is the dangerous direction. An admin still cannot
  revoke themselves, because locking the last super admin out of the console is
  a real outage.

## D-018 · The KYC "verification" v1 shipped was a format check, and is labelled as one

- **Date / Status:** 2026-08-14 · **chosen**
- v1's Aadhaar check was a Verhoeff checksum on the number. A checksum proves
  the digits are well-formed and nothing else — not that the person exists, not
  that the document is theirs. Porting it as-is would leave a
  verification-shaped hole in the approval path, so the roadmap called for a
  pluggable provider instead.
- `ports/verification.ts` is that seam. The default implementation is named
  `FormatCheckVerificationProvider`, reports `provider: 'format-check'` and
  `reason: 'format_ok'`, and is documented as advisory. The one failure mode
  that mattered here was an operator reading a green tick as "identity
  confirmed", so nothing in the stack ever calls it verified.
- Approval consequently requires a **human** TIER2 decision regardless of what
  any provider returned. There is no auto-approve path.
- Attempts are recorded per applicant and bounded (5 per 24h), including
  provider errors — an unbounded check is an oracle, and an attacker who can
  induce errors would otherwise get unlimited free tries. The HTTP rate limiter
  bounds a *caller*; only the attempt budget bounds an *applicant*.

## D-019 · The platform fee lives on the organization, outside `OrganizationProps`

- **Date / Status:** 2026-08-14 · **chosen**
- Approval provisions an organization carrying `platformFeePercent`, taken from
  the applicant's plan (`basic→15, silver→12, diamond→10`, ported verbatim from
  v1's `approveOnboarding`). Phase 6 settlement will read it.
- It is a top-level field on `Organization` rather than a key in `settings`,
  because `updateOrganization` merges `settings` from a partner-supplied body —
  putting a commercial term there would let a partner set their own fee.
  `OrganizationProps` deliberately has no way to reach it; changing it is a
  TIER3 `COMMISSION_ADJUST`.
- The approving admin receives `provisionedOrganizationDtoSchema`, not
  `organizationDtoSchema`: the latter carries `role`, meaning *the caller's*
  role in the org, and an admin who provisioned it for someone else has none.
- Approval writes the organization **before** the request status. A failure
  after the org exists leaves the request `submitted` and retryable; the
  opposite order would leave an approved request pointing at an organization
  that was never created, which nothing can repair.

## Open questions (resolve before they block)

1. **Frontend env injection** for preview/prod (`NEXT_PUBLIC_API_BASE_URL`
   staging URL) — still open, confirm with backend deploy target when
   wiring (B14, not started).

Resolved since this list was written (kept here so the resolution is
traceable, not deleted):

2. ~~**Org scoping shape**~~ — resolved 2026-08-13 (B11): manifest won,
   org-scoped resources are nested under `/organizations/:organizationId/...`,
   no `/partner` prefix. Live in `routes/v2/route-manifest.ts`.
3. ~~**Access-token mechanism**~~ — resolved 2026-08-13 (B10): Better Auth's
   own session token, exposed via the Bearer plugin's `set-auth-token`
   header — no separate backend-issued JWT. Live in `plugins/auth.ts`.
4. ~~**Idempotency + optimistic lock TTLs**~~ — resolved (B08, predates this
   session's other work but was still marked open here): `Idempotency-Key`
   24h TTL, `If-Match` version-based optimistic lock. Live in
   `lib/v2-idempotency.ts` / `application/idempotency/idempotency-service.ts`.

---

## D-020 · Phase 4 Execution — Guest Checkout & Tickets (2026-08-17)

- **Date / Status:** 2026-08-17 · **execution started**
- **Context:** Phase 4 domain models (`pricing.ts`, `order.ts`, `entitlement.ts`) are complete and tested (40 tests). HTTP wiring (ports, adapters, services, routes) is the remaining work. The `C1RCLE-FRONTEND` integration branch (`feat/dashboard-api-gateway-integration`) was audited and found to contain **only stubs** (`@c1rcle/api-client` and `@c1rcle/auth` are pure UI mode stubs) and **retains all 14 mock API routes** in `apps/partner-dashboard/src/app/api/**`. It is not usable for integration — we must build the real implementation from scratch following the documented architecture.
- **Choice:** Execute Phase 4 per the documented roadmap (`docs/roadmap/phase-04-guest-checkout-tickets.md`) and manifest (`docs/reference/route-manifest.ts`), following the exact architecture in `docs/architecture/README.md`:
  1. **Repository ports first** (B04/B06 pattern): `OrderRepository`, `EntitlementRepository`, `CartReservationRepository`, `PromoRedemptionRepository` in `packages/core/src/domain/ports/`.
  2. **Memory adapters** for CI/testing (zero infra imports).
  3. **Firestore adapters** with **compare-and-set transactions** (D-015) — business write + outbox event in one transaction; sharded inventory counters (`ticket_shards`); circuit breaker for `strictMode` events (503 + Retry-After on Redis degradation).
  4. **Application services**: `CheckoutService` (quote → holds → intent → confirm with dual-path idempotent fulfillment), `OrderService`, `EntitlementService`, `InventoryService`, `PaymentProvider` port + Razorpay adapter.
  5. **HTTP routes** (activate from BLOCKED in manifest): checkout/quote, checkout/holds, payments/attempts, payments/verify, orders/*, tickets/*, wallet/*, webhooks/payments/razorpay.
  6. **Public discovery routes** for Guest Portal: public/events, public/venues, public/hosts, public/discovery, public/search (cached PUBLIC_CDN).
  7. **Contracts** added to `packages/contracts/src/client.ts` — backend-owned, parity-checked.
- **Why this order:** Matches the documented development order (task.md §4: Contracts → Domain → Validation → Repository interfaces → Application services → Event bus → Routes → Repository implementations → Integration → Frontend switch). Every step has an exit gate (contract suite passes against Memory AND Firestore; service tests green; route tests green; boundaries clean; parity 33/33).
- **Frontend integration branch audit result (2026-08-17):** `origin/feat/dashboard-api-gateway-integration` contains:
  - `@c1rcle/api-client/index.ts` → pure UI mode stub (8 lines, no transport)
  - `@c1rcle/auth/index.ts` → pure UI mode stub (auth = { currentUser: null })
  - All 14 mock API routes retained in `apps/partner-dashboard/src/app/api/**`
  - No real API integration code exists
  - **Decision:** Do not use this branch. Build real implementation from scratch per documented architecture.
- **Non-negotiables for Phase 4 (enforced by guardrails):**
  - Thin routes only: validate → auth → policy → ONE service call → serialize
  - No `process.env` in domain (only `apps/api-gateway/src/config/`)
  - No `.collection()`/`.doc()` in routes (enforced by `scripts/check-boundaries.mjs`)
  - Contracts backend-owned; frontend imports; parity test must pass
  - Idempotency + optimistic locking on EVERY write (manifest `REQUIRED`)
  - BLOCKED routes = 404 by absence, never 501 stubs
  - Compare-and-set in adapter (Firestore `runTransaction`), not in service (D-015)
  - Access token in memory only; httpOnly cookie backend-owned
  - QR/pass data short-lived, authorized at read time, never stored
  - Money = integer paise everywhere on the wire
  - Transactional outbox: fulfillment (order + entitlements + promo + ledger) in one atomic unit

## D-021 · Transactional Outbox Completion for Phase 4 Fulfillment (2026-08-17)

- **Date / Status:** 2026-08-17 · **required before Phase 4 route activation**
- **Context:** Phase 4 fulfillment (order creation + entitlement issuance + promo redemption + ledger write) must be atomic. The outbox skeleton exists (`event-bus.ts`, `audit-consumers.ts`, `outbox.ts`) but lacks:
  - Firestore outbox store with transactional write
  - `OutboxWriter` port implementation in adapters
  - Consumer idempotency by event ID
- **Choice:** Complete the outbox implementation before activating checkout routes:
  1. `packages/core/src/infrastructure/firestore/firestore-outbox-store.ts` — writes outbox event in same `runTransaction` as business write
  2. `packages/core/src/infrastructure/memory/memory-outbox-store.ts` — in-memory for CI
  3. `OutboxWriter` port in `domain/ports/outbox.ts` implemented by both adapters
  4. Consumers: `OrderCreated`, `EntitlementsIssued`, `PromoRedeemed`, `LedgerRecorded` → audit + projections
  4. Tests: publish → consumers run once; failure → retry, no duplicate effects; kill-after-commit does not lose row
- **Why:** Without transactional outbox, dual confirmation paths (webhook + client redirect) could produce duplicate fulfillments. The outbox is the single source of truth for "what happened" and enables exactly-once semantics.

## D-022 · Razorpay Webhook Security — HMAC Verification Not Optional (2026-08-17)

- **Date / Status:** 2026-08-17 · **enforced**
- **Context:** `PAYMENT_TICKET_CODE_REVIEW.md` in `thec1rcle` documents an earlier bug where webhook trusted request body without HMAC verification. The current `thec1rcle` code calls Razorpay refund API with idempotent claim via `status:'settling'` transactional lock, but this must be re-verified at implementation time.
- **Choice:** Razorpay webhook endpoint (`POST /api/v2/webhooks/payments/razorpay`) **must** implement:
  - HMAC-SHA256 verification using `RAZORPAY_WEBHOOK_SECRET` (validated at cold start, fails if missing)
  - Deterministic `JSON.stringify` for signature verification (D-018: no non-deterministic serialization)
  - Idempotent claim via `status: 'settling'` transactional lock (prevents double capture)
  - Raw body capture (Express/Fastify raw body) for signature verification
  - Dedicated tests for HMAC verification (tampered payload → 400, valid → processed once)
- **Why:** Webhook is the authoritative payment confirmation path. Client redirect is a parallel path that races. Both must converge on the same idempotent fulfillment. HMAC verification is the only guarantee the webhook came from Razorpay.

## D-023 · Frontend Contract Enforcement — No Stubs in Production (2026-08-17)

- **Date / Status:** 2026-08-17 · **enforced**
- **Context:** The `C1RCLE-FRONTEND` integration branch contains stubs that would silently fail in production (empty api-client, empty auth). The documented architecture (`docs/architecture/README.md` §4) states: "The frontend never instantiates a database or fetches raw. It sends one `@c1rcle/api-client` request per screen."
- **Choice:** Before any frontend integration:
  1. Implement real `@c1rcle/api-client` with: `x-request-id` per attempt, Bearer token provider from `@c1rcle/auth`, 401 → `onUnauthorized` → `POST /api/v2/auth/refresh` → retry once, 204 handling, request cancellation, deduplication
  2. Implement real `@c1rcle/auth` session store with: `login()`, `signup()`, `logout()`, `refreshSession()` wired to backend endpoints
  3. Delete all 14 mock API routes in `apps/partner-dashboard/src/app/api/**`
  4. Delete `src/lib/firebase/client.ts` + all `firebase/auth` imports
  5. Replace raw `fetch('/api/...')` with `@c1rcle/api-client` typed calls
- **Why:** Stubs violate the single-network-owner rule, the memory-only token rule, and the no-Firebase-in-frontend rule. They also cannot be tested against the real backend contract.

## D-024 · Frontend↔gateway auth: live `/api/v2/auth/*` supersedes the frozen `session.*` manifest; bare-DTO success envelope; CSRF is a Next.js BFF concern (2026-08-27)

- **Date / Status:** 2026-08-27 · **enforced** (frontend auth-foundation slice — `C1RCLE-FRONTEND` design `docs/superpowers/specs/2026-08-27-frontend-gateway-auth-foundation-design.md`, user-approved; backend punch-list executed as this slice's Phase 1).
- **Context:** The frozen V2 planning docs in `thec1rcle/docs/V2-Partners_Frontend/` (`route-manifest.ts`, `API_V2_ROUTE_MANIFEST.md`, `Middleware_documentation.docx`, `MASTER_LAUNCH_IMPLEMENTATION_PLAN.md`) and the live backend have diverged materially — the docs predate B10/B11 and the ~80-route registration. The V2 master prompt §3 requires conflicts to be recorded explicitly before destructive changes. Live code + this decisions log win where newer and more specific (D-001, D-004/D-009, phase-00).
- **Choice — the ten resolutions (spec §2, authoritative):**

  | # | Concern | Frozen planning doc | Live backend + this log | Resolution |
  |---|---|---|---|---|
  | C-1 | Session/auth routes | `/api/v2/session`, `/session/sync`, `/session/logout` — all **DEFERRED** | `POST /api/v2/auth/{signup,login,refresh,logout}` + `GET /api/v2/auth/session` — live, tested (D-001, phase-00) | **Use `/api/v2/auth/*`.** The frozen `session.*` names are superseded. |
  | C-2 | Success envelope | `{ data, meta }` | bare DTO (`eventDtoSchema` etc.) / `{ items, pageInfo }` for lists | **Bare DTO.** `@c1rcle/contracts` and `@c1rcle/api-client` already implement it. |
  | C-3 | Error envelope | flat `{ code, message, …, requestId }` | flat `{ code, message, status, requestId, fieldErrors? }` | **Agree** — from every path including 404 and unhandled 5xx (D-009). |
  | C-4 | Identity mechanism | "Firebase ID-token verification" (manifest) vs "Better Auth" (middleware doc) — self-contradictory | Better Auth: httpOnly cookie + `bearer()` plugin; access token = Better Auth session token via `set-auth-token` header, **not a minted JWT** | **Better Auth** (D-001, open-q3 resolved). |
  | C-5 | Middleware chain | global `onRequest`: tracing → auth → cache-bookkeeping; per-route `preHandler`: `rateLimit → validateV2 → requirePermission → cached → handler` | identical | **Agree.** The frontend cooperates with this exact order. |
  | C-6 | Rate-limit classes | 4 (middleware doc) vs 9 (manifest); burst numbers disagree | 4: `PUBLIC_READ` 120 / `AUTH_READ` 240 / `STANDARD_COMMAND` 60 / `SENSITIVE_COMMAND` 10, per 60s; auth routes = `SENSITIVE_COMMAND` | **4-class model.** Frontend handles `429` + `Retry-After`. |
  | C-7 | CSRF | "frontend / thin-BFF concern, not the gateway" (PLAN:125 lists cookies + CSRF as an approved Next.js BFF use case); gateway has none | gateway relies on Bearer + CORS-credentials + SameSite; prod cross-domain "needs revisit" (D-001) | **A minimal Next.js BFF owns the cookie/CSRF surface.** Doc-sanctioned; also fixes the unresolved prod cross-domain cookie problem (BFF re-scopes the session cookie to the FE origin, host-only). |
  | C-8 | Idempotency key | "one key per user **intent**, not per network retry" (RM:407, PLAN:293) | current partial FE wiring mints a fresh UUID per HTTP call — wrong | **Key minted at the user-action call site**, stable across the client's internal retries. |
  | C-9 | Runtime route truth | `route-manifest.ts` doc says only 3 ACTIVE routes | ~80 routes registered; `apps/api-gateway/src/routes/v2/route-manifest.ts` + route files are truth | **The code manifest is truth.** The doc manifest is stale. |
  | C-10 | `role` on the user | V1 role soup (`user`/`onboarding`/`partner`/`venue`/`host`/…) | V2 `role ∈ {guest, partner, admin}`, server-set; `/auth/signup` forces `partner` | **`{guest, partner, admin}`.** Per-org capability/role is a **separate** concern resolved from `GET /organizations/:id/access`, never from the token. |

- **Backend changes that land with this decision (this slice's Phase 1, one commit, separate from the Phase 5 door/ WIP):**
  1. `packages/contracts` builds to `dist/**` (JS + `.d.ts`); `package.json` gains `main`/`types`/`files` + a dist-pointing `exports` alternative so an external consumer can resolve built output while in-repo consumers keep resolving `src/`.
  2. `scripts/export-contracts.mjs` — mirrors `packages/contracts/src/**` into `<frontend>/packages/contracts/src/**` with a `GENERATED — do not edit` header (spec §5 distribution decision; publish-to-GitHub-Packages is the tracked upgrade).
  3. `scripts/contract-parity.mjs` — expanded with auth-bridge / signup / login / onboarding-profile / onboarding-request / organization / partner-access fixtures; reads the frontend schemas from the new `@c1rcle/contracts/dist` and exits 2 ("cannot check") gracefully until Phase 2 builds it.
  4. `buildActorContext` (`packages/core/src/infrastructure/utils.ts`) now throws `UnauthorizedError` (code `unauthorized` → 401 via `error-handler.ts`), not a bare `Error` → 500. Fixes unauthenticated calls to routes without `requirePermission` (onboarding, admin) on `STORAGE_DRIVER=firestore`.
  5. `routes/v2/auth/index.ts` `forwardAuthErrorResponse` / `sendAuthError` — on the **login** path, every 4xx returns the constant body `"Authentication failed"`; an unknown email and a wrong password are byte-identical (no account-existence oracle — spec §11.7). Signup still forwards the provider message.
  6. `plugins/auth.ts` — the confirmed Better Auth cookie/session defaults (`httpOnly`, `sameSite: 'lax'`, host-only; `secure` prod-gated via `useSecureCookies`; 7-day session / 1-day `updateAge`, extend-in-place not rotate; `trustedOrigins` = 3000/3001/3002) are documented in a code comment. No behaviour change.
- **Why:** The frontend was building against a frozen manifest that no longer describes the running gateway — `{ data, meta }` envelopes, a `session.*` route family that was never shipped, and a Firebase identity path that Better Auth replaced. Recording the resolutions here (rather than re-deriving them per screen) keeps every later frontend screen migration honest, and the parity script turns "the two repos agree on the wire contract" into a check instead of a hope. CSRF as a BFF concern is both doc-sanctioned and the only place that can also fix the prod cross-domain `SameSite` cookie gap D-001 left open.
## D-025 · The door is authenticated twice, and admission is claimed, not checked

- **Date / Status:** 2026-09-11 · **chosen** (Phase 5 scanner hardening)
- **Context:** The scanner slice shipped wired but not safe to put in front of
  real clubs. Six findings, each independently sufficient to break a real
  door night:
  1. No route minted an event code. `createEventCode` existed on the service
     and was registered nowhere, so a scanner could only be authorized by
     hand-writing a Firestore document.
  2. `scanTicket` resolved its session from a `deviceId` **in the request
     body**. Any caller could type any device id, so the `full` /
     `scan_only` / `charge` permission model decided nothing.
  3. The scan never touched the entitlement. It read one, wrote a ledger row,
     and returned — `scanCount` stayed 0 forever. A couple ticket
     (`scanCountAllowed: 2`) was refused on the second person because the
     duplicate check found the first ledger row, and a ticket's own state
     never showed it had been used.
  4. The duplicate check and the ledger write were two non-transactional
     Firestore calls, so two scanners could both be admitted.
  5. `magicTicketSecret` was never passed from the gateway config, so every
     deploy signed rotating QRs with the published constant
     `default-magic-ticket-secret-change-in-production`, and the signature
     was compared with `!==`.
  6. Event codes, session ids and session tokens came from `Math.random()`,
     and the Firestore adapter persisted the raw session token next to its
     own hash.
- **Choice:**
  - **Two credentials on every scan.** The Better Auth session establishes the
    operator and the tenant; a new `X-Scanner-Session-Token` — minted once by
    `POST /door/sessions`, stored only as a SHA-256 hash — establishes the
    device, the shift, the event and the permissions. Neither alone admits
    anyone. The operator on the ledger is now `actor.userId`, never a body
    field, which closes the v1 spoofing pattern
    `PAYMENT_TICKET_CODE_REVIEW.md` warned about.
  - **`EntitlementRepository.claimAdmission` is the only admission
    primitive.** It evaluates the domain rule and increments `scanCount`
    inside one `runTransaction`. This follows D-015's reasoning applied to
    admission rather than to `version`: correctness must not depend on a
    service remembering to re-check. Both adapters call the same pure
    `evaluateAdmission`, so the transactional path and the read-only preview
    cannot drift.
  - **Door codes get their own manager-facing routes** under `door.manage`,
    a new RBAC permission distinct from `ticket.override` — handing out a
    door code is giving away entry, which is a different right from letting
    one guest in. Revoking a code now also revokes the live sessions it
    opened; a revoked code whose devices keep scanning is not revoked.
  - **The offline manifest ships with its verifying side.** It was an honest
    501 precisely because signing without verification is theatre. Sync now
    re-runs the full atomic claim server-side and returns real `conflicts`,
    so two offline devices that both admitted one ticket produce one
    admission and one recorded conflict.
  - **`MAGIC_TICKET_SECRET` is a boot requirement in production** (32+ chars),
    HMACs compare with `timingSafeEqual`, and a payload whose window is more
    than ±2 windows from now is refused as a replayed screenshot rather than
    clock drift.
- **Deliberately NOT done:**
  - An override does **not** top the entitlement back up. It is a human
    decision recorded against one refusal; crediting a scan back would let
    one override grant unlimited entries.
  - The scanner still needs a logged-in staff session — there is no
    anonymous device-only auth. That is a stronger position than the roadmap's
    original "device bearer token" follow-up, not a weaker one, and it costs
    nothing while the scanner app is a staff-operated device.
  - `GET /door/stats/ws` stays a 501. `@fastify/websocket` is still not
    registered, and polling `/door/stats` is honest about that.
- **Wire-contract changes** (backend-owned, D-003): `scanRequestSchema` loses
  `scannedBy` and `deviceId`; previews answer `valid | invalid` on their own
  `ticketLookupResponseSchema` instead of reusing `consumed`, which read as
  "this guest was admitted" when nothing had been; `scannerSessionDtoSchema.sessionToken`
  is nullable and always `null` on a read; `checkInDtoSchema` moves into the
  contracts package and gains the `overridden` status the route-local copy
  omitted (reading back an overridden scan used to 500).

## D-026 · The scanner app's backend: a shift is a session + a bound handset

- **Date / Status:** 2026-09-15 · **chosen** (scanner-app backend build)
- **Context:** D-025 made the *admission* safe. This decision covers the rest
  of what a dedicated door app needs — picking tonight's event, registering
  the handset, working the roster, confirming a couple, recording a refusal —
  and it was designed against the behaviour of the v1 scanner app rather than
  reinvented, while deliberately not porting v1's shape.
- **Choices, and why each is not the obvious one:**
  - **A bound device is a separate aggregate from a session.** A session lasts
    one shift; a venue owns a handset for years. `v2_scanner_devices`, keyed
    `${organizationId}_${deviceId}`, is what a manager revokes when a phone is
    lost — and unbinding takes effect on the very next scan even though that
    phone's session token is still cryptographically valid. Folding the device
    into the session would mean chasing sessions to stop a stolen handset.
  - **The device id is opaque and client-generated, and that is fine.** v1
    used the same approach. A hardware id would be privacy-sensitive, often
    unavailable, and — since the client reports it — not a security boundary
    either. Authorization comes from the binding record plus the session
    token, neither of which the client can mint.
  - **A device refusal is a 403, never masked as a 404.** Every other
    cross-tenant refusal on these routes is masked, because a 403 would
    confirm another club's resource exists. This one is not: the caller has
    already proved tenant membership *and* a live session, so there is
    nothing to hide, and door staff need "this phone is deauthorized" rather
    than "no such event". That is why `DeviceNotAuthorizedError` is its own
    type with its own code.
  - **A couple ticket stops and asks before anything is spent.** v1 did the
    same, and the reason is worth recording: consuming a seat before staff
    confirm the second guest is present strands that guest outside holding a
    ticket the system says is half-used. `confirmation_required` writes
    nothing and carries no `checkInId`. The confirmation token is HMAC-signed
    with the `confirm:` prefix (domain-separated from ticket QRs so the two
    can never be swapped), 30 seconds, and binds the ticket, the event, the
    session, the device **and the exact scan count staff were shown** — so it
    cannot be replayed, aimed at another door, or used after something else
    consumed a seat. Both seats are then taken in ONE claim
    (`claimAdmission({ seats: 2 })`): claiming twice would let the halves land
    either side of a concurrent scan and admit three people on a two-person
    ticket.
  - **"Staff denied entry" does NOT consume the ticket.** Someone refused for
    being drunk or barred did not get in; burning their entry turns a door
    judgement into a refund dispute. Only the refusal is recorded.
  - **Manual check-in runs the same atomic claim as the camera.** The button
    exists for cracked screens and dead phones, not as a way past a spent or
    voided ticket, and it cannot race a scanner at another door. Its ledger
    row carries `deviceId: null` and `deviceBound: false` rather than
    borrowing some device's identity.
  - **Entered-ness on the roster is read from the ticket, not the ledger.**
    The ledger records *attempts*, including denials and overrides; the
    entitlement records what was actually spent. Reading the ledger would show
    a guest as "entered" because somebody tried.
  - **Occupancy sums `admittedCount`, it does not count scan rows.** One
    confirmed couple row admits two, an override row admits one against a
    denial, a denied row admits nobody. This is a life-safety number.
    `capacity` is nullable and reports `null` when unset — v1's UI hardcoded
    500, which told staff a confident number nobody had configured.
  - **`GET /door/events` resolves "today" in IST, not UTC.** An 11pm show on
    the 4th is a UTC-5th event, and a door device asking at 1am is still
    working the previous night. Drafts and cancelled events are excluded: a
    shift opened on either could only ever deny everyone.
  - **`SCANNER_COMMAND` (300/min)** for scan-path routes. A club door scans
    faster than `STANDARD_COMMAND` allows, and throttling it holds up a real
    queue.
  - **Door-guest fields are validated server-side** (ten-digit phone, 18+,
    enumerated gender, real email). These rules previously lived only in the
    app's submit button, which means they did not exist for anyone calling the
    API directly.
- **Deliberately NOT done, and why:**
  - **No offline queue for admissions.** Losing connectivity denies entry,
    which is what the app's own spec asks for. The pre-authorized offline
    manifest from D-025 remains available for venues that opt into it, and its
    sync still re-runs the full server-side decision — the door app does not
    use it.
  - **No realtime push.** `GET /door/stats/ws` is still an honest 501;
    `@fastify/websocket` is not registered. Polling `/door/stats` works.
  - **Legacy event-code login is kept, not dropped.** V2's door codes *are*
    that mechanism, now CSPRNG-generated and properly scoped, and the partner
    dashboard's scanner flow needs them.

## D-027 · Money at the door: a tab names an item, a sale names a tier

- **Date / Status:** 2026-09-15 · **chosen** (scanner-app backend, part 2)
- **Context:** The two places money moves at a door — charging a guest's
  prepaid cover-wallet tab at the bar, and selling entry to someone who turned
  up without a ticket. Both were missing; the wallet existed but had no
  scanner-facing surface, and the walk-in flow recorded a headcount rather
  than a sale.
- **Choices:**
  - **A charge names a preset item, never an amount.** `CoverWalletRules`
    carries the venue's own price list; the scanner sends `presetItemId` and a
    quantity and the server multiplies. There is no amount field on the wire.
    Free-entry pricing on a phone, at a bar, at 1am is how a ₹500 drink
    becomes a ₹5,000 charge — and the guest cannot check the screen before it
    is taken. `isAvailable` lets a venue switch an item off without editing
    prices, and `findChargeableItem` fails closed on anything unknown.
  - **A tab is read from a rotating signed QR, not from a wallet id.** Same
    30-second window and the same key as ticket QRs, under a `wallet:` purpose
    prefix so the two can never be swapped, and with a `cw:` wire prefix so
    the app can tell a tab from a ticket before it hits the network. An
    unverifiable payload is refused outright — never treated as a bare wallet
    id, which is exactly how a signature check gets bypassed.
  - **Charging re-sends the QR, not a wallet id.** A charge therefore always
    follows a tab physically presented at the bar, rather than a saved id a
    device could ring up again later.
  - **The bartender sees a `WalletChargeView`, not the wallet.** First name
    only, balance (suppressible by the venue), and the available items. Not
    the guest's id, metadata or transaction history.
  - **Permission is the session's, not the user's.** Reading or charging a tab
    requires a `charge`-type door code. A `scan_only` handset at the entrance
    cannot see, let alone bill, someone's bar tab — which is the entire reason
    door codes have types.
  - **A paid walk-up sale creates a real order, not a headcount row.** Paid
    order + issued tickets + a scan-ledger row per admission + settlement
    through `CheckoutService.settleOrder` — the *same* writer online revenue
    uses, made public for exactly this rather than duplicated. A venue's
    finance screen is then one set of numbers instead of two.
  - **The door sale walks the order FSM** (`pending → awaiting_payment →
    paid`), persisting each state, rather than widening the transition table
    for the door — the same reasoning as D-010's `publish()`. Persisting each
    step also means a process that dies mid-sale leaves a real order to
    reconcile against the cash drawer instead of nothing.
  - **A cash door sale carries no gateway fee and no GST-on-fees.** Face value
    is the whole total. Charging an online payment fee on cash handed to a
    human would be inventing a charge nobody is paying.
  - **The order id is derived from the idempotency key.** A retry after a
    dropped response collides with the original order at the storage layer
    rather than charging the guest twice and issuing a second set of tickets.
  - **Inventory is checked before selling.** `InventoryService` already
    derives availability from paid orders and holds, so a door sale both
    respects and contributes to it without a separate counter. The door is the
    last place that should oversell a room.
  - **Tickets sold at the door are admitted immediately**, through the same
    atomic claim a camera scan uses — the guest is standing there — so
    occupancy and the ledger agree with every other admission that night.
- **Deliberately NOT done:** refunds, top-ups and freezes stay out of the
  scanner. They are supervisor-console actions; a device that can reverse a
  charge at the bar is a device that can be talked into reversing one.

## D-028 · Live door stats are Server-Sent Events, not a WebSocket

- **Date / Status:** 2026-09-15 · **chosen** (supersedes the roadmap's
  "needs `@fastify/websocket`" note)
- **Context:** `GET /door/stats/ws` had been an honest 501 since Phase 5
  landed. The remaining work was "live push"; the roadmap assumed that meant
  a WebSocket because that is what v1 used.
- **Choice: SSE at `GET /door/stats/stream`.** The reasoning is mostly
  security, and mostly about what a WebSocket would force us to invent:
  1. **The data only flows one way.** The door watches numbers and sends
     nothing up this channel, so bidirectionality buys nothing and costs a
     second transport to secure.
  2. **SSE is ordinary HTTP and inherits every control already in place** —
     Bearer/cookie auth, `X-Organization-Id` scoping, the CORS allowlist, the
     rate limiter, the error envelope. A browser cannot attach headers to a
     WebSocket handshake, which is precisely why WebSocket deployments end up
     putting access tokens in the query string, where they land in access
     logs, proxy logs and browser history. Choosing SSE removes that
     credential-leak class rather than mitigating it.
  3. **CORS covers it.** WebSocket is exempt from the same-origin policy; its
     only defence is an `Origin` check someone must remember to write.
  4. **It is correct on more than one instance.** Each tick recomputes from
     the read model, so any instance can serve any client. A WebSocket fed by
     the in-process event bus would look like it worked and would silently
     deliver only events raised on whichever instance the client reached —
     the worst kind of broken, and invisible until a second instance exists.
     Redis fan-out would then be required for *correctness*; here it would
     only reduce latency.
  5. **One nginx line** (`proxy_buffering off`) instead of `Upgrade`/
     `Connection` handling on a snippet that is still inactive.
- **The cost, stated:** latency is bounded by the 3s tick rather than
  push-instant. For an occupancy gauge nobody at a door can perceive the
  difference.
- **Controls the streaming shape required** (a stream's risks are not a
  request's):
  - **Connection budget**, per actor (10) and global (500). Connection count
    is the DoS vector a rate limiter cannot see — each open is one request, so
    the limiter never fires while sockets pile up. Slots are released on
    close, error *and* timeout, and release is idempotent because two of those
    can fire for one socket.
  - **Authorization happens before the first byte**, so a caller without
    access gets an ordinary 404 envelope rather than an opened stream that
    then errors in a format no client is parsing yet.
  - **Re-authorized every tick** — the service's tenant check runs each time,
    so a stream cannot outlive the authority that opened it.
  - **15-minute hard lifetime**, forcing a reconnect through the full auth
    path; a revoked membership stops being served in minutes, not whenever
    someone closes a laptop.
  - **15s heartbeat comments**, inside nginx's idle timeout.
  - **Backpressure closes rather than buffers** — a failed `write` means a
    consumer too slow to keep up, and buffering for it turns one bad client
    into a memory leak.
  - `no-store`, `X-Accel-Buffering: no`, and no PII in the payload (counts and
    money totals only).
- **`GET /door/stats/ws` is now absent, not a 501.** D-006 says a route that
  cannot serve is not registered. It was a stub only while there was no live
  push at all; there is one now, so the placeholder is gone.

## D-029 · Two holes found reviewing the scanner surface, and what they teach

- **Date / Status:** 2026-09-15 · **fixed** · full write-up:
  `docs/architecture/scanner-threat-model.md`
- **1. Unbinding a stolen handset could be undone by anyone.**
  `POST /door/devices` is deliberately ungated so staff can self-register a
  phone on launch without a manager — safe, because binding alone grants
  nothing (a device still needs a door code and a session to scan). But it
  also *reactivated* an unbound device. So a manager revokes a stolen phone,
  and whoever holds it — still logged in as staff — re-registers the same
  device id and is back in.
  **Fix:** `bindDevice` refuses to reactivate; `POST /door/devices/:id/reauthorize`
  does, gated on `door.manage` and audited.
  **The lesson:** an endpoint's permission has to be judged against its
  *strongest* effect, not its usual one. "Register a device" and "restore a
  revoked device" read like the same verb and are not remotely the same act.
- **2. Staff could mint a guest's tab QR, and therefore charge an absent
  guest.** `generateWalletQr` allowed venue staff as well as the owner, for
  the "guest's phone died" case. But the guest presenting that QR *is* the
  authorization for a charge — so staff who can mint it can bill a tab with
  nobody standing there.
  **Fix:** owner-only. A guest with a dead phone is a supervisor-console
  problem, exactly like refunds and top-ups.
  **The lesson:** when a token is what authorizes a debit, "who may read it"
  and "who may create it" are different questions. Convenience for staff was
  quietly an insider-fraud path.
- **Two more, less severe, fixed in the same pass** (see the threat model
  §3.5): the guest roster paged every entitlement for an event into memory and
  returned the lot — an OOM risk and a lot of guest PII on the wire, now
  bounded and filtered server-side with honest `truncated` reporting; and the
  admissions breakdown sampled 5,000 ledger rows, so above that it understated
  categories while the total stayed right. It is now exact at any scale via
  one `sum()` aggregate per tier.
