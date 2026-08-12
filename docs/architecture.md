# C1RCLE-BACKEND — Architecture & Design Documentation

> Living document, updated as the V2 backend is built. It records **what** was
> built, **why it is exactly that way**, **how it helps the frontend**,
> **how data flows from the API gateway down to storage**, and **every
> security decision**. The frontend (`C1RCLE-FRONTEND`) is the *wire
> contract*; this repo is the *backend authority*.

---

## 1. Why this repo exists (one-paragraph truth)

`C1RCLE-FRONTEND` ships a fully built `@c1rcle/api-client` that talks to
`NEXT_PUBLIC_API_BASE_URL` (dev default `http://localhost:8080`). That client
is **non-negotiable** — it defines the wire format, the error envelope, the
zod schemas, and the auth session shape the backend must satisfy. So this
repo, `C1RCLE-BACKEND`, builds the backend that *meets that contract exactly*:
a Fastify 5 modular monolith in a fresh pnpm monorepo that serves `/api/v2`.
The frontend never talks to a database — ever. **Frontend asks. Backend
decides. Database remembers.**

---

## 2. The one request, end to end

```text
C1RCLE-FRONTEND (React/Next 16, Expo)
  └─ @c1rcle/api-client            (ONLY network client; owns base URL, auth,
  │                                 retries, timeouts, typed errors, x-request-id)
  └─ @c1rcle/auth/session-store   (access token IN MEMORY only; httpOnly cookie owned by backend)
        │  HTTP/1.1  http://localhost:8080
        ▼
apps/api-gateway  (Fastify 5, port 8080)
  ├─ lib/request-tracing.ts   → mint/echo x-request-id (request.id)
  ├─ plugins/error-handler.ts → canonical V2 error envelope
  ├─ plugins/rate-limit → auth → rbac → cache → idempotency   (in this order)
  ├─ routes/v2/route-manifest.ts → DECLARED routes; a test diffs declaration
  │    │                            against registration in both directions
  │    ├─ routes/v2/internal/*  (health/version/readiness — no auth)
  │    ├─ routes/v2/auth.ts     (login · refresh · logout · session · sign-up)
  │    └─ routes/v2/partner/*   (organizations · venues · events)
  │         └─ thin route = rate-limit → authenticate → permission → validate
  │                         → idempotency → ONE service call → validate response
  └─ config/index.ts         (SOLE process.env owner; validated, fails fast)
        ▼ (injects CoreConfig + repositories + outbox + logger)
packages/core  (@c1rcle/core — pure TypeScript, zero infra imports)
  ├─ application/*.ts        (services orchestrate; throw typed DomainError)
  ├─ domain/models/*.ts      (aggregates + explicit FSMs; versioned entities)
  ├─ domain/ports/*.ts       (repository · idempotency · outbox INTERFACES)
  ├─ application/outbox/     (EventBus + OutboxRelay + audit consumer)
  ├─ infrastructure/memory/  (dev/test adapter)
  └─ infrastructure/sqlite/  (DURABLE adapter — same ports, same contract suite)
packages/contracts           (zod wire schemas + error envelope — mirrors frontend 1:1)
```

**Data is collected by the gateway, not the frontend.** The frontend sends
`{ body, headers, x-request-id, Bearer }`; the gateway parses and validates it,
resolves *who* is asking (`actor`), checks *scope* (org match), calls **one**
domain service; the service applies pure domain rules and persists through a
repository port; the gateway re-validates the response against the zod schema
before sending it out. **No route file ever touches a database; no domain file
ever reads `process.env`; no frontend code ever runs a query.**

---

## 3. Layers and every file — what and why

### 3.1 `packages/contracts` — the wire contract (the interface the frontend sees)

| File | What | Why every line is that way |
|---|---|---|
| `src/client.ts` | zod v4 schemas: `roleSchema`, `userSchema`, `sessionSchema`, `pageInfoSchema`, `paginatedSchema`, `noContentSchema`, `opaqueIdSchema`, `paginationQuerySchema`, `idempotencyKeySchema`, `versionHeaderSchema`, `organizationIdSchema`, `eventDtoSchema`, `organizationDtoSchema`, `venueDtoSchema`, request DTOs | **Exact mirror of `C1RCLE-FRONTEND/packages/types/src/client.ts` + `schemas.ts`** so both repos share one contract. `z.email()`, `z.url()`, `z.iso.datetime()` are zod v4 natives — no hand-rolled regex chains. `noContentSchema` encodes the 204-semantics. Page-shaped pagination matches the frontend `PageInfo{page,pageSize,total,hasNextPage}`. |
| `src/index.ts` | `ApiErrorCode` union, `FieldErrors`, `RequestId`, `ApiError`, `buildV2ErrorResponse`, `errorCodeForStatus`, `STATUS_CODE_TO_ERROR_CODE`, `zodToFieldErrors` | Error envelope is **backend-owned and single-sourced**. The 400/422→`validation`, 401→`unauthorized`, 403→`forbidden`, 404→`not_found`, 409→`conflict`, 429→`rate_limited`, ≥500→`server` map is exactly what the frontend `statusToErrorCode` implements. |

### 3.2 `packages/core` — pure domain (no Fastify/React/Firebase/`process.env`)

| File | Why |
|---|---|
| `src/config/index.ts` | `createCoreConfig` — **injected** clock, id-gen, redis, firestore, features. Line-level: `if (!input.redis.url.length) throw CoreConfigError` = **fail closed** (rule 9). It is *constructor/DI only*: callers (the gateway) read env once in their own config module and hand this in. |
| `src/domain/identity.ts` | `newVersionedEntity`/`bumpVersion` — every mutable aggregate carries `version`+`updatedAt` for optimistic locking (T10). `version` starts at 1 and increments per write. |
| `src/domain/fsm.ts` | `transitionStatus(from,to,table)`: **same-state = idempotent no-op** (retry-safe); anything unlisted → `StateTransitionError`. |
| `src/domain/errors.ts` | Typed `DomainError` with `code`. `OrganizationNotFoundError`, `ForbiddenError`, `VersionConflictError`, `StateTransitionError`, `InvalidOperationError`. **No HTTP, no Firestore, no env** — the gateway maps codes→HTTP (see error-handler). |
| `src/domain/models/organization.ts` | Org aggregate with explicit `OrganizationRole('owner'|'admin'|'manager'|'member')` + `Capability('host'|'venue'|'promoter')`. `addMember` rejects duplicates; `updateMemberRole` refuses demoting owner; `suspendOrganization` is idempotent. **Business rules in the model, not routes.** |
| `src/domain/models/venue.ts` | Venue with **public/private field split** (guest-facing vs partner-owning contact details) so serialization can never leak contact info. Slots + SlotRequest with their own FSM (`pending→accepted/rejected`, `accepted→cancelled`). |
| `src/domain/models/event.ts` | Event + explicit `EVENT_TRANSITIONS` table `draft→review→scheduled→published⇄sales_paused→started→ended→archived`, any→`cancelled`. `transitionEvent` validates before mutating; cancelled is terminal. `isPublic` derived (`published|sales_paused|started`), never free-text. |
| `src/domain/models/event-catalog.ts` | Ticket tiers (paise integer money), promo codes (percent bounds 0<..<=100, fixed≥0), table packages, promoter assignments (frozen commission `terms`). |
| `src/domain/ports/repositories.ts` | **The T07 contract.** Interface-only (`OrganizationRepository`, `VenueRepository`, `SlotRequestRepository`, ..., `AnalyticsReadModelRepository`) with cursor pagination, `TxContext` on writes, and **zero Firestore/Postgres types in signatures** — storage stays swappable (Firestore now, Postgres later). |
| `src/application/context.ts` | `ActorContext{userId,organizationId,role,capabilities}` + `ServiceDeps` (config+logger+repos, all injected) + `requireOrgAccess` which throws `ForbiddenError` on cross-tenant access. |
| `src/application/*/*-service.ts` | One service per use-case: list/create/get/update/invite (organizations), venue/profile/calendar/slot-requests, event lifecycle (review/publish/pause/resume/cancel/duplicate), event-catalog, analytics (read-model-only, always precomputed). Services throw typed domain errors; **never return raw HTTP**. |
| `src/infrastructure/memory/memory-repositories.ts` | In-memory adapters implementing each port (Map-backed, cursor slice). Zero infra imports — the parity / dev / test storage until a real adapter (Firestore first, Postgres later) lands (B12). |
| `src/domain/events/domain-events.ts` | Versioned domain events. `schemaVersion` is explicit so a consumer can refuse a payload it does not understand rather than mis-read it. |
| `src/domain/ports/idempotency.ts` | `IdempotencyStore` + the key triple `{actorId, commandName, idempotencyKey}` — a client key alone can never address a stored response. |
| `src/domain/ports/outbox.ts` | `OutboxWriter`/`OutboxReader`/`UnitOfWork` + `AuditRepository`. The event commits in the SAME unit of work as the write it describes. |
| `src/application/outbox/event-bus.ts` | In-process bus + relay. Remembers `(eventId, consumer)` pairs that succeeded, so a retry re-runs only the consumers that actually failed. DLQ after 10 attempts. |
| `src/application/outbox/audit-consumer.ts` | Rule 13: audit writes go through the repository, never a route. Uses the event id as the audit id, so replay cannot fork the trail. |
| `src/infrastructure/repository-contract.ts` | **One suite, every adapter.** What makes "storage is an implementation detail" a fact instead of a claim. |
| `src/infrastructure/sqlite/sqlite-repositories.ts` | Durable adapters on Node's built-in `node:sqlite`. Keyset pagination (never offset); `runInTransaction` is a real SQL transaction, so business row + outbox row commit or roll back together. |
| `src/telemetry/logger.ts` | `Logger` port + `noopLogger` + `createLogger`. Domain depends ONLY on this interface (never pino/Sentry/Fastify). Log level/redaction configured by the adapter (DI), never by `package.json/core`. |

### 3.3 `apps/api-gateway` — transport (validates, decides, enforces)

| File | Why |
|---|---|
| `src/app.ts` | `buildServer()` factory — **pure builder**, config/loggers injected. `genReqId`, `disableRequestLogging`, pino `redact` from `logger-config.ts`, `onRequest` hook to echo `x-request-id`, `setErrorHandler` (canonical V2 envelope), `setNotFoundHandler` (404 + envelope — **never a 501**), then `registerV2Routes`. Tests call `buildApp({})` + `app.inject()` — no port binding. |
| `src/server.ts` | The only place that (a) reads env via `getGatewayConfig()`, (b) listens on `PORT` (8080) / `HOST`. Fatal startup errors `process.exit(1)` (fail closed). |
| `src/config/index.ts` | **THE ONLY `process.env` reader (guardrail-enforced).** zod-validates (`PORT`, `HOST`, `LOG_LEVEL`, `REDIS_URL`, `FIRESTORE_PROJECT_ID`) on cold start; invalid → `GatewayConfigError` (fail fast) before any route serves. |
| `src/lib/request-tracing.ts` | `genReqId`: echo a valid client `x-request-id`, else mint UUID. `onRequestHook` puts it on `reply`. This is the `requestId` that travels back into every frontend `ApiClientError.requestId` and every log line. |
| `src/lib/logger-config.ts` | `redactPaths` (authorization/cookie/x-api-key, `*razorpay_*`, `*secret`, `*token*`, `*refreshToken*`) — **secrets never hit logs**. Also the canonical field names (`requestId`, `userId`, `organizationId`, `clientIp`, `route`, `method`, `statusCode`, `durationMs`). |
| `src/plugins/error-handler.ts` | Maps `DomainError`→`(status,code,message)` (403 forbidden, 404 not_found for all *-not-found, 409 conflict for VersionConflict + StateTransition, 400 validation for InvalidOperation, else 500). **5xx internals never leak** (`body.message = 'Internal server error'` after logging). Everything not a domain error falls back to Fastify status + code map. |
| `src/routes/v2/route-manifest.ts` | The single registration authority (T14 pattern). Right now registers `internalRoutes` under `/api/v2/internal`. **BLOCKED slices (orders/payments/…) exist here only as `TODO` comments — they are absent, so they 404 by absence, never a 501 stub.** |
| `src/routes/v2/internal/index.ts` | `/health`, `/version`, `/readiness` (no auth). Return the V2 success shape. Known: version hard-coded in dev (no `process.env` in routes — the guardrail would flag it). |
| `src/app.test.ts` | Boot smoke tests: health 200, x-request-id echo, **blocked path → 404 with V2 envelope**, version string. These encode the "404 never 501" rule. |

### 3.3b New gateway files (B08–B12)

| File | Why |
|---|---|
| `src/auth/auth-instance.ts` | Better Auth with the bearer plugin: the httpOnly cookie and the in-memory token are the SAME credential, so there is one thing to revoke and one authority to verify. |
| `src/auth/auth-context.ts` | Verify credential → resolve requested tenant → **prove membership** → derive role from the membership. `X-Organization-Id` is a request to act in a tenant, never proof of it. |
| `src/plugins/rbac.ts` | Role→permission table (default deny) + ABAC: the `:organizationId` in the PATH must equal the actor's verified organization. |
| `src/plugins/rate-limit.ts` | Compound key IP+user+org. IP alone punishes a NAT; user alone lets anonymous floods through. |
| `src/plugins/idempotency.ts` | Replay / reuse-409 / one-winner. Stores only 2xx, so a failed command leaves the key retryable instead of poisoned for 24h. |
| `src/plugins/cache.ts` | Tenant-scoped keys from the VERIFIED actor (a forged header cannot address an entry); `NO_STORE` classes are never written. |
| `src/test-utils/app-harness.ts` | Test doubles live only here (rule 10); excluded from the build. |

### 3.4 Root tooling (why)

- `eslint.config.mjs` — flat config, strictTypeChecked with a lean of
  ported-code exemptions (require-await/no-empty-function/no-unnecessary-condition
  off: the memory adapters are async-by-contract and the code deliberately does
  fail-closed `if (!x)` guards); adds `import-x/order`, `no-restricted-imports`
  (deep imports), `no-restricted-syntax` (process.env outside gateway config),
  and a **config-file override** so `*.config.mjs`/scripts aren't run as
  type-aware TS.
- `scripts/check-boundaries.mjs` — the **architecture guardrail**: walks
  sources (skips `dist/`, `*.test.ts`, comments) and fails on ① `process.env`
  in core packages; ② `fetch()` outside the transport; ③ backend SDK imports
  in domain/service code; ④ `.collection(`/`.doc(` in route files. This is
  what makes "no direct frontend-DB, backend-decides" mechanically true.
- `turbo.json` — `tasks` (turbo 2.7+ schema), build depends on `^build` for
  package topological builds; `test` depends on `build` (parity-true);
- `.prettierignore` keeps `pnpm-lock.yaml`, `dist/`, `.turbo/`, `*.md` out
  (docs are prose, not linted).

---

## 4. How this backend collects data for the frontend (the "no direct frontend class" guarantee+)

The frontend never instantiates a database or fetches raw. **It sends one
`@c1rcle/api-client` request per screen.** The backend *collects* data by:

1. **Parsing** headers/params/query/body against the contracts zod schemas (B05) —
   mismatch → `422` with `fieldErrors`, no service call.
2. **Resolving the actor** (`ActorContext`) from the Better Auth / Bearer
   credential (B10) — who acts, which org, which role/capabilities.
3. **Policy + scope** (RBAC+ABAC plugin) — `actor.organizationId` must equal the
   `:organizationId` path param / `X-Organization-Id`; default deny; mismatch →
   `403`, **never a resource-not-found leak** (IDOR-safe).
4. **One application-service call** — the service owns business decisions
   (FSM transitions, version checks, inventory checks), and persists via the
   repository port.
5. **Serialization** — response is re-validated against the contracts zod schema
   (mismatch → 500, *never leak a raw doc*); pagination is emitted as
   page-based `PageInfo`, matching the frontend.
6. **Optimistic locking + idempotency** (B08) — `If-Match: version` yields
   `409 conflict` (never silent overwrite); `Idempotency-Key` replay returns
   the stored response instead of double-writing.
7. **Events + outbox** (B09) — business write + event row in one unit of work;
   consumers (audit, projections) react later — no service-to-service calls.

---

## 5. Security (every rule, wired in)

- **Fail closed** — missing env/keys/config/unknown-state → error, never silent default (config zod, `GatewayConfigError`, domain fail-loud).
- **No secrets in logs** — pino `redact` (`authorization`, `cookie`, `x-api-key`, `*secret*`, `*token*`, `*razorpay_*`).
- **No secrets in code** — `.env.example` placeholders; `.env*` gitignored.
- **Boundary guardrails** — `scripts/check-boundaries.mjs` mechanically enforces frontend asks/backend decides/no env in domain/no DB in routes; **it must stay green in CI.**
- **IDOR guard** — every `fetchOwned`/`requireOrgAccess` checks caller org == resource org; owner/enumeration responses collapse to the same error (404/403) — never an oracle.
- **Optimistic locking** — `If-Match: version` → `409` on stale write (no lost update).
- **Idempotency** — `Idempotency-Key` replay → same stored response, one business result.
- **Terminal FSM** — `cancelled` event terminal; no illegal transition.
- **SSR/tenant routing** — org-scoped paths require `X-Organization-Id` == path param; header-vs-path mismatch → `403`.
- **Response pii-vetted** — venue public profile excludes contact info; event public `isPublic` not free-text; serialize-to-response revalidated by zod (no raw doc leakage).
- **Rate limit (B10)** — compound key (IP+user+org), classes PUBLIC_READ/AUTH_READ/STANDARD_COMMAND/SENSITIVE_COMMAND → `429`+`Retry-After`.
- **CSPRNG-only tokens** — access tokens derived from the session (Better Auth), never localStorage (XSS-safe in-memory only).

---

## 6. Status ledger (what's built vs pending)

> Verified by `pnpm check` on 2026-08-12: **133 tests** green
> (contracts 12 · core 69 · gateway 52), boundary guardrails clean, build clean,
> plus `node scripts/contract-parity.mjs` — 33 cross-repo checks clean.

### Built

| Task | What landed | Proof |
|---|---|---|
| B01 | Monorepo, Fastify factory, config as sole env reader, boundary guardrail | `pnpm check` |
| B02 | Contracts package + **behavioural** cross-repo parity script | `contracts.test.ts` (12), `contract-parity.mjs` (33) |
| B03 | Flat error envelope, status→code table, `zodToFieldErrors` | `contracts.test.ts` |
| B04 | Domain models + FSM + versioning | `domain.test.ts` (25), transition table asserted exhaustively |
| B05 | Validation across body/params/query/headers + response | `events.test.ts` |
| B06 | Repository ports + **one contract suite, two engines** | `repositories.test.ts` (22) |
| B07 | Application services | `services.test.ts` (14) |
| B08 | Idempotency (replay / reuse-409 / one-winner) + `If-Match` locking | `idempotency.test.ts` (7), `optimistic-locking.test.ts` (5) |
| B09 | Outbox + event bus + audit consumer + DLQ | `outbox.test.ts` (8) |
| B10 | Better Auth, membership-verified tenancy, RBAC+ABAC, rate limit, cache | `auth.test.ts` (14) |
| B11 | Event actions/previews, members, venue profile + slot-requests, declarative manifest | `route-manifest.test.ts` (5), `partner-journey.test.ts` (3) |
| B12 | SQLite adapters behind the ports; gateway runs on disk | `durable-storage.test.ts` (2) |

### Pending, and why

- **B13 parity harness — blocked as specified.** It compares this V2 against the
  frozen T01–T08 services, which do not exist in the local `thec1rcle` checkout
  (no branch, no commit in history). The contract half is done; the behavioural
  half has no reference implementation to compare against.
- **B14 frontend switch — not started.** Requires editing `C1RCLE-FRONTEND`
  (token provider, `onUnauthorized` → refresh, first real screens).
- **B15 V1 freeze/removal — blocked by definition.** Needs 7 days of zero-traffic
  evidence against a running V1.

### Known gaps inside "built"

1. **Sessions are not durable.** Better Auth still uses its memory adapter, so a
   restart logs everyone out and instances do not share sessions. Business data
   *is* durable on SQLite; credentials are not.
2. **Idempotency records are not durable** either (`MemoryIdempotencyStore`), so
   replay protection resets on restart.
3. **Partial storage migration.** Slot-requests, event-catalog and analytics are
   still memory-only; their SQLite adapters land with the slices that need them.
4. **No invitations model.** `organization-invitations.*` cannot be implemented
   until the domain has one — members are added directly today.
5. **Paths are `/api/v2/partner/*`**, not the manifest's org-nested shape
   (open question 2).
6. **The relay is driven manually.** `services.relay.drain()` has no scheduler; a
   worker process owns it from the next slice.

## 7. How to run / verify (from `C1RCLE-BACKEND/`)

```bash
pnpm check           # format:check → lint → typecheck → boundaries → test → build
pnpm check:all       # the above + cross-repo contract parity
pnpm contract-parity # frontend ↔ backend contract drift (needs C1RCLE-FRONTEND)
pnpm dev             # turbo dev (api-gateway on :8080, tsx watch)
pnpm boundaries      # architecture guardrails
```

Run on durable storage:

```bash
STORAGE_DRIVER=sqlite SQLITE_PATH=.data/c1rcle.sqlite pnpm dev
```

`STORAGE_DRIVER=memory` is refused in production (fail closed).

Smoke (backend): boot → `GET http://localhost:8080/api/v2/internal/health`
=> `{ ok: true, uptimeMs }`; `GET /api/v2/internal/version`; any other
`/api/v2/*` → 404 canonical envelope.

Frontend smoke (from `C1RCLE-FRONTEND/`): `pnpm dev` → partner-dashboard on
localhost:3001, log in → create org → venue → event on the new backend (after
B10/B11).

---

## 8. Related documents

- `task.md` — the B-series execution plan (with live T↔B hand-in-hand map).
- `docs/decisions.md` — decision log (D-001 … D-007 + open questions).
- `docs/v2-reference/` — **self-contained copy** of the authoritative V2
  docs from the frozen `thec1rcle` repo (`docs/V2-Partners_Frontend/*`):
  - `task.md` — T-series (gateway build authority)
  - `route-manifest.ts` + `API_V2_ROUTE_MANIFEST.md` — route surface + policies
  - `API_ROUTE_CATALOG.generated.md` — generated route catalog
  - `MASTER_LAUNCH_IMPLEMENTATION_PLAN.md`, `Dream Architecture Implementation Plan.md`,
    `chatgpt_response.md` — destination architecture + rationale
- `C1RCLE-FRONTEND/packages/types/*`, `packages/api-client/src/*`, `packages/auth/src/session-store.ts` — the fixed contract this backend satisfies.