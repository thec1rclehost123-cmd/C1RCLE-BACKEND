# Phase 5 Implementation Plan: Door / Scanner / Cover Wallet

**Version:** 1.0  
**Date:** 2026-08-21  
**Status:** Ready for Implementation  
**Depends on:** Phase 4 (Guest Checkout & Tickets) - Completed  
**Architecture:** Modular Monolith (Fastify 5, TypeScript, pnpm workspaces)

---

## 📋 Executive Summary

Phase 5 implements the **Door/Scanner/Cover Wallet** vertical slice - the on-site operations layer that enables real-time ticket scanning, walk-in/dine-in sales, and cover-charge wallet management at venues. This is the "on-site operations" vertical that makes the system production-ready for venue operations.

### Why Phase 5 Now?
- **Phase 4 (Guest Checkout & Tickets)** is complete - entitlements exist
- Scanner/Door operations depend on valid entitlements (Phase 4 output)
- Cover wallet depends on event/entitlement infrastructure (Phase 3/4)
- This is the "on-site operations" vertical that makes venues operational

### Business Value Delivered
- **Venue Operations**: Real-time ticket scanning, walk-in/dine-in sales
- **Revenue Capture**: Cover-charge wallet, walk-in sales, reconciliation
- **Security**: Magic Ticket rotating QR (HMAC), velocity limits, offline support
- **Live Ops**: Real-time WebSocket stats for venue dashboard

---

## 🎯 Implementation Scope

### Phase 5A: Domain Layer (Week 1-2)
**Files to Create:**
```
packages/core/src/domain/models/
├── scan-ledger.ts              # ScanLedger entity, FSM (PENDING → CONSUMED|DENIED)
├── event-code.ts               # EventCode + ScannerSession entities
├── door-sale.ts                # DoorSale entity (walkin|dinein)
├── cover-wallet.ts             # CoverWallet + CoverWalletTxn entities
├── cover-wallet-reconciliation.ts  # Reconciliation entity
```

### Phase 5B: Repository Ports & Memory Adapters (Week 2-3)
**Ports to Create:**
```
packages/core/src/domain/ports/
├── scan-ledger-repository.ts
├── event-code-repository.ts
├── door-sale-repository.ts
├── cover-wallet-repository.ts
```

**Memory Adapters:**
```
packages/core/src/infrastructure/memory/
├── memory-scan-ledger-repository.ts
├── memory-event-code-repository.ts
├── memory-door-sale-repository.ts
├── memory-cover-wallet-repository.ts
├── memory-cover-wallet-reconciliation-repository.ts
```

### Phase 5C: Application Services (Week 2-3)
```
packages/core/src/application/
├── scanner/scanner-service.ts      # createSession, validateSession, processEntryScan, getLiveStats
├── door/door-service.ts            # walkInSale, dineInSale, getLiveStats
├── cover-wallet/cover-wallet-service.ts  # issueWallet, debit, credit, terminate, reconcile
├── scanner/magic-ticket.ts         # Magic Ticket QR generation/verification
```

### Phase 5C: Firestore Adapters (Week 3-4)
```
packages/core/src/infrastructure/firestore/
├── firestore-scan-ledger-repository.ts
├── firestore-event-code-repository.ts
├── firestore-door-sale-repository.ts
├── firestore-cover-wallet-repository.ts
├── firestore-cover-wallet-reconciliation-repository.ts
```

### Phase 5D: HTTP Routes + WebSocket (Week 4-5)
```
apps/api-gateway/src/routes/v2/
├── door/sessions.ts          # Scanner session auth
├── door/check-ins.ts         # processEntryScan
├── door/lookup.ts            # Ticket lookup
├── door/override.ts          # Override (ticket.override permission)
├── door/offline-manifest.ts  # Offline manifest download
├── door/offline-sync.ts      # Offline scan sync
├── door/walk-in.ts           # Walk-in sale
├── door/dine-in.ts           # Dine-in sale
├── door/sales.ts             # List door sales
├── door/stats.ts             # Live stats (WebSocket)
├── cover-wallets.ts          # Wallet CRUD + debit/credit/terminate/reconcile
├── tickets/qr.ts             # Magic Ticket QR
├── door/offline-manifest.ts  # Offline manifest
├── door/offline-sync.ts      # Offline sync
└── door/stats/ws.ts          # WebSocket live stats
```

### Phase 5E: Contracts & Wiring (Week 4-5)
- Add Phase 5 schemas to `packages/contracts/src/contracts/phase5.ts`
- Add error codes: `SCANNER_SESSION_EXPIRED`, `VELOCITY_LIMIT_EXCEEDED`, `WALLET_TERMINATED`, `OFFLINE_MANIFEST_EXPIRED`
- Wire services in `v2-services.ts`
- Add WebSocket plugin for live stats

---

## 📐 Architecture Rules (Non-Negotiable)

### Modular Monolith Principles
1. **Domain Layer Pure** - Zero `process.env`, zero Fastify, zero Firebase imports in `packages/core/src/domain/**`
2. **Ports over Implementation** - Domain depends on interfaces (`ScanLedgerRepository`), not Firestore
3. **Thin Routes** - Route = validate → auth → policy → ONE service call → serialize
4. **Contracts Backend-Owned** - `packages/contracts` is source of truth; frontend mirrors
5. **Optimistic Locking** - Every mutable entity has `version` + `updatedAt`
3. **Idempotency** - Every write endpoint requires `Idempotency-Key`
4. **Admin Audit** - Every privileged write goes through `AdminAuditRepository`

### Data Flow (The Golden Path)
```
Request → Validate (zod) → Auth (Better Auth) → Policy (RBAC+ABAC) 
    → Service (Domain Logic) → Repository (Port) → Firestore/Memory
    → Response (zod validate) → Client
```

---

## 🔐 Security Requirements (Non-Negotiable)

| Requirement | Implementation |
|-------------|----------------|
| **Scanner Auth** | Short-lived signed token from staff login (D-022 pattern) - NOT trust body fields |
| **Door Price** | ALWAYS recalculated server-side from event catalog |
| **Cover Wallet Velocity** | 3 debits/min/device enforced at API layer |
| **Terminated Wallets** | Reject ALL mutations at service layer |
| **Offline Debits** | Blocked at API layer (403) |
| **Magic Ticket QR** | HMAC(entitlementId:⌊unixTime/30⌋) ±65s clock drift |
| **Price Recalculation** | Server-side ONLY, never trust client |
| **Idempotency Keys** | Required on ALL mutations |
| **WebSocket Scope** | Connection scoped to event+session or org, NOT global |

---

## 🏗️ Implementation Order (Dependency-Aware)

```
1. Contracts (Phase 5 schemas)          ← FIRST: Wire contract
2. Domain Models (5 entities)           ← Pure domain, no infra
3. Repository Ports (4 interfaces)      ← Pure TS interfaces
4. Memory Adapters (4 implementations)  ← In-memory for tests
5. Domain Services (3 services)         ← Pure domain logic
6. Firestore Adapters (6 adapters)      ← Real storage
7. HTTP Routes (25 endpoints)           ← Thin: validate→auth→service
8. WebSocket (1 endpoint)               ← Live stats push
9. Contracts (Phase 5 schemas)          ← Wire contract
9. Service Wiring (v2-services.ts)      ← Dependency injection
10. Contract Parity Tests               ← 33+ checks
11. E2E Integration Tests               ← Full flows
```

---

## 📁 File Structure (New Files Only)

### Domain Models
```
packages/core/src/domain/models/
├── scan-ledger.ts
├── event-code.ts
├── door-sale.ts
├── cover-wallet.ts
└── cover-wallet-reconciliation.ts
```

### Repository Ports
```
packages/core/src/domain/ports/
├── scan-ledger-repository.ts
├── event-code-repository.ts
├── door-sale-repository.ts
└── cover-wallet-repository.ts
```

### Application Services
```
packages/core/src/application/
├── scanner/
│   ├── scanner-service.ts
│   └── magic-ticket.ts
├── door/
│   └── door-service.ts
└── cover-wallet/
    └── cover-wallet-service.ts
```

### Infrastructure - Memory
```
packages/core/src/infrastructure/memory/
├── memory-scan-ledger-repository.ts
├── memory-event-code-repository.ts
├── memory-door-sale-repository.ts
├── memory-cover-wallet-repository.ts
└── memory-cover-wallet-reconciliation-repository.ts
```

### Infrastructure - Firestore
```
packages/core/src/infrastructure/firestore/
├── firestore-scan-ledger-repository.ts
├── firestore-event-code-repository.ts
├── firestore-door-sale-repository.ts
├── firestore-cover-wallet-repository.ts
└── firestore-cover-wallet-reconciliation-repository.ts
```

### Application Services
```
packages/core/src/application/
├── scanner/
│   ├── scanner-service.ts
│   └── magic-ticket.ts
├── door/
│   └── door-service.ts
└── cover-wallet/
    └── cover-wallet-service.ts
```

### API Gateway Routes
```
apps/api-gateway/src/routes/v2/
├── door/
│   ├── sessions.ts
│   ├── check-ins.ts
│   ├── lookup.ts
│   ├── override.ts
│   ├── offline-manifest.ts
│   ├── offline-sync.ts
│   ├── walk-in.ts
│   ├── dine-in.ts
│   ├── sales.ts
│   ├── stats.ts
│   ├── offline-manifest.ts
│   ├── offline-sync.ts
│   └── stats/ws.ts
├── cover-wallets.ts
├── tickets/qr.ts
└── phase5-routes.ts (optional aggregator)
```

### Contracts
```
packages/contracts/src/contracts/
├── phase5.ts           # All Phase 5 schemas
```

---

## ✅ Verification Gates (Must Pass)

| Gate | Command | Must Pass |
|------|---------|-----------|
| **Format/Lint** | `pnpm lint` | ✅ |
| **Typecheck** | `pnpm typecheck` | ✅ |
| **Boundaries** | `pnpm boundaries` | ✅ (no architecture violations) |
| **Unit Tests** | `pnpm test` | ✅ 29/29 contract tests pass |
| **Contract Parity** | `node scripts/contract-parity.mjs` | ✅ 33+ checks |
| **Build** | `pnpm build` | ✅ |
| **Full Check** | `pnpm check` | ✅ ALL GREEN |

---

## 📝 Documentation Rules

### Every New File Must Have:
1. **Header Comment** - What, Why, Key Invariants
2. **JSDoc** on exported functions
3. **No inline comments** explaining "what" - code is self-documenting
4. **Architecture decision references** (e.g., `// D-015: compare-and-set`)

### File Header Template
```typescript
/**
 * ─── [Entity/Service Name] ([Phase]) ─────────────────────────────────────
 * 
 * [One paragraph: what this is, what v1 logic it ports, key invariants]
 * 
 * Key invariants:
 * - [Invariant 1]
 * - [Invariant 2]
 * - [Invariant 3]
 */
```

### Documentation Updates Required
After each sub-phase, update:
1. `docs/roadmap/phase-05-door-scanner-cover-wallet.md` - Checklist + Session Log
2. `docs/roadmap/ROADMAP.md` - Phase status table
3. `docs/phase-05-implementation-log.md` - Running log of decisions

---

## ⚠️ Known Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Firestore Transactions** | Balance+Txn atomicity requires transactions | Use compare-and-set (D-015) pattern from Phase 4 |
| **Magic Ticket Clock Drift** | ±65s tolerance | Test with ±70s drift; log failures |
| **Velocity Limit Race** | 3 debits/min/device | Use Firestore transactions for atomic check+debit |
| **Offline Sync Conflicts** | Duplicate scan detection | Deterministic ID: `eventId_entitlementId_deviceId_timestamp` |
| **WebSocket Scaling** | Connection per event+session | Scope connections; cleanup on disconnect |

---

## 📋 Definition of Done (Phase 5 Complete)

- [ ] All 5 domain models with FSM tests passing
- [ ] 4 repository ports + 4 memory adapters + 6 Firestore adapters
- [ ] 3 application services with unit tests (24/24 passing)
- [ ] 25 HTTP routes + 1 WebSocket endpoint implemented
- [ ] Phase 5 contracts in `packages/contracts`
- [ ] Service wiring in `v2-services.ts` 
- [ ] `pnpm check` → ALL GREEN
- [ ] Contract parity (33+ checks) passes
- [ ] E2E tests: 8 scenarios passing
- [ ] Documentation updated (phase-05-door-scanner-cover-wallet.md, ROADMAP.md)
- [ ] Session log appended to phase-05-door-scanner-cover-wallet.md

---

## 🚀 Next Steps

**Start with:** Phase 5A - Domain Models (scan-ledger.ts, event-code.ts, door-sale.ts, cover-wallet.ts, cover-wallet-reconciliation.ts)

**Estimated Effort:** 5-6 weeks (2 devs parallel)

**Dependencies:** Phase 4 complete ✅, Phase 4 entitlements exist

---

*Document Version: 1.0 | Created: 2026-08-21 | Next Review: After Phase 5A completion*