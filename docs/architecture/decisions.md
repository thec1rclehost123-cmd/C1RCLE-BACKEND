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