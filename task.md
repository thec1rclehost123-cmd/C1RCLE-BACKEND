# TASK.md — C1RCLE V2 Backend (new repo, serves C1RCLE-FRONTEND)

> Execution plan for the **new V2 backend** that will serve the separate
> frontend monorepo `C1RCLE-FRONTEND` (c1rcle-web). Complete tasks **one by
> one, in order**. Each task has an exit gate; do not start the next until the
> gate passes.
>
> **This repo (`C1RCLE-BACKEND`) is NEW — it is NOT the old `thec1rcle`
> monorepo.** The old repo (`thec1rcle/apps/api-gateway` + `packages/core`)
> stays frozen and is used only as a **source of proven patterns and logic to
> reuse**. We are building V2 fresh here; we are NOT integrating old V1 work.

---

### Hand-in-hand with the API-Gateway task layer (T-series)

There are TWO task plans that execute together — they must stay in sync:

| Layer                                 | File                                          | Scope                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T-series (API Gateway task layer)** | `thec1rcle/docs/V2-Partners_Frontend/task.md` | The _gateway build_: contracts, domain models/FSM, validation, repository ports, application services, outbox, route manifest, plugins, thin route modules, storage adapters, parity/switch. |
| **B-series (this backend task)**      | `C1RCLE-BACKEND/task.md` (this file)          | The _fresh backend repo_: scaffold, auth (Better Auth), ported domain/services, storage, frontend wiring.                                                                                    |

**Working rule:** every B-task below maps to a T-task. Implement T-first as the
design authority, port the verified pure logic into `C1RCLE-BACKEND`, and keep
the parity step in place. Do not advance a B-task whose T-design gate is not
met; do not invent gateway behavior here that contradicts the T-series.

### Verified T-series state (checked 2026-08-07 — do not re-do)

`thec1rcle` V2 work is FURTHER along than its own checkboxes suggest. Confirmed
live and green:

- **T01 contracts** — `packages/types/src/{index,client}.ts`,
  `packages/types/test/contract.test.mjs` (8/8).
- **T02 error envelope** — `apps/api-gateway/src/lib/api-contracts.ts`
  (map + `zodToFieldErrors`), `api-contracts.test.ts` (15/15).
- **T03 config separation** — `packages/core/src/config` (`createCoreConfig`,
  zero `process.env`), `config/index.test.ts` (8/8).
- **T04 observability** — `apps/api-gateway/src/lib/{logger-config,request-tracing}.ts`,
  `packages/core/src/telemetry/logger.ts`.
- **T05 domain models + FSM** — `packages/core/src/domain/{fsm,identity,
errors}.ts`, `domain/models/{organization,venue,event,event-catalog}.ts`,
  skeleton ports (`payment-provider`, `inventory`, `booking`, `notification`,
  `webhook`), `domain/t05.test.ts` (16/16).
- **T06 validation** — `packages/types/src/client.ts` schemas,
  `plugins/validate-v2.ts`, `lib/v2-response-validation.ts`.
- **T07 repository interfaces + memory repos** — `domain/ports/repositories.ts`,
  `src/test-utils/memory-repositories.ts`, `t07.test.ts` (5/5).
- **T08 application services — DONE, verified TODAY (18/18):**
  `packages/core/src/application/{organizations,venues,events,event-catalog,
analytics}/*.ts` + `application/context.ts` (`ServiceDeps`, `ActorContext`)
  and `application/t08.test.ts`. Run: `npx vitest run src/application/t08.test.ts`.

Implied progress beyond checkboxes: partner routes are service-backed
(`apps/api-gateway/src/routes/v2/partner/{organizations,venues,events}.ts` +
`events.test.ts` 8/8), wired via `apps/api-gateway/src/lib/v2-services.ts`
(memory repos, actor from request). **These are the DESIGN SPEC for the B-series
ports — copy the patterns, not the Fastify glue.**

**Port scope rule:** port these into `C1RCLE-BACKEND` exactly — domain models,
FSM, ports, memory repos, `createCoreConfig`, error envelope, request tracing,
logger redaction, the shared zod client schemas. **Never port:** V1 routes,
legacy engines (promoter-engine, heat-sorting), Firebase/Host patterns,
`apps/partner-dashboard` or old frontend glue, .env-reading domain code.

### Current status: do not trust the B01–B15 checkboxes below

This file's checkboxes are the **original design plan**, frozen at however
they looked when last hand-edited — they are not kept in sync with reality
and will drift further as more phases land. **Do not update them here** and
do not infer status from them. There is exactly one current, maintained
status source:

→ **`docs/roadmap/ROADMAP.md`** (phase-by-phase table) →
  **`docs/roadmap/phase-00-foundation.md`** (this file's B01–B15 scope, in
  full — what shipped, what was deliberately deferred and why, bugs found
  via live testing, open findings). Phase 0 = done, live-verified against
  real Firestore, as of 2026-08-13. Phases beyond it are in the roadmap's
  other phase files, not in this file at all.

Read the roadmap before starting work described anywhere below.

---

## 0. Context that must survive any session loss

### What this project is

- **Frontend (already built, do not touch its contract):** `C1RCLE-FRONTEND`
  — pnpm monorepo `c1rcle-web`, apps: `partner-dashboard`, `guest-portal`,
  `admin-console`; packages: `api-client`, `auth`, `config`, `types`,
  `hooks`, `providers`, `design-system`, `ui`, `utils`, `icons`.
- **Backend (this repo):** new Fastify 5 + TypeScript backend, pnpm monorepo,
  modular monolith, serving `/api/v2`. **Listens on port 8080**
  (`NEXT_PUBLIC_API_BASE_URL=http://localhost:8080` in frontend `.env.example`).
- **User's confirmed decisions (2026-08-07):**
  1. New sibling repo folder `C1RCLE-BACKEND` (pnpm + turbo, mirrors frontend
     factoring); **some logic is reused from the previous backend** (list in §3).
  2. **Auth = "Bigger library": Better Auth** (chosen over hand-rolled JWT and
     over Firebase). Durable credential is an httpOnly refresh cookie the
     backend owns; access token stays in memory on the client.
  3. **First slice = Auth + Organizations + Venues + Events** (the partner
     slice). No checkout/orders/payments/refunds/payouts/door/webhooks yet
     (BLOCKED per manifest).

### The frontend is the wire contract (non-negotiable)

`C1RCLE-FRONTEND/packages/api-client` is the ONLY network client and it was
built first. The backend must satisfy it exactly:

- **Base URL:** `NEXT_PUBLIC_API_BASE_URL` (absolute URL, default
  `http://localhost:8080`). Backend must run on 8080 in dev.
- **Request headers:** `accept: application/json`; `x-request-id` (UUID,
  minted per attempt); `content-type: application/json` when body;
  `authorization: Bearer <token>` when a token provider returns one;
  - caller-supplied headers.
- **Responses:** success = JSON matching the frontend zod schema, or **204**
  (no body) — frontend `#parse(schema, undefined)` handles 204. Error = JSON
  envelope the client maps via `statusToErrorCode`.
- **Error envelope (frontend `ApiClientError`):**
  `{ code, message, status, requestId, fieldErrors? }`
  with `code ∈ network|timeout|aborted|unauthorized|forbidden|not_found|conflict|validation|rate_limited|server|parse|unknown`.
  Status→code map (must match backend): 400/422→`validation`, 401→`unauthorized`,
  403→`forbidden`, 404→`not_found`, 409→`conflict`, 429→`rate_limited`,
  ≥500→`server`. `requestId` echoed from `x-request-id`.
  `fieldErrors` shape: `Record<string, string[]>`.
- **Contracts in `packages/types` (frontend) — the shared schemas to satisfy:**
  - `Role = 'guest' | 'partner' | 'admin'`
  - `User { id, email, displayName, role, avatarUrl: string | null }`
  - `Session { user, expiresAt /* Unix ms, backend owns expiry */ }`
  - `PageInfo { page, pageSize, total, hasNextPage }`
  - `Paginated<T> { items, pageInfo }`
  - `RequestId` = branded string.
- **Auth (frontend `packages/auth/src/session-store.ts`):** access token lives
  in memory only (zustand store, never localStorage — XSS-safe); durable
  credential = **httpOnly refresh cookie owned by the backend**. `getAccessToken()`
  is handed to the api-client as its token provider. On 401 the client calls
  `onUnauthorized` (session refresh hook). Session survives page reload only if
  the backend's refresh-cookie flow restores it — this is the
  **"no session breakage"** requirement.

### Architecture rules (apply to every task)

1. **Frontend asks. Backend decides. Database remembers.**
2. **Contracts are backend-owned.** `packages/contracts` + zod are the source
   of truth; the frontend imports/mirrors them (frontend already has its own
   copy; parity tests must prove they never drift — see §7).
3. **Thin routes.** Route = validate → auth → policy/scope → one service call
   → serialize. No business logic, no `db.collection()` in route files.
4. **Modular monolith.** Each domain module (auth, organizations, venues,
   events) owns its services, rules, state machine and repository interface.
5. **Storage behind interfaces.** Domain depends on `interface EventRepository`;
   adapters (in-memory now, Firestore/Postgres later) are implementation
   details. No domain file reads `process.env` or imports Fastify/Firebase.
6. **Every write endpoint is idempotent** (`Idempotency-Key`) and
   **optimistically locked** (`If-Match` / version / etag).
7. **Domain events, not service-to-service calls.** Services publish events
   through an outbox; consumers react.
8. **V1‖V2 parallel.** Old backend stays frozen; parity tests prove V2 before
   any frontend switch; V1 deleted only after zero-use proof.
9. **Fail closed.** Missing config, missing keys, unknown state → error, never
   silent fallback.
10. **No mocks in shipped code.** Test doubles live ONLY under `src/test-utils/`.
11. **Provider abstraction.** Payment/notification/search adapt behind ports.
12. **Path scoping is structural:** `/api/v2/public` | `/api/v2/partner`(or
    org-scoped root) | `/api/v2/admin` | `/api/internal`. Auth alone is never
    relied on; `X-Organization-Id` must match the `:organizationId` path param.
13. **Audit as a service.** Audit writes go through `AuditRepository`, never
    directly from a route.

---

## 1. Repo layout (this repo, to be created)

```text
C1RCLE-BACKEND/
  package.json            # pnpm workspaces + turbo (mirror frontend style)
  pnpm-workspace.yaml
  tsconfig.base.json      # strict; extends nothing expo
  turbo.json
  .npmrc
  apps/
    api-gateway/          # Fastify 5, tsx watch, port 8080
      src/
        app.ts            # buildServer() → register plugins + routes
        config/           # THE ONLY place reading process.env (validated, fail-fast)
        plugins/          # auth (Better Auth), rbac+abac, rate-limit, validate, cache, request-context
        lib/              # api-contracts (error envelope), request-tracing, logger-config (redaction)
        routes/
          v2/
            internal.ts   # /api/v2/internal/health|version|readiness
            auth.ts       # login/refresh/logout/session (Better Auth integration)
            organizations.ts
            venues.ts
            events.ts
            route-manifest.ts   # declared once, registered from manifest (T14 pattern)
      package.json
      tsconfig.json
  packages/
    contracts/            # zod schemas + types, mirroring frontend @c1rcle/types 1:1
    core/                 # domain models, FSM, services, ports, outbox, test-utils
  docs/                   # decisions, parity report, manifest snapshots
```

---

## 2. Dependencies & tooling (fixed decisions)

- **Package manager:** pnpm (workspaces + turbo), matching `C1RCLE-FRONTEND`
  (pnpm@10.x, turbo 2.x).
- **Node:** `^22.13.0 || >=24.0.0` (match frontend engines).
- **Backend framework:** Fastify 5 (`fastify@^5`), `tsx watch` for dev.
- **Validation:** zod v4 (same major as frontend).
- **Auth:** Better Auth (`better-auth`) as the auth engine — session cookie +
  refresh. Frontend needs a Bearer access token in memory: Better Auth
  sessions must be exposed to the client as `{ user, accessToken, expiresAt }`
  via the session endpoint, with the httpOnly cookie handled by the backend.
- **Tests:** vitest (like the old backend) + contract/snapshot tests.
- **Guardrails:** architecture checks (no `process.env` in domain, no
  Fastify/Firebase imports in domain, no `fetch`/axios outside the transport
  layer, no `.collection()` in routes). Mirror old repo's
  `scripts/check-backend-boundaries.mjs` approach, rewritten for this repo.
- **Lint/format:** eslint 9 flat config + prettier + typescript-eslint
  (mirror frontend conventions; frontend `@c1rcle/eslint-config` exists there,
  do NOT import across repos — copy the rules).

---

## 3. Logic to REUSE from the previous backend (`thec1rcle`) — with care

Reuse as patterns/ports/domain logic, **not by wholesale copying legacy
routers**. Sources (paths relative to `thec1rcle/`):

- `packages/core/src/domain/fsm.ts` — generic `transitionStatus` helper.
- `packages/core/src/domain/identity.ts` — `newVersionedEntity`/`bumpVersion`
  (every mutable entity carries `version` + `updatedAt`).
- `packages/core/src/domain/models/organization.ts` — Organization, Membership,
  Role, Capability (host|venue|promoter|combined).
- `packages/core/src/domain/models/venue.ts` — Venue, VenueProfile
  (private/public field split), VenueSlot, SlotRequest.
- `packages/core/src/domain/models/event.ts` — Event + EventStatus FSM
  `DRAFT → REVIEW → SCHEDULED → PUBLISHED ⇄ SALES_PAUSED → STARTED → ENDED → ARCHIVED`
  - terminal `CANCELLED`, explicit allowed-transitions map.
- `packages/core/src/domain/ports/repositories.ts` — typed repository
  interfaces (Org/Venue/SlotRequest/Event/EventCatalog/Analytics), cursor
  pagination, `TxContext`, zero Firestore types in signatures.
- `packages/core/src/test-utils/memory-repositories.ts` — memory repos for
  unit tests (zero infra imports).
- `packages/core/src/config/index.ts` — `createCoreConfig` (injected clock,
  ids, redis, firestore, features; zero `process.env`; fail-loud).
- `apps/api-gateway/src/lib/api-contracts.ts` — V2 error builder
  `buildV2ErrorResponse` + status→code map + `zodToFieldErrors`.
- `apps/api-gateway/src/lib/request-tracing.ts` — `genReqId` + onRequest hook
  (echo client-supplied `x-request-id`, mint when absent).
- `apps/api-gateway/src/lib/logger-config.ts` — redaction paths + canonical
  log field names (requestId, userId, organizationId, route, durationMs...).
- `apps/api-gateway/src/routes/v2/partner/*` — thin-route shape, header/params/
  query/body validation, `validateV2Response` response validation.
- `packages/types/src/client.ts` — zod client schemas to mirror 1:1 into
  `packages/contracts`.

**Do NOT reuse:** V1 routers, legacy engines (promoter-engine, heat-sorting,
legacy checkout/payment logic), Firebase Admin SDK patterns, `.env`-reading
domain code. Where the old backend used Firebase, the new one uses repository
interfaces with in-memory adapters first (storage decision — see §6).

---

## 4. Development order (frozen, reviewer-recommended)

1. Contracts
2. Domain models + state machines
3. Validation (payload/headers/params/query/response)
4. Repository interfaces
5. Application services
6. Event bus + outbox
7. Routes (v2 gateway)
8. Repository implementations
9. Integration + parity tests
10. Frontend switch (only after parity proof)

---

# PHASE 0 — FOUNDATION

## B01 — Repo scaffold (this repo)

**Goal:** empty monorepo that builds, lints, type-checks and tests.

> **Hand-in-hand:** mirrors T01–T04 design (contracts pkg, error envelope,
> config separation, observability). Nothing here is new design — port the
> proven files from the verified T-series and adapt package names.

**Tasks:**

- [ ] Create `C1RCLE-BACKEND` with pnpm workspaces (`apps/*`, `packages/*`),
      turbo.json, `.npmrc`, tsconfig.base.json, eslint flat config, prettier,
      vitest, husky/pre-commit hooks.
- [ ] `apps/api-gateway` skeleton: Fastify 5 `buildServer()` + `listen(8080)`,
      `/api/v2/internal/health|version|readiness` (ACTIVE per manifest),
      `genReqId`/`x-request-id` echo, request logging with redaction.
- [ ] `packages/contracts` + `packages/core` empty workspaces wired into turbo
      `build/lint/typecheck/test` pipelines.
- [ ] Env contract: `apps/api-gateway/src/config/` is the only
      `process.env` reader; validates and fails fast; exports validated
      `coreConfig` for DI.
- [ ] Boundary guardrail script (`.mjs`) that fails on:
      `process.env` in `packages/core/src/domain/**`; Fastify/Firebase imports
      in domain; `fetch` outside the gateway transport; `.collection(`/`.doc(`
      in route files.

**Exit gate:** `pnpm check` (format → lint → typecheck → boundaries → test →
build) green on the skeleton; health endpoints respond with the V2 envelope.

## B02 — Contracts package (`packages/contracts`)

**Goal:** one package defining the wire contract, mirroring
`C1RCLE-FRONTEND/packages/types` + `packages/api-client/src/schemas.ts` 1:1.

> **Hand-in-hand (T01/T06):** port the verified schemas from
> `thec1rcle/packages/types/src/client.ts` — `roleSchema`, `userSchema`,
> `sessionSchema`, `pageInfoSchema`, `paginatedSchema`, `noContentSchema`,
> `opaqueIdSchema`, `paginationQuerySchema`, `idempotencyKeySchema`,
> `versionHeaderSchema`, `eventDtoSchema`, `organizationDtoSchema`,
> `venueDtoSchema`, `organizationRoleSchema`, `venueStatusSchema`. Fix any
> drift vs the frontend's own copies in B02 contracts.

**Tasks:**

- [ ] `ApiErrorCode` union (12 codes above), `RequestId`, `ApiError`,
      `User`, `Session`, `Role`, `PageInfo`, `Paginated<T>`, `FieldErrors`.
- [ ] zod v4 runtime schemas: `roleSchema`, `userSchema`, `sessionSchema`,
      `pageInfoSchema`, `paginatedSchema`, `noContentSchema` — identical
      constraints to the frontend (`z.email()`, `z.url()` where the frontend
      uses them).
- [ ] Domain contracts (partner slice): Organization, Membership, Role,
      Capability, Venue, VenueProfile, VenueSlot, SlotRequest, Event,
      EventStatus, plus write DTOs (create/update bodies).
- [ ] Contract snapshot test: canonical fixtures parse; corrupt fixtures
      reject; **and a parity test** that diffs these schemas' JSON snapshots
      against the frontend's (see §7).

**Exit gate:** contracts build + snapshot tests green; parity test proves
frontend `@c1rcle/types` shapes match this package today.

## B03 — Error envelope + status→code mapping

**Goal:** one error shape everywhere; frontend `statusToErrorCode` matches
backend.

> **Hand-in-hand (T02):** port `buildV2ErrorResponse` + `errorCodeForStatus`
>
> - `zodToFieldErrors` + `request-id` echo from
>   `thec1rcle/apps/api-gateway/src/lib/api-contracts.ts` and
>   `lib/request-tracing.ts`. Keep V1 error shape OUT of this repo (fresh V2 only).

**Tasks:**

- [ ] `lib/api-contracts.ts`: `buildV2ErrorResponse` →
      `{ code, message, fieldErrors?, requestId, status }`;
      `errorCodeForStatus` map locked by test
      (400/422→validation, 401→unauthorized, 403→forbidden, 404→not_found,
      409→conflict, 429→rate_limited, ≥500→server).
- [ ] `zodToFieldErrors` helper (from zod flatten) → `Record<string, string[]>`.
- [ ] Domain error types (`OrganizationNotFoundError`, `ForbiddenError`,
      `VersionConflictError`, `StateTransitionError`, `AuthError`) and the
      gateway error→HTTP mapping table (tested).
- [ ] 204 semantics: writes return 204 with no body where the contract says so.

**Exit gate:** mapping unit tests green; a 422 from the gateway produces the
exact `{ code: 'validation', fieldErrors }` the frontend `ApiClientError`
parser expects.

---

# PHASE 1 — DOMAIN LAYER (transport/storage-independent)

## B04 — Domain models + state machines

**Goal:** explicit entities with explicit finite state machines.

> **Hand-in-hand (T05):** PORT the verified files as-is (pure TS, zero infra):
> `domain/{fsm,identity,errors}.ts`, `domain/models/{organization,venue,event,
event-catalog}.ts`, skeleton ports `domain/ports/{payment-provider,inventory,
booking,notification,webhook}.ts`. Re-run the T05 FSM tests here.

**Tasks:**

- [ ] Reuse/port from `thec1rcle/packages/core/src/domain/models/*`
      (organization, venue, event) and `domain/fsm.ts`, `domain/identity.ts`.
      These are pure TS, no infra imports — port them nearly as-is and adapt
      only where the new contract differs.
- [ ] `EventStatus` FSM with explicit allowed-transitions map; every
      transition validated; idempotent same-state transition is a no-op.
- [ ] Version field on every mutable entity (`version`, `updatedAt`) via the
      shared versioned-entity helper.
- [ ] Skeleton ports for future domains: `payment-provider`, `inventory`,
      `booking`, `notification`, `webhook` — interfaces only, zero
      implementation (prevents logic leaking into later slices).
- [ ] Unit tests: valid/invalid transitions, idempotent transitions.

**Exit gate:** FSM + model tests green; `pnpm lint` clean; no infra imports
in `packages/core/src/domain/**` (guardrail enforced).

## B05 — Validation schemas (all four layers)

**Goal:** payload, headers, params, query AND response validated.

> **Hand-in-hand (T06):** port the shared zod helpers from
> `thec1rcle/packages/types/src/client.ts` + the `validate-v2` plugin +
> `lib/v2-response-validation.ts` patterns (route-level response schema check
> before send).

**Tasks:**

- [ ] Per-route request schemas (zod v4 `.strict()`): create/update bodies for
      org/venue/event; `opaqueIdSchema` for `:organizationId/:venueId/:eventId`;
      `paginationQuerySchema` (bounded page+pageSize — the FRONTEND uses
      page-based `PageInfo{page,pageSize,total,hasNextPage}`, not cursor);
      headers: `X-Organization-Id`, `Idempotency-Key`, `If-Match`.
- [ ] Per-route response schemas validated before send (mismatch → 500,
      raw doc never leaked).
- [ ] `validateV2Plugin` parses headers+params+query+body; failure → 422 with
      `fieldErrors` (V2 shape only).

**Exit gate:** 422 `fieldErrors` shape asserted in tests; response-validation
failure produces the V2 envelope.

## B06 — Repository interfaces (ports)

**Goal:** domain depends on interfaces; adapters swappable.

> **Hand-in-hand (T07):** port `domain/ports/repositories.ts` +
> `test-utils/memory-repositories.ts` verbatim (they already exist and pass
> 5/5). Note: T07 used cursor pagination at repo level — keep the repo ports
> faithful, adapt only the ROUTE-level pagination to the frontend's
> page-based `PageInfo` (B05).

**Tasks:**

- [ ] `packages/core/src/domain/ports/repositories.ts`:
      `OrganizationRepository`, `VenueRepository`, `SlotRequestRepository`,
      `VenueSlotRepository`, `EventRepository`, `AuditRepository` — fully
      typed, page-based pagination, optional `TxContext` on writes, zero
      Firestore/Fastify types in signatures.
- [ ] Memory adapters in `packages/core/src/test-utils/memory-repositories.ts`
      — zero infra imports.
- [ ] Unit test: domain aggregates + repos round-trip through Memory
      repositories.

**Exit gate:** repo-port tests green with zero infra imports.

## B07 — Application services

**Goal:** one service per use case; orchestration only; rules in domain models.

> **Hand-in-hand (T08):** PORT the verified services (18/18) from
> `thec1rcle/packages/core/src/application/**` + `application/context.ts`
> (`ServiceDeps`, `ActorContext`). No `process.env`, no Fastify, no Firebase.

**Tasks:**

- [ ] `packages/core/src/application/organizations/`: list, create, get,
      update, invite-member, list-members, list-invitations.
- [ ] `packages/core/src/application/venues/`: list, create, get, update,
      profile get/update, calendar get, availability get, menu get/update,
      slot-requests list/create.
- [ ] `packages/core/src/application/events/`: list, create, get, update,
      previews get, review, publish, pause-sales, resume-sales, cancel,
      duplicate.
- [ ] Services receive injected: actor context `{ userId, organizationId,
  role, permissions }`, config, repositories, logger. They throw typed
      domain errors the gateway maps to HTTP.
- [ ] Every service unit-tested with Memory repositories; no `process.env`,
      no Fastify, no Firebase imports anywhere in `application/`.

**Exit gate:** all service tests green; guardrail (no env/fastify/firebase in
application) enforced.

## B08 — Idempotency + optimistic locking

**Goal:** retries never duplicate results; no lost updates.

> **Hand-in-hand (T09/T10):** port the T09 idempotency design (key =
> `{idempotencyKey, actorId, commandName}`, replay stored response, 24h TTL)
> and T10 `If-Match` design (version required on PATCH/PUT, 409 with current
> version). These T-tasks were NOT started in the old repo — implement fresh
> here against the ported repos.

**Tasks:**

- [x] Generalize the old `idempotency-service` pattern: key =
      `{idempotencyKey, actorId, commandName}`, first response stored + replayed,
      TTL 24h (Redis fast path when present, durable store as authority).
- [x] `Idempotency-Key` required on POST/PATCH/PUT for manifest routes marked
      `REQUIRED`; 409 on key reuse with different body; replay on same key.
- [x] `If-Match: "version"` required on PATCH/PUT (manifest `expectedVersion:
  REQUIRED`); body `version` ignored; version conflict → 409 `conflict`
      with current version in error details.
- [x] Tests: duplicate request → identical response, no second write;
      concurrent same-key → one winner; concurrent updates → one 409, retry
      after refetch succeeds.

**Exit gate:** retry/concurrency tests show exactly one business result.

---

# PHASE 2 — EVENT BUS + OUTBOX (foundation only, per docs)

## B09 — Outbox + event bus skeleton

**Goal:** every domain event survives the transaction; future consumers can
react without service-to-service calls.

> **Hand-in-hand (T11/T12/T13):** these T-tasks were not started in the old
> repo. Implement fresh here using the T-design: outbox written in the same
> unit of work as the business write, in-process EventBus, DLQ after N
> attempts. Keep it minimal (skeleton) — no Kafka, no Inngest in this slice.

**Tasks:**

- [ ] Versioned domain-event types (org/venue/event events for this slice).
- [ ] `OutboxWriter` port + in-memory implementation; event row =
      `{ id, type, aggregateId, payload, status: pending, attempts, createdAt,
  processedAt }`; written in the same unit of work as the business write
      (transaction adapter port).
- [ ] In-process `EventBus` (publish → handlers), wired to the outbox for
      durable delivery later; consumer idempotency by event ID.
- [ ] Consumers for this slice: `EventPublished → audit record`;
      `EventUpdated → audit record`; `EventPublished → (future) projection`
      (no-op consumer now, wire exists).
- [ ] Tests: publish → consumers run once; consumer failure → retry, no
      duplicate side effects; kill-after-commit does not lose the row.

**Exit gate:** one publish produces exactly one audit record even under retry.

---

# PHASE 3 — GATEWAY (v2 routes)

## B10 — Auth: Better Auth integration

**Goal:** backend-owned sessions with **no frontend breakage**.

> **Hand-in-hand (T15 auth class):** T-series auth was Firebase-ID-token
> verification. THIS backend replaces that with **Better Auth** (user's
> confirmed decision) while keeping the identical frontend contract
> (`Session { user, expiresAt }` + `Authorization: Bearer` from memory +
> httpOnly cookie owned by the backend). The frontend is the fixed contract.

**Tasks:**

- [ ] Integrate Better Auth into the Fastify app (cookie-based session,
      httpOnly, SameSite, Secure in prod; refresh/rotation enabled).
- [ ] **Frontend bridge (critical):** the frontend sends `Authorization: Bearer
  <accessToken>` from memory and needs `Session { user, expiresAt }` +
      access token from the session endpoint. Implement: - `POST /api/v2/auth/login` → sets httpOnly session cookie AND returns
      `{ user, accessToken, expiresAt }` (access token = short-lived signed
      token derived from the Better Auth session). - `POST /api/v2/auth/refresh` → verifies cookie, rotates, returns new
      `{ user, accessToken, expiresAt }` (this is the "no session breakage"
      path — page reload restores the session via the cookie). - `POST /api/v2/auth/logout` → destroys session + clears cookie. - `GET /api/v2/auth/session` (alias of manifest `session.get`) → current
      session or 401.
- [ ] RBAC + ABAC plugin: role → permission set (`organization.read`,
      `event.update`, `venue.manage`, ...); ABAC rule
      `actor.organizationId === resource.organizationId`, default deny;
      `X-Organization-Id` must match `:organizationId` path param (403 on
      mismatch).
- [ ] Rate-limit plugin (compound key: IP + user + organization; classes
      PUBLIC_READ/AUTH_READ/STANDARD_COMMAND/SENSITIVE_COMMAND; 429 +
      `Retry-After`).
- [ ] Cache plugin (private Redis later; in-memory TTL now): org 5m, venue
      profile 5m, event preview 60s, availability 30s; `NO_STORE` for anything
      sensitive; keys scoped by organization, never cross-tenant.
- [ ] Tests: login → refresh → session restore (no breakage); logout revokes;
      IDOR matrix (cross-org denied); header-vs-path org mismatch → 403;
      rate-limit bucket.

**Exit gate:** a browser can log in, reload, and still be authenticated
(cookie restore), and the in-memory access token never appears in
localStorage. IDOR + rate-limit tests green.

## B11 — v2 route modules (thin)

**Goal:** each module = manifest + schemas + service calls only.

> **Hand-in-hand (T14/T16):** port the service-backed thin-route pattern from
> `thec1rcle/apps/api-gateway/src/routes/v2/partner/*` — validate → auth →
> policy/scope → one service call → `validateV2Response` → serialize. Adapt
> pagination to the frontend page-based `PageInfo`. Use the manifest as the
> registration authority (T14).

**Tasks:**

- [ ] `routes/v2/route-manifest.ts` — declared once, registered from manifest
      (port the partner slice from `thec1rcle/docs/V2-Partners_Frontend/
  route-manifest.ts`): orgs, venues, events; everything else stays
      BLOCKED/unregistered; **BLOCKED routes 404, never 501** (test-enforced).
- [ ] `routes/v2/organizations.ts` — GET/POST `/api/v2/organizations`,
      GET/PATCH `/api/v2/organizations/:organizationId`, members + invitations
      list/invite.
- [ ] `routes/v2/venues.ts` — GET/POST
      `/api/v2/organizations/:organizationId/venues`, GET/PATCH
      `/api/v2/venues/:venueId`, profile/calendar/availability/menu/
      slot-requests per manifest.
- [ ] `routes/v2/events.ts` — GET/POST
      `/api/v2/organizations/:organizationId/events`, GET/PATCH
      `/api/v2/events/:eventId`, previews, and action posts:
      review/publish/pause-sales/resume-sales/cancel/duplicate (idempotent +
      If-Match).
- [ ] Register under `/api/v2` in `app.ts`; handler shape enforced by
      architecture test: no `.collection(`/`.doc(` in routes; no inline
      business enums duplicating domain models (import from core).
- [ ] Route tests with MemoryRepository-backed services: happy paths, 404,
      403 IDOR, 409 version/idempotency, 422 validation — all V2 envelope.

**Exit gate:** `pnpm boundaries` green; v2 route tests green; every registered
route has an ACTIVE manifest entry and vice-versa; BLOCKED paths 404.

---

# PHASE 4 — STORAGE + FRONTEND WIRING

## B12 — Storage decision + repository adapters

**Goal:** real durable storage behind the ports (no mocks in shipped code).

> **Hand-in-hand (T18):** T18 planned Firestore adapters for the old repo.
> Here they are implemented fresh behind the ported repo interfaces — same
> contract suite against Memory AND the real adapter. Record the chosen
> adapter in `docs/architecture/decisions.md`.

**Tasks:**

- [ ] Decide and implement the first real adapter. Options: Firestore (old
      stack — reuse pattern) or PostgreSQL (dream architecture) or a
      lightweight SQLite/postgres-dev setup for local. **Recommendation:** start
      with the repository interfaces + an in-memory adapter gated for dev/test
      and one real adapter (Firestore first, mirroring old repo patterns;
      Postgres later per the dream plan). Mark the decision in `docs/`.
- [ ] Transactional writes: business write + outbox event in one transaction.
- [ ] Compare-and-set for optimistic locking (B08 `expectedVersion` guard
      inside the transaction).
- [ ] Indexed queries, bounded page size; no N+1 (batch/multi-get).

**Exit gate:** repository contract suite passes against Memory AND the real
adapter (same suite, swapped dependency).

## B13 — Parity tests (V2 vs previous service behavior)

**Goal:** prove the new V2 matches the ported design behavior before any
frontend switch.

> **Hand-in-hand (T20):** T20 ran old-VS-new parity against the same data.
> Here the "old" reference is the verified T-series behavior (the ported T01–T08
> services in the frozen `thec1rcle` repo). Drive identical inputs through the
> frozen reference and this V2, assert same resulting state / core fields, and
> prove no extra fields leak.

**Tasks:**

- [ ] Parity harness: run same input through the frozen reference behavior and
      the new V2 service against the same seeded data; assert same resulting
      state, same core fields, no extra fields leaked.
- [ ] Field mapping table per resource (design contract field → V2 field |
      DROPPED) in `docs/` — only required fields carried; everything else
      explicitly DROPPED with reason.
- [ ] Contract parity: V2 response passes the zod response schema;
      `packages/contracts` snapshot matches frontend types (run the
      parity script from B02).

**Exit gate:** parity suite green for the slice; `docs/parity-report.md`
generated.

## B14 — Frontend switch (only after B10–B13 green)

**Goal:** `C1RCLE-FRONTEND` partner-dashboard talks to this backend's `/api/v2`.

> **Hand-in-hand (T21):** T21's frontend switch. In the old repo it targeted
> the old partner-dashboard; HERE it means wiring the real new frontend
> (`C1RCLE-FRONTEND`) to this backend. The frontend client already exists and
> is the contract — we only add auth wiring + the first real screens.

**Tasks:**

- [ ] In `C1RCLE-FRONTEND/apps/partner-dashboard`: `.env.example` → set
      `NEXT_PUBLIC_API_BASE_URL=http://localhost:8080` (already the default).
- [ ] Wire `@c1rcle/api-client` token provider to
      `@c1rcle/auth` `getAccessToken()` and add `onUnauthorized` →
      `POST /api/v2/auth/refresh` → `setSession` retry-once flow.
- [ ] Build the first real screens on the backend: organizations list,
      venue create/list, event create/list (feature pages in the partner app).
- [ ] Remove any mock/demo data paths; UI renders backend data only.

**Exit gate:** staging journey green on V2 for the full slice; no V1 calls
from partner UI for migrated flows; session survives reload.

## B15 — Old-backend freeze + removal (only after zero-use proof)

**Goal:** old partner-route surface dies only after proof.

> **Hand-in-hand (T22):** T22's V1 freeze + removal, scoped to the frozen
> `thec1rcle` repo: freeze its partner routes, prove zero traffic, prove no
> static consumers, then delete. Nothing in THIS repo depends on that
> deletion — the freeze only unblocks the eventual cleanup.

**Tasks:**

- [ ] Freeze old `thec1rcle` V1 partner routes (comment + governance note).
- [ ] Runtime traffic proof (route metrics show zero V1 partner traffic for
      the agreed window, e.g. 7 days).
- [ ] Static consumer proof (no repo code calls V1 partner endpoints).
- [ ] Remove V1 partner route files + exception entries; remove frontend
      proxies/legacy libs after UI is green on V2.

**Exit gate:** V1 partner routes deleted; guardrails green; parity report +
traffic evidence archived.

---

## 5. Route surface (target, this slice)

From `thec1rcle/docs/V2-Partners_Frontend/route-manifest.ts` (partner slice).
All under `/api/v2`:

- `internal.health|version|readiness` — ACTIVE (no auth).
- **Auth:** `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`,
  `GET /auth/session` (+ `GET /session` alias decision in B10).
- **Organizations:** GET/POST `/organizations`;
  GET/PATCH `/organizations/:organizationId`;
  GET `/organizations/:organizationId/members`;
  POST `/organizations/:organizationId/members` (invite);
  GET `/organizations/:organizationId/invitations`.
- **Venues:** GET/POST `/organizations/:organizationId/venues`;
  GET/PATCH `/venues/:venueId`; GET/PATCH `/venues/:venueId/profile`;
  GET `/venues/:venueId/calendar`; GET `/venues/:venueId/availability`;
  GET/PUT `/venues/:venueId/menu`;
  GET/POST `/venues/:venueId/slot-requests`.
- **Events:** GET/POST `/organizations/:organizationId/events`;
  GET/PATCH `/events/:eventId`; GET `/events/:eventId/previews`;
  POST `/events/:eventId/{review|publish|pause-sales|resume-sales|cancel|duplicate}`.

Headers: `Authorization: Bearer` (auth'd routes), `X-Organization-Id`
(org-scoped), `X-Request-Id` (echoed), `Idempotency-Key` (writes),
`If-Match: "<version>"` (PATCH/PUT).

**BLOCKED (never registered, 404):** checkout, orders, payments, refunds,
payouts, bank-accounts, door, webhooks, event-catalog writes, analytics,
admin, social, campaigns, notifications, public discovery.

---

## 6. Open decisions to confirm (resolve in `docs/architecture/decisions.md`)

1. **Storage:** Firestore-first (reuse old pattern) vs PostgreSQL now vs
   in-memory+one real adapter. (B12.)
2. **Access token mechanism** for the Better Auth bridge: signed JWT issued by
   the backend, or Better Auth's own token/session strategy — whatever keeps
   the frontend contract `{ user, accessToken, expiresAt }` intact. (B10.)
3. **Org scoping shape:** org-scoped resources nested under
   `/organizations/:organizationId/...` (manifest) — the old backend used a
   flat `/api/v2/partner` prefix; manifest wins. Confirm with frontend paths
   when wiring. (B11/B14.)
4. **Frontend env injection:** confirm `NEXT_PUBLIC_API_BASE_URL` stays
   `http://localhost:8080` for dev and the staging URL for preview/prod.

---

## 7. Contract parity mechanism (frontend ↔ this backend)

Two repos, one contract. The frontend ships its own `@c1rcle/types` +
`@c1rcle/api-client/src/schemas.ts`. The backend owns `packages/contracts`.
To keep them in lockstep **without publishing packages yet**:

- [ ] A `scripts/contract-parity.mjs` (or vitest) in this repo that reads
      `C1RCLE-FRONTEND/packages/types/src/**` + `schemas.ts`, builds JSON
      snapshots of the schemas' `shape()`/fixtures, and diffs against
      `packages/contracts` snapshots.
- [ ] Contract changes go backend-first; the parity test fails until the
      frontend copy is updated (documented in each B02/B13 gate).
- [ ] Later: publish `@c1rcle/contracts` (versioned) and pin the frontend to
      it (per old docs: "backend owns the contract; frontend imports").

---

## 8. Verification commands (run from `C1RCLE-BACKEND/`)

```
pnpm check            # format:check → lint → typecheck → boundaries → test → build
pnpm dev              # turbo dev (api-gateway on :8080 via tsx watch)
pnpm --filter api-gateway dev
pnpm test             # turbo test (vitest across workspaces)
pnpm boundaries       # architecture guardrails
node scripts/contract-parity.mjs   # frontend ↔ contracts drift check
```

Frontend smoke (from `C1RCLE-FRONTEND/`): `pnpm dev` → open
`http://localhost:3001` (partner-dashboard), log in, create org → venue →
event on the new backend.

---

## 9. Definition of done (whole plan)

- [ ] `C1RCLE-BACKEND` builds/lints/tests green; guardrails enforced.
- [ ] Contracts package mirrors frontend `@c1rcle/types` 1:1 (parity test
      green), backend-owned.
- [ ] Auth (Better Auth) with httpOnly cookie + in-memory access token;
      session survives reload; logout revokes; 401 → refresh flow works.
- [ ] Partner slice live on `/api/v2` with thin routes, RBAC+ABAC, compound
      rate limits, idempotency, optimistic locking, response validation.
- [ ] Outbox + event bus skeleton operational (publish → audit once, retry
      safe).
- [ ] Parity report green; V1 partner routes frozen, removed after zero-use
      proof.
- [ ] Partner dashboard runs real journeys on V2 (org → venue → slot request
      → event create → publish → previews).
- [ ] Every manifest route for the slice has: schema, policy, tests, cache
      class, owner.

---

## 10. Reference material (all inside `thec1rcle/` — read before changing)

- `docs/V2-Partners_Frontend/task.md` — the previous backend's V2 plan
  (patterns to mirror).
- `docs/V2-Partners_Frontend/route-manifest.ts` — the single route manifest
  source (slice = organizations, venues, events).
- `docs/V2-Partners_Frontend/MASTER_LAUNCH_IMPLEMENTATION_PLAN.md` — full
  staged program (dream architecture).
- `docs/V2-Partners_Frontend/Dream Architecture Implementation Plan.md` —
  one-backend/one-auth/one-contract destination.
- `docs/V2-Partners_Frontend/chatgpt_response.md` — modular monolith rationale.
- `docs/V2-Partners_Frontend/API_V2_ROUTE_MANIFEST.md` — route policies.
- `apps/api-gateway/src/routes/v2/partner/*`, `packages/core/src/domain/**`,
  `packages/core/src/config`, `apps/api-gateway/src/lib/*` — proven code to
  reuse (see §3).

**Frontend contract (read-only, the client is already built):**

- `C1RCLE-FRONTEND/packages/api-client/src/client.ts` — transport + errors.
- `C1RCLE-FRONTEND/packages/api-client/src/schemas.ts` — response schemas.
- `C1RCLE-FRONTEND/packages/types/src/{api,identity,primitives}.ts` — types.
- `C1RCLE-FRONTEND/packages/auth/src/session-store.ts` — session/access-token
  expectations.
- `C1RCLE-FRONTEND/packages/config/src/schema.ts` — env contract
  (`NEXT_PUBLIC_API_BASE_URL`).
- `C1RCLE-FRONTEND/apps/*/.env.example` — `NEXT_PUBLIC_API_BASE_URL=http://localhost:8080`.
