# Phase 5 Comprehensive Architecture Audit Report

**Generated**: 2026-08-20  
**Auditor**: AI Assistant  
**Scope**: C1RCLE-BACKEND Phase 5 (Door / Scanner / Cover-wallet)  
**Reference Documents**: Dream Architecture, ChatGPT Response, Phase 5 Execution Plan, Roadmap, API V2 Manifest

---

## Executive Summary

| Metric | Score | Status |
|--------|-------|--------|
| **Overall Phase 5 Readiness** | **3.5/10** | 🔴 Critical gaps |
| **Domain Layer (Phase 5A)** | 8/10 | ✅ Models, ports, services complete; **tests missing** |
| **Infrastructure (Phase 5B)** | 2/10 | ❌ **No memory/Firestore adapters for Phase 5** |
| **HTTP Routes (Phase 5C)** | 2/10 | ❌ All 25 routes return 501; WebSocket/QR/Offline missing |
| **Contracts** | 1/10 | ❌ **Zero Phase 5 schemas in contracts package** |
| **API Gateway Integration** | 4/10 | ⚠️ Services wired but repos missing; auth missing |
| **Modular Monolith Compliance** | 5/10 | Domain OK; infra/routes break rules |
| **Contract-First** | 2/10 | ❌ **Zero Phase 5 contracts** |
| **Dream Architecture Patterns** | 3/10 | Missing: Event Bus, Outbox, CQRS, Seat Locking, Webhooks, DLQ, Observability |

---

## 1. Documented Architecture vs Implementation

### 1.1 Dream Architecture (chatgpt_response.md) — Target State

| Component | Target | Current | Gap |
|-----------|--------|---------|-----|
| **Modular Monolith** | `src/{auth,users,events,tickets,booking,payments,notifications,analytics,admin,shared}` | `packages/core/src/{domain,application,infrastructure}` | Partial |
| **Thin Gateway** | Validate→Auth→Policy→Service→Serialize | Partially done — Phase 5 routes return 501 | ❌ |
| **Event Bus** | Domain events → Queue → Consumers | `InProcessEventBus` exists but no Kafka/RabbitMQ | ❌ |
| **Outbox Pattern** | Transactional event emission | `MemoryOutboxStore` exists, no DB adapter | ❌ |
| **CQRS** | Separate read/write models | Read models partially exist | ⚠️ |
| **Contracts** | Zod schemas → OpenAPI → SDK | Phase 1-4 done, **Phase 5 MISSING** | ❌ |
| **Seat Locking** | Redis lock for tickets | Not implemented | ❌ |
| **Webhook Module** | Raw body → Verify → Process | Razorpay adapter only, no generic framework | ❌ |
| **Observability** | Correlation ID, OpenTelemetry, Prometheus, Grafana, Jaeger | Only basic logging | ❌ |
| **DLQ** | Dead letter queue for failed events | Not implemented | ❌ |

### 1.2 Phase 5 Execution Plan (phase-05-door-scanner-cover-wallet.md) — Compliance

| Phase | Task | Status | Evidence |
|-------|------|--------|----------|
| **5A.1** Domain Models | ✅ Done | 5 files created |
| **5A.2** Repository Ports | ✅ Done | 7 interfaces in `ports/repositories.ts` |
| **5A.3** Application Services | ✅ Done | 3 services created |
| **5A.4** Unit Tests | ❌ **MISSING** | **0/5 test files** |
| **5B.1** Memory Adapters | ❌ **MISSING** | None for Phase 5 |
| **5B.2** Firestore Adapters | ❌ **MISSING** | Created then deleted due to type errors |
| **5B.3** Integration Tests | ❌ **MISSING** | None |
| **5C.1** API Routes | ⚠️ Scaffolds only | 25 routes return 501 |
| **5C.2** WebSocket Live Stats | ❌ **MISSING** | Route closes socket |
| **5C.3** Magic Ticket QR | ❌ **MISSING** | Route returns 501 |
| **5C.4** Rate Limits | ⚠️ Partial | Classes referenced but not implemented |
| **5C.5** Contracts | ❌ **MISSING** | No Phase 5 schemas in contracts |
| **5D.1** Service Wiring | ✅ Done | Added to `ServiceDeps` and `PartnerV2Services` |
| **5D.2** Contract Parity | ❌ **MISSING** | Cannot run without contracts |
| **5D.3** E2E Integration Tests | ❌ **MISSING** | None |
| **5D.4** Verification Gates | ❌ **MISSING** | `pnpm check` would fail |

---

## 2. Modular Monolith Rules Violations

### Files Breaking Architecture Rules

| File | Rule Violated | Details |
|------|---------------|---------|
| `phase5-routes.ts` | **All routes return 501** | Thin gateway rule violated — no service calls |
| `packages/contracts/src/client.ts` | **Missing Phase 5 contracts** | No schemas for Scanner, Door, Cover Wallet DTOs |
| `packages/core/src/infrastructure/firestore/` | **Phase 5 Firestore repos MISSING** | Created then deleted; no DB adapters |
| `packages/core/src/infrastructure/memory/` | **Phase 5 memory repos MISSING** | Only core domain memory repos exist |
| `v2-services.ts` | **Services wired but no implementations** | Services instantiated but underlying repos missing |
| `packages/contracts/src/client.ts` | **No Phase 5 Zod schemas** | Contract-first violated |
| `apps/api-gateway/src/plugins/auth.ts` | **Scanner auth not implemented** | D-022 pattern (short-lived signed token) missing |
| `apps/api-gateway/src/lib/payments/razorpay-adapter.ts` | **Wrong import path** | Uses `../../domain/errors.js` not `@c1rcle/core` |

### Missing Core Patterns (from Dream Architecture & ChatGPT)

| Pattern | Required By | Status |
|---------|-------------|--------|
| **Event Bus** | Dream Architecture | `InProcessEventBus` exists but no external queue |
| **Outbox Pattern** | Dream Architecture, ChatGPT rec | `MemoryOutboxStore` only, no DB adapter |
| **Seat Locking** | ChatGPT rec, Phase 5 | Not implemented |
| **Webhook Framework** | Dream Architecture | Razorpay only, no generic |
| **DLQ** | Dream Architecture | Not implemented |
| **CQRS Read Models** | ChatGPT rec | Partial (`AnalyticsReadModelRepository`) |
| **Observability** | Dream Architecture | Basic logging only |
| **DLQ** | Dream Architecture | Not implemented |

---

## 3. Line-by-Line Implementation Status vs Documented Plan

### Phase 5A: Domain Layer ✅ MOSTLY COMPLETE

| File | Plan | Implemented | Notes |
|------|------|-------------|-------|
| `scan-ledger.ts` | Entity, FSM, `processEntryScan` | ✅ | Magic Ticket HMAC ±65s implemented |
| `event-code.ts` | `EventCode`, `ScannerSession`, token gen | ✅ | Permissions by type implemented |
| `door-sale.ts` | Entity, synthetic order, idempotency | ✅ | Server-side price recalc |
| `cover-wallet.ts` | Entity, txn, termination, velocity | ✅ | Nightlife termination at 05:00 |
| `cover-wallet-reconciliation.ts` | Reconciliation entity | ✅ | Discrepancy tracking |

**Missing**: Unit tests (`*.test.ts`) — **0/5 test files created**

### Phase 5A.2: Repository Ports ✅ COMPLETE

All 7 interfaces defined in `ports/repositories.ts`:
- `ScanLedgerRepository`
- `EventCodeRepository`, `ScannerSessionRepository`
- `DoorSaleRepository`
- `CoverWalletRepository`, `CoverWalletTxnRepository`, `CoverWalletReconciliationRepository`

### Phase 5A.3: Application Services ✅ COMPLETE

| Service | Methods | Status |
|---------|---------|--------|
| `ScannerService` | `createSession`, `validateSession`, `processEntryScan`, `getLiveStats` | ✅ |
| `DoorService` | `walkInSale`, `dineInSale`, `getLiveStats` | ✅ |
| `CoverWalletService` | `issueWallet`, `debit`, `credit`, `terminate`, `reconcile` | ✅ |

### Phase 5A.4: Unit Tests ❌ **COMPLETELY MISSING**

| Test File | Required Coverage | Status |
|-----------|-------------------|--------|
| `scan-ledger.test.ts` | FSM transitions, `processEntryScan` idempotency, Magic Ticket ±65s | ❌ |
| `event-code.test.ts` | Session token gen/validation, permission scoping | ❌ |
| `cover-wallet.test.ts` | Debit/credit atomicity, velocity limits, termination, nightlife time | ❌ |
| `door-sale.test.ts` | Server-side price recalc, synthetic order, idempotency | ❌ |

### Phase 5B: Infrastructure Adapters ❌ **MOSTLY MISSING**

| Adapter | Memory | Firestore | Status |
|---------|--------|-----------|--------|
| Scan Ledger | ❌ | ❌ | **Missing** |
| Event Code | ❌ | ❌ | **Missing** |
| Scanner Session | ❌ | ❌ | **Missing** |
| Door Sale | ❌ | ❌ | **Missing** |
| Cover Wallet | ❌ | ❌ | **Missing** |
| Cover Wallet Reconciliation | ❌ | ❌ | **Missing** |

**Contract suite tests against memory adapters**: ❌ **Missing**
**Firestore compare-and-set transactions**: ❌ **Missing**

### Phase 5C: HTTP Routes + WebSocket ⚠️ **SCAFFOLDS ONLY**

| Route Category | Routes Defined | Implemented | Status |
|----------------|----------------|-------------|--------|
| **Scanner** | 9 routes | 0/9 | All return 501 |
| **Door** | 4 routes | 0/4 | All return 501 |
| **Cover Wallet** | 8 routes | 0/8 | All return 501 |
| **Magic QR** | 1 route | 0/1 | 501 |
| **Offline** | 2 routes | 0/2 | 501 |
| **WebSocket** | 1 route | 0/1 | Closes socket |

**Rate Limit Classes**: Referenced but not implemented:
- `SCANNER_COMMAND` (300/min)
- `DOOR_COMMAND` (60/min)
- `COVER_WALLET_COMMAND` (30/min)

**WebSocket**: Route registered, handler closes socket with 1001

**Magic Ticket QR**: Route exists, returns 501 — **no HMAC implementation in routes**

**Offline Support**: Routes defined, all 501 — **no signed manifest, no sync logic**

---

## 4. API Gateway Integration Status

### Service Wiring (`v2-services.ts`) ✅ **DONE**

```typescript
// Phase 5 services added to PartnerV2Services
scanner: createScannerService({...}),
door: createDoorService({...}),
coverWallet: createCoverWalletService({...}),
```

**But**: Underlying repositories missing → services will fail at runtime

### Route Registration ✅ **REGISTERED**

```typescript
// route-manifest.ts line 82
await phase5Routes(v2);
```

**But**: All route handlers return 501

### Auth Integration ❌ **MISSING**

- `SCANNER` auth type not implemented
- `fastify.requirePermission('ticket.override')` not implemented
- D-022 pattern (short-lived signed token from staff login) **not implemented**

---

## 5. Frontend Integration Gaps

### Contract Definitions (packages/contracts) ❌ **PHASE 5 MISSING**

**Required by Phase 5 Plan (5C.5 Contracts):**

| Missing Schema Category | Required For |
|------------------------|--------------|
| `ScannerSessionCreateBody/Response` | `POST /door/sessions` |
| `ScanBody/Response` | `POST /door/check-ins` |
| `DoorWalkInBody/Response` | `POST /door/walk-in` |
| `DoorDineInBody/Response` | `POST /door/dine-in` |
| `CoverWalletIssueBody/Response` | `POST /cover-wallets` |
| `CoverWalletDebitBody/Response` | `POST /cover-wallets/:id/debit` |
| `CoverWalletCreditBody/Response` | `POST /cover-wallets/:id/credit` |
| `MagicQrBody/Response` | `GET /tickets/:id/qr` |
| `OfflineManifestBody/Response` | `GET /door/offline-manifest` |
| `OfflineSyncBody/Response` | `POST /door/offline-sync` |
| WebSocket message schemas | `GET /door/stats/ws` |

**Error Codes Missing** (per 5C.5):
- `SCANNER_SESSION_EXPIRED`
- `VELOCITY_LIMIT_EXCEEDED`
- `WALLET_TERMINATED`
- `OFFLINE_MANIFEST_EXPIRED`

---

## 6. Overall Rating

| Category | Score | Evidence |
|----------|-------|----------|
| **Domain Layer (Phase 5A)** | 8/10 | Models, ports, services complete; **tests missing** |
| **Infrastructure (Phase 5B)** | 2/10 | **No memory/Firestore adapters for Phase 5** |
| **HTTP Routes (Phase 5C)** | 2/10 | All 25 routes return 501; WebSocket/QR/Offline missing |
| **Contracts** | 1/10 | **Zero Phase 5 schemas in contracts package** |
| **API Gateway Integration** | 4/10 | Services wired but repos missing; auth missing |
| **Modular Monolith Compliance** | 5/10 | Domain layer OK; infra/routes break rules |
| **Contract-First** | 2/10 | **Zero Phase 5 contracts** |
| **Dream Architecture Patterns** | 3/10 | Missing: Event Bus, Outbox, CQRS, Seat Locking, Webhooks, DLQ, Observability |

### **OVERALL: 3.5/10**

---

## 7. Top 10 Critical Blockers

| # | Blocker | Impact | Effort |
|---|---------|--------|--------|
| 1 | **Zero Phase 5 contracts** | Frontend cannot integrate; contract parity impossible | 2-3 days |
| 2 | **Zero Phase 5 repository implementations** | Services cannot persist data | 3-4 days |
| 3 | **All 25 HTTP routes return 501** | No API surface for frontend/mobile | 4-5 days |
| 4 | **Zero unit tests for Phase 5** | No regression safety; contract parity unverifiable | 3-4 days |
| 5 | **Scanner auth (D-022) missing** | Security vulnerability per phase doc | 2 days |
| 6 | **WebSocket live stats missing** | Core UX requirement for door ops | 2-3 days |
| 7 | **Magic Ticket QR not implemented** | High-value ticket feature broken | 2 days |
| 8 | **Offline support missing** | Required for venue reliability | 3-4 days |
| 9 | **No contract parity tests** | Cannot verify frontend/backend sync | 1-2 days |
| 10 | **Rate limit classes undefined** | DoS vulnerability on scanner endpoints | 1 day |

---

## 8. Recommended Execution Order

### Week 1: Foundation (Contracts + Repositories)
1. **Day 1-2**: Add all Phase 5 Zod schemas to `packages/contracts/src/client.ts`
2. **Day 2-3**: Implement all 7 memory repository adapters
3. **Day 3-4**: Implement all 7 Firestore repository adapters (compare-and-set)
4. **Day 4-5**: Write contract suite tests against memory adapters

### Week 2: Services + Tests
5. **Day 1-2**: Verify all 3 services work with both adapters (contract suite)
6. **Day 2-3**: Write unit tests for all 5 domain models
7. **Day 3-4**: Write integration tests for `processEntryScan`, wallet debit/credit
8. **Day 5**: Run `pnpm check` — must pass

### Week 3: HTTP + WebSocket
9. **Day 1-2**: Implement all 25 HTTP route handlers (thin: validate→auth→service→serialize)
10. **Day 2-3**: Implement Magic Ticket QR endpoint (HMAC ±65s)
11. **Day 3-4**: Implement WebSocket live stats (connection scoped to event+session)
12. **Day 4-5**: Implement offline manifest + sync (signed, dedup)

### Week 4: Security + Polish
13. **Day 1**: Implement D-022 scanner auth (short-lived signed token)
14. **Day 2**: Implement rate limit classes (SCANNER/DOOR/COVER_WALLET_COMMAND)
15. **Day 3**: Implement offline debits blocking, velocity limits at API layer
15. **Day 4**: Contract parity tests (33+ checks), `pnpm check` all green
15. **Day 5**: E2E integration tests, update Session Log, verify `pnpm check`

---

## 9. Files Requiring Immediate Attention

### Create (Missing)
```
packages/contracts/src/client.ts          → ADD Phase 5 schemas
packages/contracts/src/index.ts           → EXPORT Phase 5 types
packages/core/src/infrastructure/memory/memory-scan-ledger-repository.ts
packages/core/src/infrastructure/memory/memory-event-code-repository.ts
packages/core/src/infrastructure/memory/memory-scanner-session-repository.ts
packages/core/src/infrastructure/memory/memory-door-sale-repository.ts
packages/core/src/infrastructure/memory/memory-cover-wallet-repository.ts
packages/core/src/infrastructure/memory/memory-cover-wallet-reconciliation-repository.ts
packages/core/src/infrastructure/firestore/firestore-scan-ledger-repository.ts
packages/core/src/infrastructure/firestore/firestore-event-code-repository.ts
packages/core/src/infrastructure/firestore/firestore-scanner-session-repository.ts
packages/core/src/infrastructure/firestore/firestore-door-sale-repository.ts
packages/core/src/infrastructure/firestore/firestore-cover-wallet-repository.ts
packages/core/src/infrastructure/firestore/firestore-cover-wallet-reconciliation-repository.ts
packages/core/src/domain/models/scan-ledger.test.ts
packages/core/src/domain/models/event-code.test.ts
packages/core/src/domain/models/cover-wallet.test.ts
packages/core/src/domain/models/door-sale.test.ts
```

### Fix (Broken)
```
apps/api-gateway/src/routes/v2/phase5-routes.ts    → REPLACE all 501s with service calls
apps/api-gateway/src/lib/v2-services.ts             → VERIFY all repos exist
apps/api-gateway/src/plugins/auth.ts                → ADD SCANNER auth type
packages/contracts/src/client.ts                    → ADD Phase 5 Zod schemas
packages/contracts/src/index.ts                     → EXPORT Phase 5 types
```

---

## 10. Session Log

**2026-08-20**: Comprehensive audit completed. Phase 5 domain layer complete but infrastructure, contracts, and HTTP layer have critical gaps. Modular monolith structure respected in domain layer but violated in routes and missing adapters. Overall readiness: 3.5/10.

**Next Session**: Begin Week 1 execution — Phase 5 contracts + memory repositories.