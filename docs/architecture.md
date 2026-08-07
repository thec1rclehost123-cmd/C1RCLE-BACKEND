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
  ├─ routes/v2/route-manifest.ts → registered routes (manifest authority)
  │    └─ routes/v2/internal/*  (health/version/readiness — ACTIVE)
  │    └─ (TODO B10) auth · (TODO B11) org/venue/event route modules
  │         └─ thin route = validate → auth → policy → ONE service call → serialize
  └─ config/index.ts         (SOLE process.env owner; validated, fails fast)
        ▼ (injects CoreConfig + repositories + logger)
packages/core  (@c1rcle/core — pure TypeScript, zero infra imports)
  ├─ application/*.ts        (services orchestrate; throw typed DomainError)
  ├─ domain/models/*.ts      (aggregates + explicit FSMs; versioned entities)
  ├─ domain/ports/repos.ts   (repository INTERFACES — storage-agnostic)
  └─ infrastructure/memory/  (in-memory adapter — dev/test; Firestore/Postgres later)
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

### Built (matches `pnpm check` = green)
- [x] `apps/api-gateway` Fastify 5 factory + `x-request-id` + redaction + V2 error envelope + internal health/version/readiness + 404-not-501.
- [x] `packages/contracts` + `packages/core` monorepo wiring (turbo build/lint/typecheck/test).
- [x] Contract schemas + error envelope (mirrors frontend).
- [x] Config (fail-closed, injected), telemetry port, boundary/guardrail script.
- [x] Domain models + FSM + error types + versioning.
- [x] Repository interfaces (T07) + in-memory adapters.
- [x] Application services: organizations/venues/events/event-catalog/analytics (+ `ActorContext`, lazy DI via `ServiceDeps`).
- [x] `pnpm check` — format → lint → typecheck → boundaries → test → build; `app.test.ts` smoke tests pass (health 200, x-request-id echo, blocked→404).

### Pending (order from `task.md`)
- [ ] B09 Outbox + event bus skeleton (publish→audit once, retry-safe).
- [ ] B10 Auth: Better Auth (httpOnly refresh cookie + bearer) — login/refresh/logout/session, RBAC+ABAC, rate-limit, cache plugin. (The sessions backend face + frontend bridge `{ user, accessToken, expiresAt }`.)
- [ ] B11 Vanity route modules: organizations /venues/events files wired through the services. Part of the live surface (`# §5`.
- [ ] B12 storage adapters (Firestore first behind ports, transactional outbox+optimistic lock).
- [ ] B13 parity harness vs frozen `thec1rcle` reference + contract parity script.
- [ ] B14/B15 frontend switch + old-backend freeze/removal (after zero-use proof).

---

## 7. How to run / verify (from `C1RCLE-BACKEND/`)

```bash
pnpm check                  # format:check → lint → typecheck → boundaries → test → build
pnpm dev                   # turbo dev (api-gateway on :8080, tsx watch)
pnpm boundaries            # architecture guardrails
node scripts/check-boundaries.mjs   # the same, direct
```

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