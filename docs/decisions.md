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

## D-002 · Repository-first storage (in-memory → Firestore → Postgres)

- **Date / Status:** 2026-08-07 · **chosen** (B12)
- **Options considered:** Firestore (old stack) vs PostgreSQL (dream plan).
- **Choice:** Nothing in shipped code depends on a concrete store. The domain
  depends on `interface …Repository` (T07). First real adapter = **Firestore**
  (mirrors the old repo's proven patterns, fastest parity); Postgres is the
  destination per the dream plan and slots in behind the same interfaces and
  the same contract suite.
- **Now:** `packages/core/src/infrastructure/memory/memory-repositories.ts`
  is the dev/test/parity adapter. Revisit in B12 to add the Firestore adapter
  + transactional outbox writes + compare-and-set.

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

## D-008 · Idempotency: key triple, 2xx-only storage, schema-enforced requirement

- **Date / Status:** 2026-08-11 · **chosen** (B08 / T09)
- **Choice:**
  - Record key is `{ actorId, commandName, idempotencyKey }`. A client key alone
    never addresses a stored response, so a leaked or guessed key cannot replay
    another actor's command, nor a different command of the same actor.
  - **Only 2xx responses are stored.** A failed command produced no durable
    business result, so its key is released and stays retryable — otherwise a
    transient 500 or a 422 would poison the key for 24 hours.
  - The stored body is replayed **byte-for-byte** (serialized string, not a
    re-serialized object), so a retry cannot observe a different id or ordering.
  - **Requiredness lives in the route's header schema, not the plugin.** A
    missing `Idempotency-Key` is therefore a normal 422 with `fieldErrors`,
    identical in shape to every other header failure. The plugin owns only
    replay semantics.
  - A concurrent second attempt on an in-flight key gets **409**, not a wait.
- **Now:** `MemoryIdempotencyStore` (dev/test). **Not durable** — records are
  lost on restart and not shared between instances. B12 must add the durable
  adapter (Firestore authority, Redis fast path) behind `IdempotencyStore`
  before this is production-safe.

## D-009 · `If-Match` is the only version authority

- **Date / Status:** 2026-08-11 · **chosen** (B08 / T10)
- **Choice:** `If-Match` is **required** on every partner PATCH (manifest
  `expectedVersion: REQUIRED`). Write bodies are `.strict()` and have no
  `version` field, so a client sending one gets a 422 rather than having it
  silently ignored — stricter than T10's "body version is ignored", and it
  surfaces the mistake instead of hiding it.
- **Why:** before this, `if-match` was optional on venues and events, and the
  service skips its version check when `expectedVersion` is null — so two of
  three resources silently permitted lost updates.
- **Conflict shape:** 409 `conflict` with
  `details: { expectedVersion, currentVersion }`, which is what makes the
  refetch-and-retry loop mechanical for the client.

## D-010 · First durable adapter is SQLite, not Firestore (amends D-002)

- **Date / Status:** 2026-08-12 · **chosen** (B12)
- **Context:** D-002 chose "Firestore first" for parity with the old stack. A
  Firestore adapter cannot be executed here: it needs project credentials or an
  emulator, neither of which this environment has. Shipping storage code that
  no test has ever run is worse than shipping none.
- **Choice:** the first durable adapter is **SQLite via Node's built-in
  `node:sqlite`** — no new dependency, and the repository contract suite runs
  it in CI exactly as it runs the memory adapter.
- **What this does NOT change:** the ports. `packages/core/src/infrastructure/
repository-contract.ts` is one suite run against every adapter, so Firestore
  or Postgres slot in behind the same assertions the day their infrastructure
  exists. D-002's principle — nothing in shipped code depends on a concrete
  store — is now enforced by a test rather than asserted in prose.
- **Selected by config:** `STORAGE_DRIVER=memory|sqlite`. Production **fails
  startup** on `memory` (fail closed — a production process must not hold
  business data in RAM).
- **Still on memory:** slot-requests, event-catalog, analytics and the Better
  Auth session store. Their SQLite adapters land with the slices that need
  them; sessions therefore do not survive a restart yet.

## D-011 · The error envelope is flat everywhere

- **Date / Status:** 2026-08-12 · **chosen** (bug fix found in B11)
- **Context:** routes sent `{ code, message, status, requestId }` while the
  gateway's `setNotFoundHandler` and `setErrorHandler` wrapped the same body in
  `{ error: … }`. The frontend's `ApiClientError` parses the flat shape, so it
  would have failed to parse precisely the errors it most needs — 404s and
  unhandled 5xx.
- **Choice:** one flat envelope from every path. A test asserts `body.error` is
  absent on a 404.

## D-012 · `publish` walks the FSM instead of widening it

- **Date / Status:** 2026-08-12 · **chosen** (bug fix found in B07 tests)
- **Context:** `EVENT_TRANSITIONS` has no `review → published` edge, and
  nothing else reached `scheduled`, so an event sent to review could never be
  published. The API surface had no route that could rescue it.
- **Choice:** `EventService.publish` walks `review → scheduled → published`,
  one validated edge at a time. The table stays the single authority, and
  `draft → published` remains illegal: review is not skippable.

## Open questions (resolve before they block)

1. **Frontend env injection** for preview/prod (`NEXT_PUBLIC_API_BASE_URL`
   staging URL) — confirm with backend deploy target when wiring (B14).
2. **Org scoping shape** — manifest wins: org-scoped resources nested under
   `/organizations/:organizationId/...`. Confirm the exact frontend paths at
   B11.
3. ~~**Access-token mechanism**~~ — **resolved (B10):** `accessToken` IS the
   Better Auth session token. The httpOnly cookie and the in-memory bearer are
   the same credential, so there is exactly one thing to revoke and one
   authority to verify. Rotation happens on refresh.
4. Idempotency+ optimistic lock TTLs (`Idemop-Key` 24h, Redis fast path) —
   implement at B08.