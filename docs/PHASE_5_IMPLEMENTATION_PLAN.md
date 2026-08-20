# Phase 5 Detailed Implementation Plan

**Based on**: Comprehensive Audit Report (PHASE_5_AUDIT_REPORT.md)  
**Target**: Complete Phase 5 (Door / Scanner / Cover-wallet) per documented architecture  
**Duration**: 4 weeks (20 working days)  
**Definition of Done**: `pnpm check` passes (format → lint → typecheck → boundaries → test → build)

---

## Week 1: Foundation — Contracts + Memory Repositories (Days 1-5)

### Day 1-2: Phase 5 Contracts (packages/contracts)

#### 1.1 Add Phase 5 Zod Schemas to `packages/contracts/src/client.ts`

**Scanner Schemas**:
```typescript
// Scanner Session
export const scannerSessionCreateBodySchema = z.object({
  eventId: opaqueIdSchema,
  code: z.string().min(1),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  sessionType: z.enum(['staff', 'device']),
}).strict();

export const scannerSessionDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  codeId: opaqueIdSchema,
  sessionToken: z.string().min(1),
  sessionExpiresAt: z.iso.datetime(),
  permissions: z.object({
    canScan: z.boolean(),
    canDoorEntry: z.boolean(),
    canWalkIn: z.boolean(),
    canCharge: z.boolean(),
  }),
  status: z.enum(['active', 'revoked', 'expired']),
  createdAt: z.iso.datetime(),
});

// Scan Request/Response
export const scanRequestSchema = z.object({
  eventId: opaqueIdSchema,
  qrPayload: z.string().min(1),
  scannedBy: z.object({
    uid: opaqueIdSchema,
    name: z.string(),
    role: z.string(),
  }),
  gate: z.string().optional(),
  deviceId: z.string().optional(),
  isOffline: z.boolean().optional(),
}).strict();

export const scanResponseSchema = z.object({
  status: z.enum(['consumed', 'denied']),
  checkInId: opaqueIdSchema.optional(),
  denyReason: z.enum([
    'invalid_signature',
    'already_used',
    'expired',
    'wrong_event',
    'device_invalid',
    'void_ticket',
    'capacity_exceeded',
    'wrong_gate',
    'offline_expired',
    'override_required',
    'promoter_not_authorized',
  ]).optional(),
  denyMessage: z.string().optional(),
  entitlement: z.object({
    id: opaqueIdSchema,
    tierName: z.string(),
    holderName: z.string(),
    scansUsed: z.number().int(),
    scansAllowed: z.number().int(),
  }).optional(),
});

// Magic Ticket QR
export const magicQrRequestSchema = z.object({
  entitlementId: opaqueIdSchema,
  tierPricePaise: z.number().int().nonnegative(),
}).strict();

export const magicQrResponseSchema = z.object({
  qrPayload: z.string(), // HMAC(entitlementId:timestamp)
  expiresAt: z.iso.datetime(),
  refreshIntervalSec: z.number().int().default(30),
});

// Offline Support
export const offlineManifestRequestSchema = z.object({
  eventId: opaqueIdSchema,
  scannerSessionId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export const offlineManifestResponseSchema = z.object({
  manifest: z.array(z.object({
    entitlementId: opaqueIdSchema,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime(),
    signature: z.string(),
  })),
  signedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const offlineSyncRequestSchema = z.object({
  scannerSessionId: opaqueIdSchema,
  scans: z.array(z.object({
    payload: z.string(),
    scannedAt: z.iso.datetime(),
    deviceId: z.string(),
  })),
}).strict();

export const offlineSyncResponseSchema = z.object({
  synced: z.number().int(),
  conflicts: z.array(z.object({
    payload: z.string(),
    reason: z.string(),
  })),
});
```

**Door Schemas**:
```typescript
// Walk-in / Dine-in
export const doorWalkInRequestSchema = z.object({
  eventId: opaqueIdSchema,
  guestName: z.string().min(1),
  guestPhone: z.string().optional().nullable(),
  guestAge: z.number().int().min(0).max(120).optional().nullable(),
  gender: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  totalGuests: z.number().int().min(1).max(100).default(1),
  gate: z.string().optional().nullable(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']).default('cash'),
  tierId: opaqueIdSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const doorDineInRequestSchema = doorWalkInRequestSchema.extend({
  tableNumber: z.string().optional().nullable(),
}).strict();

export const doorSaleResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  category: z.enum(['walkin', 'dinein']),
  guestName: z.string(),
  totalGuests: z.number().int(),
  amountPaise: z.number().int().nonnegative(),
  paymentMode: z.enum(['cash', 'card', 'upi', 'other']),
  status: z.enum(['active', 'voided', 'refunded']),
  createdAt: z.iso.datetime(),
});

export const doorSalesListResponseSchema = paginatedSchema(doorSaleResponseSchema);
```

**Cover Wallet Schemas**:
```typescript
// Wallet
export const coverWalletIssueRequestSchema = z.object({
  eventId: opaqueIdSchema,
  userId: opaqueIdSchema,
  openingBalancePaise: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export const coverWalletDebitRequestSchema = z.object({
  walletId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  referenceId: opaqueIdSchema.optional(),
  referenceType: z.string().optional(),
  description: z.string().optional(),
  idempotencyKey: idempotencyKeySchema,
  deviceId: z.string().optional(),
}).strict();

export const coverWalletCreditRequestSchema = z.object({
  walletId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  referenceId: opaqueIdSchema.optional(),
  referenceType: z.string().optional(),
  description: z.string().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const coverWalletResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  userId: opaqueIdSchema,
  balancePaise: z.number().int().nonnegative(),
  status: z.enum(['active', 'terminated', 'closed']),
  openingBalancePaise: z.number().int().nonnegative(),
  totalCreditsPaise: z.number().int().nonnegative(),
  totalDebitsPaise: z.number().int().nonnegative(),
  terminatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const coverWalletReconciliationRequestSchema = z.object({
  eventId: opaqueIdSchema,
  reconciliationDate: z.iso.date(),
  walletId: opaqueIdSchema.optional(),
  userId: opaqueIdSchema.optional(),
}).strict();

export const coverWalletReconciliationResponseSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  reconciliationDate: z.iso.date(),
  expectedBalancePaise: z.number().int(),
  actualBalancePaise: z.number().int(),
  discrepancyPaise: z.number().int(),
  status: z.enum(['pending', 'completed', 'discrepancy', 'resolved']),
  discrepancies: z.array(z.object({
    type: z.enum([
      'balance_mismatch',
      'missing_credit',
      'missing_debit',
      'extra_transaction',
      'duplicate_transaction',
      'offline_sync_gap',
    ]),
    walletId: opaqueIdSchema,
    expectedAmountPaise: z.number().int(),
    actualAmountPaise: z.number().int(),
    transactionId: opaqueIdSchema.nullable(),
    description: z.string(),
  })),
  createdAt: z.iso.datetime(),
});
```

**Error Codes** (add to existing error schema):
```typescript
export const phase5ErrorCodes = z.enum([
  'SCANNER_SESSION_EXPIRED',
  'VELOCITY_LIMIT_EXCEEDED',
  'WALLET_TERMINATED',
  'OFFLINE_MANIFEST_EXPIRED',
  'MAGIC_TICKET_SIGNATURE_INVALID',
  'SCANNER_SESSION_REVOKED',
  'COVER_WALLET_INSUFFICIENT_BALANCE',
  'DOOR_SALE_PRICE_MISMATCH',
]);
```

#### 1.2 Export Phase 5 Types in `packages/contracts/src/index.ts`

```typescript
// Phase 5 exports
export type {
  ScannerSessionCreateBody,
  ScannerSessionDto,
  ScanRequest,
  ScanResponse,
  MagicQrRequest,
  MagicQrResponse,
  OfflineManifestRequest,
  OfflineManifestResponse,
  OfflineSyncRequest,
  OfflineSyncResponse,
  DoorWalkInRequest,
  DoorDineInRequest,
  DoorSaleResponse,
  DoorSalesListResponse,
  CoverWalletIssueRequest,
  CoverWalletDebitRequest,
  CoverWalletCreditRequest,
  CoverWalletResponse,
  CoverWalletReconciliationRequest,
  CoverWalletReconciliationResponse,
  Phase5ErrorCode,
} from './client.js';
```

#### 1.3 Build & Verify Contracts
```bash
cd packages/contracts && pnpm build && pnpm typecheck
```

---

### Day 2-3: Memory Repository Adapters (7 adapters)

Create in `packages/core/src/infrastructure/memory/`:

#### 2.1 `memory-scan-ledger-repository.ts`
Implements `ScanLedgerRepository` with:
- In-memory Map storage
- `findByEventAndEntitlement` for duplicate detection
- `findByEvent`, `findByOrganization`, `findByDevice`, `findByOperator` with pagination
- Status transitions with validation
- `findOfflineScans` for sync

#### 2.2 `memory-event-code-repository.ts`
Implements `EventCodeRepository` + `ScannerSessionRepository`:
- Event codes with `byCode` index
- Scanner sessions with token hash lookup
- Active session counting per code
- `adjustActiveSessions` for concurrency control

#### 2.3 `memory-scanner-session-repository.ts`
(Can be combined with event-code or separate)

#### 2.4 `memory-door-sale-repository.ts`
Implements `DoorSaleRepository`:
- Idempotency key index
- `findByEvent`, `findByOrganization`, `findByVenue`, `findByCategory`, `findByCreator`
- Event stats aggregation

#### 2.5 `memory-cover-wallet-repository.ts`
Implements `CoverWalletRepository`:
- `findByEventAndUser` (unique per user/event)
- Atomic credit/debit via compare-and-set
- Velocity limit tracking (3 debits/min/device)
- Nightlife termination logic

#### 2.6 `memory-cover-wallet-txn-repository.ts`
Implements `CoverWalletTxnRepository`:
- Idempotency key index
- `findByWallet`, `findByEvent`, `findByType`, `findByReference`
- `countRecentDebits` for velocity

#### 2.7 `memory-cover-wallet-reconciliation-repository.ts`
Implements `CoverWalletReconciliationRepository`:
- `findByEventAndDate` for deduplication
- `findPending`, `findWithDiscrepancies`
- Org stats aggregation

---

### Day 3-4: Firestore Repository Adapters (7 adapters)

Create in `packages/core/src/infrastructure/firestore/`:

Use the same patterns as existing Firestore adapters:
- `compareAndSet` for optimistic locking (D-015)
- Denormalized indexes where needed
- `paginateQuery` for pagination
- Transactions for atomic operations (credit/debit)

Key adapters:
1. `firestore-scan-ledger-repository.ts`
2. `firestore-event-code-repository.ts` + `firestore-scanner-session-repository.ts`
3. `firestore-door-sale-repository.ts`
4. `firestore-cover-wallet-repository.ts` (uses transactions for atomic credit/debit)
5. `firestore-cover-wallet-txn-repository.ts`
6. `firestore-cover-wallet-reconciliation-repository.ts`

**Export all** in `packages/core/src/infrastructure/firestore/index.ts`

---

### Day 4-5: Contract Suite Tests + `pnpm check`

#### 5.1 Contract Suite Tests
Create `packages/core/src/infrastructure/contract-suite.ts` (or use existing pattern):
- Run same test suite against both memory and Firestore adapters
- Tests for each repository interface
- Verify compare-and-set behavior

#### 5.2 Run Full Check
```bash
cd packages/core && pnpm build && pnpm test && pnpm typecheck
```

**Gate**: All green before Week 2.

---

## Week 2: Services + Tests (Days 6-10)

### Day 6-7: Service Integration Verification

#### 6.1 Verify All 3 Services Work with Both Adapters
- Test `ScannerService` with memory + Firestore
- Test `DoorService` with memory + Firestore  
- Test `CoverWalletService` with memory + Firestore
- Fix any integration issues

#### 6.2 Add Missing Service Dependencies
- Ensure `pricing` service available for DoorService
- Ensure `entitlements` repo available for ScannerService

---

### Day 8-9: Unit Tests (4 domain models)

#### 9.1 `scan-ledger.test.ts`
- FSM transitions: `pending → consumed|denied|cancelled|expired → revoked`
- `processEntryScan` idempotency (same entitlement scanned twice)
- Magic Ticket HMAC verification ±65s clock drift
- Offline scan handling

#### 9.2 `event-code.test.ts`
- Session token generation/validation
- Permission scoping by type (`full`, `scan_only`, `charge`)
- Active session count increments/decrements
- Code revocation and expiry

#### 9.3 `cover-wallet.test.ts`
- Debit/credit atomicity (balance + txn same transaction)
- Velocity limits: max 3 debits/min/device
- Termination logic: balance=0 → terminated
- Nightlife termination time: `computeTerminationTime(eventStart, 5, '+05:30')`

#### 9.4 `door-sale.test.ts`
- Server-side price recalculation from catalog
- Synthetic order creation with idempotency key
- Cover wallet integration on walk-in/dine-in

---

### Day 10: Integration Tests + `pnpm check`

#### 10.1 Integration Tests
- `processEntryScan` dual-path idempotency (online + offline sync)
- Cover wallet debit → credit → terminate → reconciliation
- WebSocket live stats push on scan/sale
- Offline manifest download → offline scan → sync → dedup

#### 10.2 Full Check
```bash
cd packages/core && pnpm check
```
**Must pass**: format → lint → typecheck → boundaries → test → build

---

## Week 3: HTTP Routes + WebSocket (Days 11-15)

### Day 11-12: HTTP Route Handlers (25 routes)

Replace all 501 responses in `apps/api-gateway/src/routes/v2/phase5-routes.ts`:

**Scanner Routes** (9):
1. `POST /door/sessions` → `scanner.createSession`
2. `GET /door/sessions/:sessionId` → `scanner.getSession`
3. `POST /door/check-ins` → `scanner.processEntryScan`
4. `GET /door/check-ins/:checkInId` → `scanner.getCheckIn`
5. `POST /door/lookup` → `scanner.lookupTicket`
6. `POST /door/override` → `scanner.overrideDenied` (requires `ticket.override`)
7. `GET /door/offline-manifest` → `scanner.getOfflineManifest`
8. `POST /door/offline-sync` → `scanner.syncOfflineScans`
9. `POST /door/check-ins/verify` → `scanner.verifyScan` (preview)

**Door Routes** (4):
10. `POST /door/walk-in` → `door.createWalkIn` (server-side price recalc)
11. `POST /door/dine-in` → `door.createDineIn`
12. `GET /door/sales` → `door.listSales`
13. `GET /door/stats` → `door.getLiveStats` (HTTP fallback)

**Cover Wallet Routes** (8):
14. `POST /cover-wallets` → `coverWallet.createWallet`
15. `POST /cover-wallets/:walletId/debit` → `coverWallet.debitWallet` (velocity check)
16. `POST /cover-wallets/:walletId/credit` → `coverWallet.creditWallet`
17. `GET /cover-wallets/:walletId` → `coverWallet.getWallet`
18. `POST /cover-wallets/:walletId/freeze` → `coverWallet.freezeWallet`
19. `POST /cover-wallets/:walletId/unfreeze` → `coverWallet.unfreezeWallet`
20. `POST /cover-wallets/:walletId/terminate` → `coverWallet.terminateWallet`
21. `POST /cover-wallets/:walletId/reconcile` → `coverWallet.runReconciliation`

**Magic QR** (1):
22. `GET /tickets/:ticketId/qr` → `scanner.getMagicQr` (HMAC ±65s)

**Offline** (2):
23. `GET /door/offline-manifest` → `scanner.getOfflineManifest`
24. `POST /door/offline-sync` → `scanner.syncOfflineScans`

**WebSocket** (1):
25. `GET /door/stats/ws` → WebSocket upgrade handler

---

### Day 13-14: Magic Ticket QR + WebSocket

#### 13.1 Magic Ticket QR Endpoint
```typescript
// GET /tickets/:ticketId/qr
// Returns rotating HMAC payload: HMAC(entitlementId : floor(unixTime/30))
// Verify checks current + previous 30s window (±65s clock drift)
// Static QR for tickets < ₹5000
```

#### 14.1 WebSocket Live Stats
```typescript
// GET /door/stats/ws
// Upgrade to WebSocket
// Connection scoped to eventId + scannerSessionId or organizationId
// Push on every processEntryScan and walkInSale/dineInSale
// Message: { totalEntered, checkedIn, doorEntries, doorRevenue, walkIns, entryTypeCounts }
```

---

### Day 15: Offline Support + Rate Limits

#### 15.1 Offline Manifest + Sync
```typescript
// GET /door/offline-manifest?eventId&scannerSessionId&expiresAt
// Returns signed manifest with entitlement validity windows
// POST /door/offline-sync
// Syncs offline scans with dedup (same entitlement+device+time)
```

#### 15.2 Rate Limit Classes
Add to gateway config:
- `SCANNER_COMMAND`: 300/min
- `DOOR_COMMAND`: 60/min  
- `COVER_WALLET_COMMAND`: 30/min

---

## Week 4: Security + Polish (Days 16-20)

### Day 16: D-022 Scanner Auth
Implement short-lived signed token pattern:
1. Staff login → `/door/sessions` creates session with signed JWT
2. Scanner includes token in `Authorization: Bearer <token>`
3. Gateway verifies signature, extracts sessionId
4. Session scoped to event+code+gate+shift
5. Token expires after shift (12h)

### Day 17: Security Hardening
- Offline debits blocked at API layer (reject if `isOnline: false`)
- Velocity limits enforced at API layer (3 debits/min/device)
- Magic Ticket HMAC verification ±65s
- Server-side price recalculation (never trust client)

### Day 18: Contract Parity Tests
Run `scripts/contract-parity.mjs` — 33+ checks:
- Request/response schema validation
- Error code mapping
- Pagination format
- Idempotency key handling
- Version header (`If-Match`)

### Day 19: E2E Integration Tests
Full flow tests:
1. Scanner session creation → scan valid ticket → check-in recorded → live stats update
2. Scanner session creation → scan expired ticket → DENIED → scan ledger written
3. Scanner session creation → scan already consumed ticket → DENIED
4. Magic Ticket QR verification (±65s drift)
5. Walk-in sale → server-side price recalc → synthetic order → door sale recorded
6. Cover wallet issue → debit (velocity limit) → credit → terminate → reconciliation
7. Offline manifest download → offline scan → sync → dedup
8. Cover wallet termination at nightlife cutoff time

### Day 20: Final Verification
```bash
cd C1RCLE-BACKEND && pnpm check
```
**Must pass**: format → lint → typecheck → boundaries → test → build

Update Session Log in `docs/roadmap/phase-05-door-scanner-cover-wallet.md`

---

## File Creation Checklist

### Contracts (Week 1)
- [ ] `packages/contracts/src/client.ts` — ADD Phase 5 schemas
- [ ] `packages/contracts/src/index.ts` — EXPORT Phase 5 types

### Memory Repositories (Week 1)
- [ ] `packages/core/src/infrastructure/memory/memory-scan-ledger-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-event-code-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-scanner-session-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-door-sale-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-cover-wallet-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-cover-wallet-txn-repository.ts`
- [ ] `packages/core/src/infrastructure/memory/memory-cover-wallet-reconciliation-repository.ts`

### Firestore Repositories (Week 1)
- [ ] `packages/core/src/infrastructure/firestore/firestore-scan-ledger-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-event-code-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-scanner-session-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-door-sale-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-cover-wallet-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-cover-wallet-txn-repository.ts`
- [ ] `packages/core/src/infrastructure/firestore/firestore-cover-wallet-reconciliation-repository.ts`

### Tests (Week 2)
- [ ] `packages/core/src/domain/models/scan-ledger.test.ts`
- [ ] `packages/core/src/domain/models/event-code.test.ts`
- [ ] `packages/core/src/domain/models/cover-wallet.test.ts`
- [ ] `packages/core/src/domain/models/door-sale.test.ts`

### Route Handlers (Week 3)
- [ ] `apps/api-gateway/src/routes/v2/phase5-routes.ts` — REPLACE all 501s

### Auth (Week 4)
- [ ] `apps/api-gateway/src/plugins/auth.ts` — ADD SCANNER auth type

---

## Success Criteria

**Week 1 Gate**: `pnpm build && pnpm test && pnpm typecheck` all pass in `packages/core` and `packages/contracts`

**Week 2 Gate**: `pnpm check` passes in `packages/core` (all tests green)

**Week 3 Gate**: All 25 HTTP routes return 200/201/4xx (no 501), WebSocket connects

**Week 4 Gate**: `pnpm check` passes at repo root, `pnpm test` all pass, Session Log updated

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Firestore adapters complex | Start with memory adapters, use same contract suite |
| WebSocket scaling | Use Fastify built-in WebSocket, scope connections |
| Offline sync conflicts | Deterministic IDs, idempotency keys, last-write-wins with audit |
| Rate limit implementation | Use Fastify rate-limit plugin with custom keys |
| Contract parity failures | Generate OpenAPI from Zod, compare with frontend expectations |

---

## Daily Standup Template

```
Date: YYYY-MM-DD
Completed: [file/tasks done]
Blockers: [what's stuck]
Next: [immediate next task]
pnpm check status: [pass/fail - which step fails]
```

---

**Start Date**: 2026-08-20  
**Target Completion**: 2026-09-16  
**Owner**: Backend Team