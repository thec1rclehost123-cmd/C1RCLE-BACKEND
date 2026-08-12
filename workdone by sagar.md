# Work done — C1RCLE-BACKEND V2

**Author:** Sagar
**Date:** 2026-08-12
**Branch:** `main` (uncommitted working tree)
**Verification command:** `pnpm check:all`

---

## 1. Headline

The partner slice went from *"ported code with no tests and no authentication"* to
**a running, authenticated, durably-stored API with 133 passing tests**.

| Gate | Before | After |
|---|---|---|
| `pnpm check` | ❌ **did not build** (`packages/core` had no `@types/node`) | ✅ green |
| Tests | 26 (gateway only) | **133** (contracts 12 · core 69 · gateway 52) |
| Cross-repo contract parity | script referenced but **missing** | ✅ 33 behavioural checks |
| Authentication | **none** — every route open | ✅ Better Auth, membership-verified |
| Tenancy | `X-Organization-Id` trusted from the client | ✅ verified against real membership |
| Storage | in-memory only | ✅ durable SQLite behind the ports |
| Idempotency | header parsed and discarded | ✅ replay / reuse-409 / one-winner |
| Optimistic locking | optional on 2 of 3 resources | ✅ required on every PATCH |

Tasks completed this session: **B08, B09, B10, B11, B12**, plus the previously
unmet test gates for **B02, B04, B06, B07**.

---

## 2. What was built, task by task

### B08 — Idempotency + optimistic locking (= T09 + T10)

- `IdempotencyStore` port keyed on the triple `{ actorId, commandName, idempotencyKey }`,
  so a leaked or guessed client key can never address another actor's stored
  response, nor a different command by the same actor.
- Gateway plugin implementing **replay** (byte-identical stored body),
  **409 on key reuse with a different payload**, and **409 for a concurrent
  in-flight duplicate** — exactly one winner.
- Only **2xx** responses are stored. A failed command produced no durable
  result, so its key is released and stays retryable; otherwise one transient
  500 would poison the key for 24 hours.
- Requiredness lives in the route's **header schema**, not the plugin, so a
  missing key is an ordinary 422 with `fieldErrors` like any other header.
- `If-Match` is now **required on every partner PATCH**; a `version` in the body
  is rejected rather than silently ignored. Conflicts return
  `details: { expectedVersion, currentVersion }` so the retry loop is mechanical.

**Files:** `domain/ports/idempotency.ts`, `infrastructure/memory/memory-idempotency-store.ts`,
`plugins/idempotency.ts` · **Tests:** 7 + 5

### B09 — Outbox, event bus, audit, DLQ (= T11–T13)

- Versioned domain events with an explicit `schemaVersion`, so a consumer can
  refuse a payload it does not understand instead of mis-reading it.
- `UnitOfWork` + `OutboxWriter`: the event commits in the **same unit of work**
  as the business write it describes. A failed transaction leaves no event
  behind; a crash after commit leaves the row for retry.
- In-process `EventBus` that records which `(eventId, consumer)` pairs already
  succeeded — so a retry after a partial failure re-runs **only** the consumer
  that actually failed. Delivery is at-least-once; effect is exactly-once.
- Audit consumer (rule 13: audit never written from a route). The **event id is
  the audit id**, so replay cannot fork the trail.
- Dead-letter after 10 attempts, error trail retained, logged as an operational
  signal — never a silent drop.

**Files:** `domain/events/domain-events.ts`, `domain/ports/outbox.ts`,
`application/outbox/{event-bus,audit-consumer}.ts`, `infrastructure/memory/memory-outbox.ts`
· **Tests:** 7

### B10 — Auth, RBAC + ABAC, rate limiting, cache

- **Better Auth** (D-001 honoured) with the bearer plugin. `accessToken` **is**
  the session token: the httpOnly cookie and the in-memory bearer are the same
  credential, so there is one thing to revoke and one authority to verify.
- Routes exactly as the frontend contract requires: `POST /auth/login`,
  `/auth/refresh`, `/auth/logout`, `GET /auth/session`, plus `/auth/sign-up`.
- **The security fix that mattered most:** the order is now
  *verify credential → resolve requested tenant → **prove membership** → derive
  role from that membership*. `X-Organization-Id` is a request to act in a
  tenant, never proof of it.
- RBAC role→permission table, default deny; ABAC requires the `:organizationId`
  in the **path** to equal the actor's verified organization.
- Rate limiting on a compound key (IP + user + org) — IP alone punishes everyone
  behind a NAT, user alone lets anonymous floods through. `SENSITIVE_COMMAND`
  covers login/refresh with `Retry-After`.
- Response cache with tenant-scoped keys taken from the **verified** actor, so a
  forged header cannot address an entry; `NO_STORE` classes are never written.

**Files:** `auth/{auth-instance,auth-context}.ts`, `routes/v2/auth.ts`,
`plugins/{rbac,rate-limit,cache}.ts` · **Tests:** 14

### B11 — Remaining routes + manifest authority

- Event lifecycle actions: `review`, `publish`, `pause-sales`, `resume-sales`,
  `cancel`, `duplicate` — each idempotent and version-locked — plus `previews`.
- Organization `members` list + invite; venue `profile` and `slot-requests`.
- The manifest is now **declarative**: a test diffs the declared table against
  what Fastify actually registered **in both directions**, asserts every BLOCKED
  path 404s, and asserts nothing anywhere answers 501.
- End-to-end journey test: org → venue → slot request → event → review →
  publish → previews, with the audit trail verified afterwards.

**Files:** `routes/v2/route-manifest.ts` (+ test), route modules
· **Tests:** 5 + 3 + 5 + 7

### B12 — Durable storage

- **One repository contract suite, run against every adapter** — 10 cases × 2
  engines. This is what makes "storage is an implementation detail" a fact
  rather than a claim: an adapter that cannot pass it cannot be used.
- SQLite adapters on Node's **built-in `node:sqlite`** (no new dependency).
  Keyset pagination (never offset), and `runInTransaction` is a **real SQL
  transaction**, so the business row and its outbox row commit or roll back
  together — the guarantee the memory adapter can only approximate.
- `STORAGE_DRIVER=memory|sqlite` selects the engine. Production **fails startup**
  on `memory` (fail closed).
- A test drives the real HTTP surface and then reads the rows back **off disk**.

**Files:** `infrastructure/repository-contract.ts`,
`infrastructure/sqlite/sqlite-repositories.ts` · **Tests:** 23 + 2

### Previously-unmet gates closed (B02, B04, B06, B07)

These tasks had shipped code but no tests, so their exit gates were never
actually met. Written fresh:

- **B02** — 12 contract fixture tests, plus `scripts/contract-parity.mjs`:
  33 **behavioural** checks that run the same fixtures through the frontend's
  compiled schemas *and* ours and require identical accept/reject verdicts.
  A formatting change can never fail it; a real constraint change always will
  (verified by deliberately breaking `userSchema.email` and watching it fail).
- **B04** — 25 domain tests; the event transition table is asserted
  **exhaustively** (every from × to pair).
- **B06/B07** — repository round-trips and 14 service tests.

---

## 3. Key findings

### 3.1 The T-series reference does not exist on this machine 🔴

`task.md` claims T01–T08 are "verified live and green" in the sibling
`thec1rcle` repo, with specific test counts (16/16, 5/5, 18/18).

**Verified today: no branch of the local `thec1rcle` clone contains
`packages/core/src/application/`, `domain/ports/`, `docs/V2-Partners_Frontend/`,
or any `t05/t07/t08` suite — and no commit in its entire history ever added
them** (`git log --all -S"createCoreConfig" --diff-filter=A` returns nothing).

Consequences:

- The T-series test suites **could not be ported**. The core tests here were
  written fresh against the code that is actually present.
- **B13's parity harness cannot run as specified** — it compares this V2 against
  those frozen services, which are not here.
- Either that work lives in a different clone/machine, or it was never
  committed. Worth resolving with whoever produced it.

A correction notice is now at the top of `task.md`.

### 3.2 `pnpm check` had never been green 🔴

`packages/core` declared **no dependencies at all** while `config/index.ts`
imports `crypto`, so `@c1rcle/core:build` failed with
`TS2307: Cannot find module 'crypto'`. Whatever produced the
"`pnpm check` — green" claim in `architecture.md`, it did not hold in this tree.
Fixed by adding `@types/node`.

### 3.3 `publish()` could never succeed 🔴

`EVENT_TRANSITIONS` has no `review → published` edge, and no route or service
reached `scheduled`. An event sent to review was therefore **permanently
unpublishable** — the core action of the whole slice. Fixed by having `publish`
walk `review → scheduled → published`, one validated edge at a time, so the
table stays the single authority. `draft → published` remains illegal: review is
not skippable. *(D-012)*

### 3.4 404s and 5xx were unparseable by the frontend 🔴

Routes sent the flat envelope `{ code, message, status, requestId }`, but
`setNotFoundHandler` and `setErrorHandler` wrapped the same body in
`{ error: … }`. The frontend's `ApiClientError` parses the flat shape, so it
would have failed on precisely the errors it most needs to understand. The old
test asserted the wrapped shape — it encoded the bug. *(D-011)*

### 3.5 Every route module built its own repositories 🟠

Each of `organizations.ts`, `venues.ts`, `events.ts` called `createV2Services()`
at import time, producing **three separate in-memory stores**. An organization
created through one route was invisible to another. Now one shared bundle,
resolved per call so tests can reset it.

### 3.6 Manifest vs implementation disagreed on security policy 🟠

The route manifest marks every partner write `idempotency: REQUIRED` and every
PATCH `expectedVersion: REQUIRED`. The code had both `.optional()` on venues and
events, and the service **skips** its version check when `expectedVersion` is
null — so two of three resources silently permitted lost updates.

### 3.7 The response-envelope conflict is doc-vs-frontend 🟡

The manifest's response rule is `Strict DTO in { data, meta }`; the frontend
contract is a bare DTO / `{ items, pageInfo }`. **The code is right and the
manifest is stale** (it predates the frontend). Recorded so nobody "fixes" it
the wrong way later.

### 3.8 There is no OpenAPI in this repo 🟡

The frozen repo shipped `src/openapi/v2-partner.ts` + a JSON endpoint (T06);
it was never ported. The live surface has no machine-readable description.

---

## 4. Decisions recorded

| ID | Decision |
|---|---|
| **D-008** | Idempotency: key triple, 2xx-only storage, requiredness enforced by the route schema |
| **D-009** | `If-Match` is the only version authority; a body `version` is rejected, not ignored |
| **D-010** | First durable adapter is **SQLite, not Firestore** (amends D-002) — Firestore cannot be executed here without credentials or an emulator, and untested storage code is worse than none. The ports are unchanged, so Firestore/Postgres slot in behind the same contract suite. |
| **D-011** | One flat error envelope from every path |
| **D-012** | `publish` walks the FSM instead of widening the transition table |
| D-001 | Resolved: `accessToken` **is** the Better Auth session token |

---

## 5. Test inventory (133)

| Suite | Tests | Proves |
|---|---:|---|
| `packages/core/src/domain/domain.test.ts` | 25 | FSM exhaustively, versioning, membership rules |
| `packages/core/src/infrastructure/repositories.test.ts` | 23 | Contract suite × memory + SQLite; real transaction rollback |
| `packages/core/src/application/services.test.ts` | 14 | Services, tenancy, version conflict |
| `packages/core/src/application/outbox/outbox.test.ts` | 7 | One audit record per publish, retry, DLQ |
| `packages/contracts/src/contracts.test.ts` | 12 | Wire fixtures + locked status→code table |
| `apps/api-gateway/src/auth/auth.test.ts` | 14 | Reload-from-cookie, IDOR, ABAC, throttling |
| `apps/api-gateway/src/plugins/idempotency.test.ts` | 7 | Replay, reuse, concurrency, TTL, per-actor scope |
| `apps/api-gateway/src/routes/v2/partner/events.test.ts` | 7 | Four validation layers |
| `.../optimistic-locking.test.ts` | 5 | Stale → 409 → refetch → success |
| `.../organizations.test.ts` | 5 | Thin-route behaviour |
| `.../route-manifest.test.ts` | 5 | Declaration ↔ registration, BLOCKED 404, never 501 |
| `.../partner-journey.test.ts` | 3 | Full journey end to end |
| `apps/api-gateway/src/lib/durable-storage.test.ts` | 2 | Rows land on disk and survive restart |
| `apps/api-gateway/src/app.test.ts` | 4 | Boot, request id, 404 envelope |

Plus **33** cross-repo contract-parity checks (`node scripts/contract-parity.mjs`).

---

## 6. What is NOT done

### Blocked

- **B13 parity harness** — compares this V2 against the frozen T01–T08 services,
  which are absent (see §3.1). Only the contract half exists.
- **B15 V1 freeze/removal** — needs 7 days of zero-traffic evidence against a
  running V1.

### Not started

- **B14 frontend switch** — requires editing `C1RCLE-FRONTEND` (token provider,
  `onUnauthorized` → refresh, first real screens). Stopped at the backend
  boundary rather than modify a second repo unasked.

### Gaps inside "done"

1. **Sessions are not durable.** Better Auth still uses its memory adapter — a
   restart logs everyone out and instances do not share sessions. Business data
   *is* durable; credentials are not.
2. **Idempotency records are not durable** either, so replay protection resets
   on restart.
3. **Partial storage migration** — slot-requests, event-catalog and analytics
   are still memory-only.
4. **No invitations model** — `organization-invitations.*` cannot be built until
   the domain has one; members are added directly today.
5. **Paths are `/api/v2/partner/*`**, not the manifest's org-nested shape
   (open question 2, still unresolved).
6. **The outbox relay is driven manually** — no scheduler; a worker process owns
   it from the next slice.
7. **No OpenAPI** (see §3.8).

---

## 7. How to verify

```bash
pnpm check          # format → lint → typecheck → boundaries → test → build
pnpm check:all      # the above + cross-repo contract parity
pnpm contract-parity

# run on durable storage
STORAGE_DRIVER=sqlite SQLITE_PATH=.data/c1rcle.sqlite pnpm dev
```

Current result: **6/6 turbo tasks green, 133 tests passing, guardrails clean,
33 parity checks clean.**

---

## 8. Suggested next steps

1. **Move Better Auth onto SQLite** so sessions survive a restart — the single
   biggest remaining gap between this and something deployable.
2. **Resolve §3.1** — locate the real T-series work, or formally drop the
   T↔B mapping and make this repo self-standing.
3. **B14** — wire the partner dashboard; the backend contract is ready and
   parity-checked.
4. Decide the **path shape** (open question 2) before the frontend hard-codes
   `/api/v2/partner/*`.
5. Port the **OpenAPI generator** so the contract is machine-readable again.
