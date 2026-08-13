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