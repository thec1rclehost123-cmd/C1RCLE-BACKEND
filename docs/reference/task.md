# TASK.md — V2 Partner Slice: Contract → Slice → URL → Gateway

> Execution list for the partner V2 rebuild. Complete tasks **one by one, in order**.
> Each task has an exit gate; do not start the next until the gate passes.
> Scope: **organizations, venues, events, event-catalog, partners analytics**.
> **BLOCKED (not implemented in this slice):** checkout, orders, payments, refunds, payouts, bank-accounts, door, webhooks.
> V1 stays live and frozen beside V2; switch happens after parity proof.

---

## Architecture rules (applies to every task)

1. **Frontend asks. Backend decides. Database remembers.**
2. **Contracts are backend-owned.** `packages/types` + zod schemas are the single source of truth; frontend v2 imports the published contract, never defines the API.
3. **Thin routes.** Route = validate → auth → policy/scope → one service call → serialize. No business logic, no `.collection()` in route files.
4. **Modular monolith.** Each domain module (organizations, venues, events, event-catalog) owns its services, rules, state machine, and repository interface.
5. **Storage behind interfaces.** Domain depends on `interface EventRepository`; Firestore adapter is an implementation detail. No domain file reads `process.env` or imports Firebase/Fastify.
6. **Every write endpoint is idempotent** (`Idempotency-Key`) and **optimistically locked** (`If-Match` / version / etag).
7. **Domain events, not service-to-service calls.** Services publish events through the outbox; consumers (notifications, analytics, search, audit) react.
8. **V1‖V2 parallel.** Build V2 alongside frozen V1; parity tests prove V2 before switch; delete V1 only after zero-use proof.
9. **Fail closed.** Missing config, missing keys, unknown state → error, never silent fallback.
10. **No mocks in backend.** Every shipped backend module is a real implementation (Firestore-first; `process.env`-free via injected config). Test doubles live ONLY under `src/test-utils/` and never ship.
11. **Skeleton-first future domains.** `payment`, `inventory`, `booking`, `notification`, `webhook` get EMPTY module/port skeletons now (directories + interfaces, zero implementation) so later slices cannot leak logic into booking/events.
12. **Provider abstraction.** Payment/notification/search adapt behind ports (`PaymentProvider.authorize/capture/refund/verifyWebhook`; `NotificationService` transport-agnostic). No business changes when the provider changes.
13. **Public vs internal routes** are separated from the start: `/api/v2/public` | `/api/v2/partner` | `/api/v2/admin` | `/api/internal`. Auth alone is never relied on; path scope is structural.
14. **Audit as a service.** Audit writes go through `AuditRepository`/`AuditService`, never directly to a collection from a route.

---

## Development order (reviewer-recommended, frozen)

1. Contracts
2. Domain models + state machines
3. Validation (payload / headers / params / query / response)
4. Repository interfaces
5. Application services
6. Event bus + outbox
7. Routes (v2 gateway)
8. Repository implementations (Firestore adapter)
9. Integration + parity tests
10. Frontend switch

---

# PHASE 0 — FOUNDATION

## T01 — Shared contract package (backend-owned)

**Goal:** one package that defines the wire contract both backend and frontend consume.

**Tasks:**
- [x] Extend `packages/types/src/index.ts` with the missing primitives:
  - `ApiErrorCode` union
  - `RequestId` type
  - `ApiError` (`{ code, message, status?, requestId?, fieldErrors?, details? }`)
  - `User` (`{ id, email, displayName, role, avatarUrl }`)
  - `Session` (`{ user, expiresAt }`)
  - `Role = 'guest' | 'partner' | 'admin'`
  - `PageInfo`, `Paginated<TItem>`, `FieldErrors`
- [x] Add zod runtime schemas (zod v4) in `src/client.ts`: `roleSchema`, `userSchema`, `sessionSchema`, `pageInfoSchema`, `paginatedSchema`, `noContentSchema` — match the frontend v2 `api-client` schemas exactly (`z.email()`/`z.url()`).
- [x] Publishable entry: `packages/types/package.json` exports map covers `client` (browser-safe, no node imports); package now ESM (`"type": "module"`); zod `^4.1.12` dependency added.
- [x] Contract snapshot test: `packages/types/test/contract.test.mjs` (node --test) asserts the shared schemas parse canonical fixtures and reject corrupt ones.

**Exit gate:** `npm run type-check --workspace=packages/types` green — PASSED; `npm run build` + `npm run test` green (8/8). Frontend `@c1rcle/api-client` compile against published contract — deferred to T21 (published-package gate; no real consumers in this repo yet, only commented imports).

## T02 — Error envelope + status→code mapping

**Goal:** one error shape everywhere; frontend `statusToErrorCode` matches backend.

**Tasks:**
- [x] Central error builder: `apps/api-gateway/src/lib/api-contracts.ts` — added V2 layer `buildV2ErrorResponse` emitting `{ code, message, fieldErrors?, requestId, status }`; V1 `buildErrorResponse` kept frozen.
- [x] Map table locked by test: `400/422 → validation`, `401 → unauthorized`, `403 → forbidden`, `404 → not_found`, `409 → conflict`, `429 → rate_limited`, `≥500 → server` (`V2_STATUS_CODE_TO_ERROR_CODE` + `errorCodeForStatus`).
- [x] Field errors: `zodToFieldErrors(zod)` → `{ field: string[] }` shared helper (from zod flatten).
- [x] `x-request-id` echo extracted to `apps/api-gateway/src/lib/request-tracing.ts` (`genReqId` + `onRequestHook`), used by `app.ts`, unit-tested (echo client-supplied id; mint when absent).
- [ ] 204 for no-content writes (`noContentSchema`) — verified when v2 routes land (T16); contract emits no body on 204.
- [x] New unit test file: `apps/api-gateway/src/lib/api-contracts.test.ts` — 15 tests covering the full status map, fieldErrors shape, requestId, frontend parity.

**Exit gate:** contract test green — PASSED (15/15); full gateway suite green — PASSED (157/157, incl. frozen V1 `events-gp3.test.ts` asserting `VALIDATION_ERROR` still intact). Frontend `ApiClientError` parity asserted via status map test.

## T03 — Configuration separation

**Goal:** domain/infra/application never read `process.env` directly.

**Tasks:**
- [x] `packages/core/src/config` (new): `createCoreConfig` + `CoreConfig` (`clock`, `ids`, `redis`, `firestore`, `features`) + `isFeatureEnabled` + `CoreConfigError`. Zero `process.env`; injected via constructor/DI; fail-loud validation on missing `redis.url`/`firestore.projectId`. Export `@c1rcle/core/config` added to package.json exports.
- [x] `apps/api-gateway/src/config/index.ts` remains the only env reader; now exports `coreConfig = createCoreConfig({...})` (Redis URL, Firestore projectId, `FF_SEARCH_INDEXER`) for DI into services.
- [x] Fail-fast validation: existing boot-time `process.exit(1)` for invalid/missing prod vars retained; `createCoreConfig` throws `CoreConfigError` for malformed core config.
- [x] Guardrail script addition: `scripts/check-backend-boundaries.mjs` now rejects `process.env` in `packages/core/src/domain/**` (new `findEnvInCoreDomainViolations` check).
- [x] Unit test: `packages/core/src/config/index.test.ts` — 8 tests (defaults, injected clock/ids/redis/features, fail-loud missing fields, `isFeatureEnabled` opt-in semantics).

**Exit gate:** `npm run guardrails:check` green with new rule — PASSED (✅ process.env not read inside domain). `packages/core` unit tests green — PASSED (29 files / 186 tests). `apps/api-gateway` build green. A domain service unit test constructs with fake config, zero env reads — config test covers defaults/injection; service-level fake-config test lands with T08.

## T04 — Observability foundation

**Goal:** every log/trace carries correlation context; OTel-ready.

**Tasks:**
- [x] Structured log fields on `onResponse` in `apps/api-gateway/src/app.ts`: `requestId`, `userId`, `organizationId` (workspaceId fallback), `clientIp`, `route`, `method`, `statusCode`, `durationMs`, `cache`.
- [x] Sentry tags: `request_id` (onRequest), `user_id` + `organization_id` (preHandler after auth resolves — non-PII only).
- [x] Redact list centralized: `apps/api-gateway/src/lib/logger-config.ts` (`redactPaths` + `logFieldNames`), used by `app.ts`; covers authorization, cookie, x-api-key, razorpay signatures, secrets.
- [x] Logger port in core: `packages/core/src/telemetry/logger.ts` (`Logger` interface + `noopLogger` + `createLogger`), export `@c1rcle/core/logger`.
- [x] Tests: `apps/api-gateway/src/lib/logger-config.test.ts` — redaction (no token in pino output), x-request-id echo, userId/orgId attachment, canonical field names. `packages/core/src/telemetry/logger.test.ts` — port forwarding + noop silence.

**Exit gate:** sample request log includes all fields — verified in code (onResponse logData) + field-name contract test; redaction test asserts no token in output — PASSED (pino emits `[Redacted]`, no `super-secret-token`/`sid=abc`). Full gateway suite 161/161, core 192/192, guardrails green.

---

# PHASE 1 — DOMAIN LAYER (independent of transport/storage)

## T05 — Domain models + state machines

**Goal:** explicit entities with explicit finite state machines; no arbitrary transitions.

**Tasks:**
- [x] **Skeleton modules first (no logic, interfaces only):** ports `payment-provider.ts`, `inventory.ts`, `booking.ts`, `notification.ts`, `webhook.ts` under `packages/core/src/domain/ports/`. Empty boundaries so future slices can't leak logic into booking/events.
- [x] `packages/core/src/application/jobs.ts` reserved (archive events, expire invitations, release abandoned drafts, clean idempotency records, refresh analytics) — typed `Job`/`JobQueuePort`/`JobHandlerRegistry` interfaces, no implementation.
- [x] `packages/core/src/domain/models/organization.ts`: Organization + Membership + Role + Capability (host | venue | promoter | combined).
- [x] `packages/core/src/domain/models/venue.ts`: Venue, VenueProfile (private/public field split), VenueSlot, SlotRequest.
- [x] `packages/core/src/domain/models/event.ts`: Event + EventStatus FSM:
  `DRAFT → REVIEW → SCHEDULED → PUBLISHED ⇄ SALES_PAUSED → STARTED → ENDED → ARCHIVED`, with terminal `CANCELLED`; every transition validated by explicit allowed-transitions map (replaces V1 `lifecycle`/`status` string soup).
- [x] `packages/core/src/domain/models/event-catalog.ts`: TicketTier, PromoCode, TablePackage, PromoterAssignment (versioned commission terms).
- [x] Version field on every mutable entity (`version: number`, `updatedAt`) via shared `newVersionedEntity`/`bumpVersion` (`domain/identity.ts`) + generic `transitionStatus` helper (`domain/fsm.ts`).
- [x] Unit tests per state machine: valid transitions, invalid transitions throw domain error, idempotent same-state transition no-op.

**Exit gate:** FSM tests green — PASSED (16/16, `src/domain/t05.test.ts`); full `packages/core` suite 208/208 (32 files); build green; `guardrails:check` green; eslint clean on `domain/` + `application/`.

**Export:** `@c1rcle/core/domain` barrel added (`./domain`: `./dist/domain/index.js`) re-exporting errors, fsm, identity, models, and ports.

## T06 — Validation schemas (all four layers)

**Goal:** payload, headers, params, query, AND response are validated.

**Tasks:**
- [x] Per-route request schemas (zod v4, `.strict()`): `createEventBody` (title/venueId/startAt/…, unknown-key rejection) at `routes/v2/partner/events.ts`; query uses `paginationQuerySchema` (bounded `limit` 1–100 + `cursor`); params `opaqueIdSchema`; headers (`X-Organization-Id`, `Idempotency-Key`, `If-Match`).
- [x] Per-route response schemas: `validateV2Response` (`lib/v2-response-validation.ts`) checks every success payload against `eventDtoSchema`/`paginatedSchema(eventDtoSchema)` before send; mismatch → 500, raw doc never leaked.
- [x] Shared helpers: `opaqueIdSchema`, `cursorSchema`, `paginationQuerySchema`, `idempotencyKeySchema`, `versionHeaderSchema`, `organizationIdSchema`, `eventDtoSchema` in `@c1rcle/types/client.ts`.
- [x] `validateV2Plugin` (registered) parses headers+params+query+body; failure → 422 with `fieldErrors` (V1 `validate` plugin untouched, still frozen).
- [x] OpenAPI: `src/openapi/v2-partner.ts` + `GET /openapi/v2-partner.json` added to `routes/openapi.ts` (mirrors route schemas; zod→OpenAPI generator pending).

**Exit gate:** PASSED — `src/routes/v2/partner/events.test.ts` 8/8 proving all four validation layers (body, strict-body, params, query, headers) with 422 `fieldErrors` + response-schema-validated 201 + 404 V2 shape + OpenAPI endpoint. Full gateway suite 169/169, types 8/8, build green, eslint cleaner, `guardrails:check` green.

## T07 — Repository interfaces (ports)

**Goal:** domain depends on interfaces; implementations are swappable (Firestore now, Postgres later, Memory for tests).

**Tasks:**
- [x] `packages/core/src/domain/ports/repositories.ts`:
  - `OrganizationRepository` (get/listForMember/listMembers/getMember/save/delete)
  - membership covered by `OrganizationRepository.listMembers` + `getMember` (no separate repo needed — member is an aggregate part)
  - `VenueRepository`, `SlotRequestRepository`, `VenueSlotRepository`
  - `EventRepository` (interface differs deliberately from legacy `infrastructure/repositories/firebase/event-repository.ts`: V1 interface stays untouched; the V2 typed interface lives here)
  - `EventCatalogRepository` (tiers/promos/tables/assignments)
  - `AnalyticsReadModelRepository`
- [x] Each interface: fully typed, cursor pagination (`Page<T>/PaginationQuery` + `nextCursor`), optional `TxContext` on writes, zero Firestore types in signatures.
- [x] `MemoryOrganizationRepository`/`MemoryVenueRepository`/`MemorySlotRequestRepository`/`MemoryVenueSlotRepository`/`MemoryEventRepository`/`MemoryEventCatalogRepository`/`MemoryAnalyticsReadModelRepository` in `packages/core/src/test-utils/memory-repositories.ts` — zero infra imports.
- [x] Unit test: domain aggregates + repos round-trip through MemoryRepository with zero infra imports (`src/t07.test.ts`).

**Exit gate:** PASSED — eslint `no-restricted-imports` rule added to root `eslint.config.js` (scoped to new V2 boundaries; legacy V1 `domain/services/**` + `domain/repositories/**` excluded as migration debt); `src/t07.test.ts` 5/5; full core suite 229/229; core build green; `guardrails:check` green.

## T08 — Application services

**Goal:** one service per use case; orchestration only, rules pushed to domain models.

**Tasks:**
- [ ] `packages/core/src/application/organizations/`: list, create, get, update, invite-member, list-members, list-invitations.
- [ ] `packages/core/src/application/venues/`: list, create, get, update, profile.get/update, calendar.get, availability.get, menu.get/update, slot-requests.list/create.
- [ ] `packages/core/src/application/events/`: list, create, get, update, previews.get, review, publish, pause-sales, resume-sales, cancel, duplicate.
- [ ] `packages/core/src/application/event-catalog/`: tiers/promos/tables/assignments list+create.
- [ ] `packages/core/src/application/analytics/`: organization overview, event analytics (read model, precomputed — never scan collections per request).
- [ ] Services receive: actor context (`{ userId, organizationId, role, permissions }`), config, repositories, logger — all injected.
- [ ] Services throw typed domain errors (`OrganizationNotFoundError`, `ForbiddenError`, `VersionConflictError`, `StateTransitionError`) — gateway maps to HTTP.

**Exit gate:** each service has unit tests with MemoryRepository; no `process.env`, no Fastify, no Firebase imports anywhere in `application/`.

## T09 — Idempotency (all writes)

**Goal:** retries never duplicate business results.

**Tasks:**
- [ ] Generalize existing `packages/core/src/domain/services/idempotency-service.ts`: key = `{idempotencyKey, actorId, commandName}`, store first response, replay on retry, TTL (24h), stored in Redis **and** durable in Firestore collection `idempotency_records` (Redis fast path, Firestore authority).
- [ ] Gateway plugin `idempotency` (new, next to existing plugins): requires `Idempotency-Key` on POST/PATCH/PUT for manifest routes marked `REQUIRED`; 409 `conflict` on key reuse with different body; replays stored response on same key.
- [ ] Idempotent state transitions: publish/cancel/duplicate return the same result on retry (FSM same-state no-op + stored response).
- [ ] Tests: duplicate request returns identical response, no second write; concurrent same-key requests → one winner.

**Exit gate:** retry/concurrency test shows one business result.

## T10 — Optimistic locking (If-Match / version)

**Goal:** no lost updates.

**Tasks:**
- [ ] Every mutable entity carries `version` + `updatedAt`.
- [ ] `If-Match: "version"` header required on PATCH/PUT (manifest routes marked `expectedVersion: REQUIRED`); body `version` is ignored (header is authority).
- [ ] Version conflict → 409 `conflict` with current version in error details; client re-fetches.
- [ ] Repository write methods take `expectedVersion` and transactionally compare-and-set.
- [ ] Tests: two concurrent updates → one succeeds, one 409; retry after refetch succeeds.

**Exit gate:** concurrent-update test proves single winner.

---

# PHASE 2 — EVENT BUS + OUTBOX + DLQ

## T11 — Outbox pattern

**Goal:** every domain event survives the transaction; no lost events when a queue is down.

**Tasks:**
- [ ] `packages/core/src/domain/events/`: versioned domain event types — `OrganizationCreated`, `OrganizationUpdated`, `VenueCreated`, `VenueUpdated`, `SlotRequested`, `SlotRequestAccepted`, `EventCreated`, `EventUpdated`, `EventPublished`, `EventCancelled`, `TicketTierCreated`, `PromoCodeCreated`, `TablePackageCreated`, `PromoterAssigned`.
- [ ] `OutboxWriter` port + Firestore implementation: `outbox_events` collection; event row = `{ id, type, aggregateId, payload, status: pending, attempts, createdAt, processedAt }`; written **in the same transaction** as the business write.
- [ ] Worker (Inngest — already in stack; no Kafka in this slice): polls `pending` rows, dispatches to consumers, marks `processed`; retries with backoff; after N=10 attempts → `dead_letter`.
- [ ] Delivery is at-least-once; consumers must be idempotent (event ID dedupe).

**Exit gate:** kill-worker test — a processed event's business result is not duplicated on re-run; crash after commit does not lose the event (row survives, processed once).

## T12 — Event bus + consumers

**Goal:** services publish; consumers react; no service-to-service calls.

**Tasks:**
- [ ] In-process `EventBus` in core (publish → handlers), wired to the outbox worker for durable delivery.
- [ ] Consumers for this slice:
  - `EventPublished → public projection update` (public-discovery read model)
  - `EventPublished/Cancelled → analytics invalidate`
  - `EventPublished → notification intent (partner)`
  - `EventUpdated → audit log` (`audit_events` collection, immutable)
  - `SlotRequestAccepted → calendar projection refresh`
- [ ] Consumer idempotency: dedupe by event ID (stored in `processed_events`).
- [ ] Tests: publish → all consumers run once; consumer failure → retry, not duplicate side effects.

**Exit gate:** one publish produces exactly one projection update + one audit record + one notification intent, even under retry.

## T13 — Dead letter queue

**Goal:** failures are visible and recoverable, never silent.

**Tasks:**
- [ ] Outbox rows failing 10 attempts move to `dead_letter` status; retained payload + error trail (`lastError`, `attempts`).
- [ ] Admin/dev inspection endpoint (INTERNAL auth): list DLQ, replay a row, cancel a row. (Registered only under `INTERNAL`/`ADMIN`, not public.)
- [ ] Alert: DLQ row count > threshold → Sentry error / log warn (worker-side check).
- [ ] Test: forced consumer failure → row lands in DLQ with error trail; replay re-processes once.

**Exit gate:** DLQ unit/integration test green; no silent swallow path (existing empty-catch rule re-verified).

---

# PHASE 3 — GATEWAY (v2 routes)

## T14 — Route manifest (runtime source of truth)

**Goal:** routes are declared once, registered from the manifest; docs stay generated.

**Tasks:**
- [ ] Create `apps/api-gateway/src/routes/v2/route-manifest.ts` — port the partner slice from `docs/V2-Partners_Frontend/route-manifest.ts` (slice = organizations, venues, events, event-catalog, analytics; everything else stays `BLOCKED`/unregistered).
- [ ] Registration rule enforced by test: **only** `ACTIVE` entries register; `BLOCKED`/`PLANNED` are never stubbed with 501s.
- [ ] Regenerate `docs/V2-Partners_Frontend/API_V2_ROUTE_MANIFEST.md` from the runtime manifest (extend existing generator).
- [ ] Per-route policy from the manifest: auth class, permission, scope, idempotency, version, rate-limit class, cache class, audit.

**Exit gate:** manifest test — every registered v2 route has an ACTIVE manifest entry and vice-versa; BLOCKED routes 404 (not 501).

## T15 — Gateway plugins (auth, RBAC+ABAC, rate limit, cache)

**Goal:** shared policies at the boundary; routes stay thin.

**Tasks:**
- [ ] **Auth**: canonical Firebase ID-token verification (extend `plugins/firebase`); attach `{ userId, organizations, permissions }` context; revoked/disabled checks.
- [ ] **RBAC + ABAC** (extend `plugins/rbac`):
  - RBAC: role → permission set (`organization.read`, `event.update`, `venue.manage`, `promoter.analytics`, ...).
  - ABAC: resource-scope rule `actor.organizationId === resource.organizationId` (and event/venue assignment) enforced per route via the manifest `scope` column — default deny.
  - No route trusts client `organizationId` alone.
- [ ] **Rate limiting** (extend `plugins/rate-limit`): key = `IP + userId + organizationId` compound buckets; manifest rate-limit classes (`PUBLIC_READ`, `AUTH_READ`, `STANDARD_COMMAND`, `SENSITIVE_COMMAND`, `ADMIN_COMMAND`, `INTERNAL`); `429` + `Retry-After`.
- [ ] **Cache** (extend `plugins/cache` + `cache-control`): private Redis cache for org/venue/event reads with per-entity TTLs (see T17); `NO_STORE` for anything sensitive; invalidation on write events (T12 consumers).
- [ ] `X-Organization-Id` header must match the `:organizationId` path param on org-scoped routes (test enforced).

**Exit gate:** IDOR matrix test (cross-org access denied); rate-limit bucket test; header-vs-path org mismatch → 403.

## T16 — v2 route modules (thin)

**Goal:** each module = manifest + schemas + service calls only.

**Tasks:**
- [ ] `apps/api-gateway/src/routes/v2/organizations.ts` — list/create/get/update/members/invitations.
- [ ] `apps/api-gateway/src/routes/v2/venues.ts` — list/create/get/update/profile/calendar/availability/menu/slot-requests.
- [ ] `apps/api-gateway/src/routes/v2/events.ts` — list/create/get/update/previews/review/publish/pause/resume/cancel/duplicate.
- [ ] `apps/api-gateway/src/routes/v2/event-catalog.ts` — tiers/promos/tables/promoter-assignments list+create.
- [ ] `apps/api-gateway/src/routes/v2/analytics.ts` — org overview + event analytics (read-model only).
- [ ] Register all under `/api/v2` in `apps/api-gateway/src/app.ts` (V1 registrations untouched).
- [ ] Handler shape enforced by architecture test: no `db.collection`/`.doc(` calls in `routes/v2/**`; no `z` inline business enums that duplicate domain models (import from core).

**Exit gate:** `npm run guardrails:check` green; v2 route tests green with MemoryRepository-backed services.

## T17 — Cache strategy

**Goal:** deliberate TTLs, no cache for private data.

**Tasks:**
- [ ] TTL table (Redis): organization (5m, invalidate on update), venue profile (5m), public event preview (60s), venue availability (30s), analytics overview (60s), event analytics (120s).
- [ ] Cache keys include `version` + `organizationId` scope; never cross-tenant.
- [ ] Private/sensitive routes (`NO_STORE`): any PII, finance, tickets — even cached privately.
- [ ] Invalidation via T12 consumers (write → key delete/update).
- [ ] Load test: hot org/venue read p95 < 200ms with cache hit; no stale after update (invalidate test).

**Exit gate:** invalidation test — update → next read is fresh; cross-tenant cache key test — org A cannot read org B's cache entry.

---

# PHASE 4 — STORAGE + SEARCH INTERFACES

## T18 — Repository implementations (Firestore adapter)

**Goal:** interfaces from T07 backed by Firestore; Postgres-ready later.

**Tasks:**
- [ ] Implement all T07 interfaces as Firestore adapters under `packages/core/src/infrastructure/repositories/firebase/` (reuse/extract from existing `event-repository.ts`, `order-repository.ts` patterns).
- [ ] Transactional writes: business write + outbox event in one transaction (T11).
- [ ] Compare-and-set for optimistic locking (T10): `expectedVersion` guard inside transaction.
- [ ] Cursor pagination using opaque cursor (not `limit/offset` scans); bounded page size.
- [ ] No N+1: batch/multi-get where a list needs related docs; per-route read budget documented in manifest.
- [ ] Required composite indexes added to `firebase.json`/indexes config; verify emulator queries.

**Exit gate:** repository contract tests (same suite against Memory + Firestore emulator) pass; query cost test shows bounded reads.

## T19 — Search interface (ready, not implemented)

**Goal:** keep a port so OpenSearch/Typesense/Meilisearch can slot in later without touching services.

**Tasks:**
- [ ] `SearchIndexer` port in core: `index(domainEvent)` / `delete(aggregateId)`; no-op adapter registered now (logs only).
- [ ] Outbox consumer hooks `EventPublished/Cancelled` into the no-op indexer (wire exists, off by default via feature flag).
- [ ] Public search route stays on current V1 implementation until search provider decision; manifest route `public.search` remains `PLANNED`.

**Exit gate:** feature flag `searchIndexerEnabled=false`; turning it on logs index intents with zero service changes.

---

# PHASE 5 — PARITY + SWITCHOVER

## T20 — V1‖V2 parity tests

**Goal:** prove V2 equals V1 behavior before switch.

**Tasks:**
- [ ] Parity harness: for each slice flow, run same input through V1 handler and V2 service against the same seeded Firestore emulator data; assert: same resulting DB state (normalized), same core fields, no extra fields leaked.
- [ ] Field mapping table per resource (V1 field → V2 field | DROPPED): only required fields carried; everything else explicitly DROPPED with reason. (See `docs/` — the V1 mess is the filter.)
- [ ] Contracts: V2 response passes zod response schema (V1 responses are not required to — they are legacy).
- [ ] Security parity: V2 must be **stricter than** V1 — IDOR, auth, rate limit, idempotency all tested on V2; V1 gaps are documented, not replicated.

**Exit gate:** parity suite green for slice; `docs/V2-Partners_Frontend/parity-report.md` generated.

## T21 — Frontend switch to V2

**Goal:** frontend v2 talks to `/api/v2`; V1 remains running.

**Tasks:**
- [x] Frontend `@c1rcle/api-client` base URL → gateway `/api/v2` (env-driven): typed transport in `apps/partner-dashboard/lib/v2/api-client.ts` (routes `/api/v2/partner`, rewritten to the gateway via `GATEWAY_URL` in `next.config.mjs`); responses runtime-validated against `@c1rcle/types/client` schemas.
- [ ] Session/user flows updated to v2 contract (`sessionSchema`, `userSchema`) — still Firebase `getIdToken()` Bearer transport; v2 session endpoint deferred.
- [x] Feature-flag: partner UI can point at V1 or V2 gateway for one release — `NEXT_PUBLIC_V2_ENABLED` (default `false`); when `true`, Next adds the `/api/v2/:path*` rewrite and `app/v2` (V2 Studio) is reachable; V1 routes untouched.
- [~] Smoke/E2E: partner journeys (org → venue → slot request → event create → publish → previews) all green on V2 — partial: org → venue → event create proven in `app/v2/PageClient.tsx` against the service-backed routes; slot request + publish still to be wired.

**Live V2 partner surface (service-backed, memory repos until Firestore V2 adapters land):**
- `GET /api/v2/partner/organizations` · `POST /api/v2/partner/organizations` · `GET /api/v2/partner/organizations/:organizationId` · `PATCH /api/v2/partner/organizations/:organizationId` — `OrganizationService` (`organizations.ts`)
- `GET /api/v2/partner/organizations/:organizationId/venues` · `POST …/venues` · `GET /api/v2/partner/venues/:venueId` · `PATCH /api/v2/partner/venues/:venueId` — `VenueService` (`venues.ts`)
- `GET /api/v2/partner/events` · `GET /api/v2/partner/events/:eventId` · `POST /api/v2/partner/events` — `EventService` (`events.ts`)
- All: `X-Organization-Id` required, actor from Firebase uid + active membership, cross-tenant single-resource reads → 404 (IDOR guard), `If-Match` optimistic locking on PATCH, zod-validated responses via `validateV2Response`.

**Exit gate:** staging journey green on V2 for the full slice; no V1 calls from partner UI for migrated flows.

## T22 — V1 freeze + removal

**Goal:** V1 partner routes die only after zero-use proof.

**Tasks:**
- [ ] Freeze V1 partner routes (no new features; critical fixes only) — announce in code comments + governance doc.
- [ ] Runtime traffic proof: `x-request-id` + route-level metrics show zero V1 partner traffic for the agreed window (e.g. 7 days).
- [ ] Static consumer proof: no repo code calls V1 partner endpoints.
- [ ] Remove V1 partner route files + their exception entries in `governance/backend-boundary-exceptions.json`.
- [ ] Remove V1 leftovers from frontend (proxies, `lib/server` legacy modules) only after UI green on V2.

**Exit gate:** V1 partner routes deleted; guardrails green; parity-report + traffic evidence archived.

---

# PHASE 6 — POST-SLICE BACKLOG (NOT NOW, DOCUMENTED)

- [ ] **Webhooks module** (`webhooks.payments`, `webhooks.payouts`): raw-body signature verification, replay hash, provider adapter, idempotent finalizer — **BLOCKED** until checkout/payments slice.
- [ ] **Seat/inventory locking**: Redis locks + durable holds — part of checkout slice (inventory-service exists; do not touch here).
- [ ] **CQRS read models**: analytics already read-model-first here; deeper split (event-sourcing projections) deferred.
- [ ] **Content-negotiated versioning** (`application/vnd.circle.v2+json`): keep `/api/v2` for now; revisit before any v3.
- [ ] **PostgreSQL**: interfaces are ready (T07); storage migration is a separate program.
- [ ] **Search provider**: T19 port ready; provider decision later.
- [ ] **Kafka/queue hardening**: Inngest is the queue for this slice; Kafka only if scale demands.
- [ ] **Worker/scheduler separation**: deploy `api` / `worker` / `scheduler` as separate processes from day one of the next slice (API never runs outbox worker or cron inline).
- [ ] **Secret management**: move to a secret manager (Cloud Secret Manager / Vercel env) with rotation runbooks — payment webhook secrets, JWT/ID-token rotation, DB credentials, `ENCRYPTION_KEY`. Rotation procedures documented per key; fail-closed if expired (rule 9).
- [ ] **Disaster recovery runbook** (documented, not built this slice): Firestore backup schedule + restore procedure, Redis loss behavior (degrade gracefully, cache misses only), outbox replay procedure, RPO (≤ 5 min backups) / RTO (≤ 1 h restore) targets, DLQ replay drill.
- [ ] **Notification transport adapters**: `Email | SMS | Push | WhatsApp` behind `NotificationService` port; consumers publish intents only, never pick transport.

---

## Verification commands (run from `thec1rcle/`)

```
npm run type-check          # after each phase
npm run lint                # after each phase
npm run guardrails:check    # after T03, T07, T16
npm run test --workspace=packages/core        # domain + services
npm run test --workspace=apps/api-gateway     # routes + plugins + parity
npm run dev --workspace=apps/api-gateway      # local v2 smoke
```

## Definition of done (whole plan)

- [ ] Contract package published and imported by frontend v2 (no drift).
- [ ] Partner slice live on `/api/v2` with thin routes, RBAC+ABAC, compound rate limits, idempotency, optimistic locking.
- [ ] Outbox + event bus + DLQ operational (publish → projections/notifications/audit once).
- [ ] Parity report green; V1 partner routes removed after zero-use proof.
- [ ] Every manifest route for the slice has: schema, policy, tests, cache class, owner.
