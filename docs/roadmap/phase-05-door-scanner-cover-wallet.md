# Phase 5 — Door / Scanner / Cover-wallet

**Status:** not started · **Depends on:** Phase 4 (entitlements must exist)

## v1 proven logic to port (`thec1rcle`)

- **Entitlement scan system** (`entitlement-engine.js`) — the current,
  non-deprecated ticket verification path (legacy static-QR system in
  `scan-engine.js` is `@deprecated`, do not port). State machine
  `ISSUED → ACTIVE → CONSUMED` (terminal) / `REVOKED` / `EXPIRED`.
  **"Magic Ticket" rotating QR** for tickets ≥ ₹5000:
  `HMAC(entitlementId : floor(unixTime/30))` — rotates every 30s, screenshot
  useless within half a minute; verify checks current + previous window
  (±65s clock-drift tolerance).
- **`processEntryScan`**: transactional — verify signature/freshness → load
  entitlement → check eventId match → check not already consumed/over
  scan-count → write `scan_ledger` (DENIED with reason or CONSUMED) →
  increment `scanCountUsed`.
- **Scanner session auth** (separate from guest auth): `event_codes/{code}`
  doc (`type: full|scan_only|charge`, optional gate, expiry, revocable) →
  session token scoped to that event/code/gate for the shift. Permissions by
  type: `full→scan+doorEntry+walkIn`, `scan_only→scan+walkIn`, `charge→cover-wallet only`.
- **Door entry (walk-up sale)**: price **always recalculated server-side**
  from the event's ticket catalog, never trusted from client (explicit v1
  security rule — port this exactly). Synthetic order doc, idempotent via
  client-supplied idempotency key.
- **Walk-ins/dine-in** (headcount, no ticket): `door_sales` collection,
  `category: walkin|dinein`, `paymentMode:'cash'`.
- **Live scanner stats**: real-time aggregate (`totalEntered, checkedIn,
  doorEntries, doorRevenue, walkIns, entryTypeCounts`), pushed over
  WebSocket to the venue dashboard so door-count updates without polling.
- **Cover-charge wallet engine** (`cover-charge-engine.js`, 1049 lines — the
  most complex single v1 module): prepaid digital wallet issued per cover-
  charge ticket. Hard invariants to port verbatim: all amounts integer paise;
  every mutation has a caller idempotency key; Firestore transactions for
  balance+txn atomicity; velocity limit (max 3 debits/min/device); terminated
  wallets reject all mutations; offline debits blocked at API layer.
  **Nightlife-specific termination time**: `computeTerminationTime(eventStartIso,
  terminationHour=5, tzOffset='+05:30')` — if event starts before the cutoff
  hour it terminates same calendar day, else next calendar day (handles
  "night doesn't end at midnight").

## Firestore collections

`v2_scan_ledger`, `v2_event_codes`, `v2_scanner_sessions`, `v2_door_sales`,
`v2_cover_wallets` (+ `txns` subcollection), `v2_cover_wallet_reconciliations`.

## ⚠️ Known v1 security note (do not blindly copy)

`PAYMENT_TICKET_CODE_REVIEW.md` (in `thec1rcle`) documents an earlier bug
where a scanner-session endpoint trusted `{eventId, venueId, userId, role}`
straight from the request body with no re-verification — spoofable. Fix
pattern: staff-login issues a short-lived signed token; `/staff/session`
verifies that token rather than trusting body fields. Verify the *current*
`thec1rcle` code before assuming this is fixed there — the review doc flags
it as a past finding, not a guaranteed-current state.

1: # Phase 5 — Door / Scanner / Cover-wallet
2: 
3: **Status:** not started · **Depends on:** Phase 4 (entitlements must exist)
5: 
6: ## v1 proven logic to port (`thec1rcle`)
6: 
7: - **Entitlement scan system** (`entitlement-engine.js`) — the current,
8:   non-deprecated ticket verification path (legacy static-QR system in
9:   `scan-engine.js` is `@deprecated`, do not port). State machine
10:   `ISSUED → ACTIVE → CONSUMED` (terminal) / `REVOKED` / `EXPIRED`.
11:   **"Magic Ticket" rotating QR** for tickets ≥ ₹5000:
12:   `HMAC(entitlementId : floor(unixTime/30))` — rotates every 30s, screenshot
13:   useless within half a minute; verify checks current + previous window
14:   (±65s clock-drift tolerance).
15: - **`processEntryScan`**: transactional — verify signature/freshness → load
16:   entitlement → check eventId match → check not already consumed/over
17:   scan-count → write `scan_ledger` (DENIED with reason or CONSUMED) →
17:   increment `scanCountUsed`.
18: - **Scanner session auth** (separate from guest auth): `event_codes/{code}`
19:   doc (`type: full|scan_only|charge`, optional gate, expiry, revocable) →
20:   session token scoped to that event/code/gate for the shift. Permissions by
21:   type: `full→scan+doorEntry+walkIn`, `scan_only→scan+walkIn`, `charge→cover-wallet only`.
22: - **Door entry (walk-up sale)**: price **always recalculated server-side**
23:   from the event's ticket catalog, never trusted from client (explicit v1
24:   security rule — port this exactly). Synthetic order doc, idempotent via
25:   client-supplied idempotency key.
24: - **Walk-ins/dine-in** (headcount, no ticket): `door_sales` collection,
25:   `category: walkin|dinein`, `paymentMode:'cash'`.
26: - **Live scanner stats**: real-time aggregate (`totalEntered, checkedIn,
27:   doorEntries, doorRevenue, walkIns, entryTypeCounts`), pushed over
28:   WebSocket to the venue dashboard so door-count updates without polling.
29: - **Cover-charge wallet engine** (`cover-charge-engine.js`, 1049 lines — the
30:   most complex single v1 module): prepaid digital wallet issued per cover-
31:   charge ticket. Hard invariants to port verbatim: all amounts integer paise;
31:   every mutation has a caller idempotency key; Firestore transactions for
32:   balance+txn atomicity; velocity limit (max 3 debits/min/device); terminated
33:   wallets reject all mutations; offline debits blocked at API layer.
33:   **Nightlife-specific termination time**: `computeTerminationTime(eventStartIso,
34:   terminationHour=5, tzOffset='+05:30')` — if event starts before the cutoff
35:   hour it terminates same calendar day, else next calendar day (handles
36:   "night doesn't end at midnight").
37: 
38: ## Firestore collections
39: 
40: `v2_scan_ledger`, `v2_event_codes`, `v2_scanner_sessions`, `v2_door_sales`,
41: `v2_cover_wallets` (+ `txns` subcollection), `v2_cover_wallet_reconciliations`.
42: 
43: ## ⚠️ Known v1 security note (do not blindly copy)
44: 
45: `PAYMENT_TICKET_CODE_REVIEW.md` (in `thec1rcle`) documents an earlier bug
46: where a scanner-session endpoint trusted `{eventId, venueId, userId, role}`
47: straight from the request body with no re-verification — spoofable. Fix
47: pattern: staff-login issues a short-lived signed token; `/staff/session`
48: verifies that token rather than trusting body fields. Verify the *current*
49: `thec1rcle` code before assuming this is fixed there — the review doc flags
50: it as a past finding, not a guaranteed-current state.
50: 
51: ## Execution Plan (Agent-driven)
51: 
52: ### Phase 5A: Domain Layer (Week 1-2)
52: 
53: #### 5A.1 Entitlement Scan Domain Models
55: **Files to create:**
56: - `packages/core/src/domain/models/scan-ledger.ts` — `ScanLedger` entity, FSM (`PENDING → CONSUMED | DENIED`), `processEntryScan` pure function
57: - `packages/core/src/domain/models/event-code.ts` — `EventCode` entity (`type: full|scan_only|charge`), `ScannerSession` entity, session token generation/validation
58: - `packages/core/src/domain/models/door-sale.ts` — `DoorSale` entity (`category: walkin|dinein`, `paymentMode`), synthetic order generation
59: - `packages/core/src/domain/models/cover-wallet.ts` — `CoverWallet` entity, `CoverWalletTxn` sub-entity, termination time computation, velocity limits
60: - `packages/core/src/domain/models/cover-wallet-reconciliation.ts` — reconciliation entity
61: 
62: **Key invariants to port verbatim:**
63: - All money = integer paise
64: - Every mutation = caller idempotency key
65: - Firestore transactions for balance+txn atomicity
66: - Velocity limit: max 3 debits/min/device
67: - Terminated wallets reject all mutations
68: - Offline debits blocked at API layer
69: - Nightlife termination: `computeTerminationTime(eventStartIso, terminationHour=5, tzOffset='+05:30')`
70: 
71: #### 5A.2 Repository Ports
72: **Files to create in `packages/core/src/domain/ports/`:**
73: - `scan-ledger-repository.ts` — `ScanLedgerRepository`
73: - `event-code-repository.ts` — `EventCodeRepository`, `ScannerSessionRepository`
74: - `door-sale-repository.ts` — `DoorSaleRepository`
75: - `cover-wallet-repository.ts` — `CoverWalletRepository`, `CoverWalletReconciliationRepository`
76: 
77: #### 5A.3 Application Services
77: **Files to create in `packages/core/src/application/`:**
78: - `scanner/scanner-service.ts` — `ScannerService`: `createSession`, `validateSession`, `processEntryScan`, `getLiveStats`
78: - `door/door-service.ts` — `DoorService`: `walkInSale`, `dineInSale`, `getLiveStats`
78: - `cover-wallet/cover-wallet-service.ts` — `CoverWalletService`: `issueWallet`, `debit`, `credit`, `terminate`, `reconcile`
79: 
80: #### 5A.4 Unit Tests (TDD)
80: - `scan-ledger.test.ts` — FSM transitions, `processEntryScan` idempotency, Magic Ticket QR verification (±65s clock drift)
81: - `event-code.test.ts` — session token generation/validation, permission scoping by type
82: - `cover-wallet.test.ts` — debit/credit atomicity, velocity limits, termination logic, nightlife termination time
82: - `door-sale.test.ts` — server-side price recalculation, synthetic order creation, idempotency
83: 
83: ### Phase 5B: Infrastructure Adapters (Week 2-3)
84: 
85: #### 5B.1 Memory Adapters
85: - `packages/core/src/infrastructure/memory/memory-scan-ledger-repository.ts`
85: - `packages/core/src/infrastructure/memory/memory-event-code-repository.ts`
85: - `packages/core/src/infrastructure/memory/memory-door-sale-repository.ts`
85: - `packages/core/src/infrastructure/memory/memory-cover-wallet-repository.ts`
86: - `packages/core/src/infrastructure/memory/memory-cover-wallet-reconciliation-repository.ts`
86: - Contract suite tests against memory adapters (same pattern as Phase 4)
87: 
88: #### 5B.2 Firestore Adapters
88: - `packages/core/src/infrastructure/firestore/firestore-scan-ledger-repository.ts`
88: - `packages/core/src/infrastructure/firestore/firestore-event-code-repository.ts`
88: - `packages/core/src/infrastructure/firestore/firestore-door-sale-repository.ts`
88: - `packages/core/src/infrastructure/firestore/firestore-cover-wallet-repository.ts`
88: - `packages/core/src/infrastructure/firestore/firestore-cover-wallet-reconciliation-repository.ts`
88: - Use compare-and-set transactions (D-015) for all writes
89: - Denormalized indexes: `scan_ledger` by `eventId+entitlementId`, `scanner_sessions` by `eventCode`, `cover_wallets` by `entitlementId`
89: 
90: #### 5B.3 Integration Tests
90: - Contract suite against Firestore adapters (same suite, swapped dependency)
90: - Integration tests for `processEntryScan` dual-path idempotency
90: - WebSocket live stats integration test
91: 
92: ### Phase 5C: HTTP Routes + WebSocket (Week 3-4)
93: 
94: #### 5C.1 API Routes (activate from BLOCKED in manifest)
94: **Scanner Routes** (`SCANNER` auth, `SCANNER_COMMAND` rate limit):
95: - `POST /api/v2/door/sessions` — create scanner session (staff login → short-lived signed token)
96: - `GET /api/v2/door/sessions/:sessionId` — get session
96: - `POST /api/v2/door/check-ins` — `processEntryScan` (scan entitlement)
96: - `GET /api/v2/door/check-ins/:checkInId` — get check-in details
96: - `POST /api/v2/door/lookup` — ticket lookup without check-in
96: - `POST /api/v2/door/override` — override (requires `ticket.override` permission)
96: - `GET /api/v2/door/offline-manifest` — download signed offline manifest
96: - `POST /api/v2/door/offline-sync` — sync offline scans
97: 
98: **Door Routes** (`PARTNER` auth, `STANDARD_COMMAND` rate limit):
98: - `POST /api/v2/door/walk-in` — walk-in sale (server-side price recalculation)
98: - `POST /api/v2/door/dine-in` — dine-in sale
98: - `GET /api/v2/door/sales` — list door sales
98: - `GET /api/v2/door/stats` — live stats (WebSocket upgrade or polling fallback)
99: 
99: **Cover Wallet Routes** (`PARTNER` auth, `STANDARD_COMMAND` rate limit):
99: - `POST /api/v2/cover-wallets` — issue wallet (on cover-charge ticket purchase)
99: - `POST /api/v2/cover-wallets/:walletId/debit` — debit (velocity limit, terminated check)
99: - `POST /api/v2/cover-wallets/:walletId/credit` — credit (refund)
99: - `GET /api/v2/cover-wallets/:walletId` — get wallet state
99: - `POST /api/v2/cover-wallets/:walletId/reconcile` — reconciliation
99: 
100: #### 5C.2 WebSocket Live Stats
100: - `GET /api/v2/door/stats/ws` — WebSocket upgrade for live scanner stats
100: - Message format: `{ totalEntered, checkedIn, doorEntries, doorRevenue, walkIns, entryTypeCounts }`
100: - Push on every `processEntryScan` and `walkInSale`/`dineInSale`
100: - Connection scoped to `eventId` + `scannerSession` or `organizationId`
101: 
101: #### 5C.3 Magic Ticket QR (rotating)
101: - `GET /api/v2/tickets/:ticketId/qr` — returns rotating QR payload
101: - Payload: `HMAC(entitlementId : floor(unixTime/30))` for tickets ≥ ₹5000
101: - Verify checks current + previous 30s window (±65s clock-drift tolerance)
101: - Static QR for tickets < ₹5000
101: 
102: #### 5C.4 Rate Limits & Cache
102: - Rate limit classes: `SCANNER_COMMAND` (300/min), `DOOR_COMMAND` (60/min), `COVER_WALLET_COMMAND` (30/min)
103: - Cache classes: `SCANNER_SESSION` (TTL = session TTL), `LIVE_STATS` (5s), `COVER_WALLET` (NO_STORE)
102: 
103: #### 5C.5 Contracts
103: - Add to `packages/contracts/src/client.ts`: schemas for all new DTOs
103: - Add to `packages/contracts/src/index.ts`: error codes `SCANNER_SESSION_EXPIRED`, `VELOCITY_LIMIT_EXCEEDED`, `WALLET_TERMINATED`, `OFFLINE_MANIFEST_EXPIRED`
104: 
105: ### Phase 5D: Integration & Verification (Week 4)
106: 
107: #### 5D.1 Service Wiring
107: - Add `ScannerService`, `DoorService`, `CoverWalletService` to `ServiceDeps`
107: - Add repositories to `ServiceDeps['repositories']`
107: - Update `PartnerV2Services` with `scanner`, `door`, `coverWallet` services
107: - Add repositories to memory + Firestore adapter sets in `v2-services.ts`
107: - Add rate limit classes, cache classes to gateway config
108: 
109: #### 5D.2 Contract Parity
109: - Add new schemas to `packages/contracts/src/client.ts`
109: - Run `scripts/contract-parity.mjs` — must pass 33+ checks
109: 
110: #### 5D.3 End-to-End Integration Tests
110: - Scanner session creation → scan valid ticket → check-in recorded → live stats update
110: - Scanner session creation → scan expired ticket → DENIED → scan ledger written
110: - Scanner session creation → scan already consumed ticket → DENIED
110: - Scanner session creation → Magic Ticket QR verification (±65s drift)
110: - Walk-in sale → server-side price recalculation → synthetic order → door sale recorded
110: - Cover wallet issue → debit (velocity limit) → credit → terminate → reconciliation
110: - Offline manifest download → offline scan → sync → dedup
110: - Live stats WebSocket push on scan/sale
110: - Cover wallet termination at nightlife cutoff time
111: 
112: #### 5D.4 Verification Gates
112: - `pnpm check` (format → lint → typecheck → boundaries → test → build) — **ALL GREEN**
112: - `pnpm test` — all new unit + integration tests pass
112: - `scripts/contract-parity.mjs` — 33+ checks pass
112: - `pnpm boundaries` — no architecture violations
112: - `pnpm build` — successful build
112: 
113: ### Security Checklist (Non-negotiable)
114: - [ ] Scanner session auth: short-lived signed token from staff login, NOT trust body fields (D-022 pattern)
114: - [ ] Door entry price: ALWAYS recalculated server-side from event catalog
114: - [ ] Cover wallet: velocity limit (3 debits/min/device) enforced at API layer
114: - [ ] Cover wallet: terminated wallets reject all mutations
114: - [ ] Offline debits: blocked at API layer
114: - [ ] Magic Ticket QR: HMAC verification ±65s clock-drift tolerance
114: - [ ] Price recalculation: server-side only, never trust client
114: - [ ] Idempotency keys: required on all mutations
114: - [ ] WebSocket: connection scoped to event+session or org, not global
115: 
116: ### Session Log
117: 
118: (to be appended during execution)
