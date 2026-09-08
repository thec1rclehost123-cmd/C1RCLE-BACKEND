# Phase 5 — Door / Scanner / Cover-wallet

**Status:** done (verified 2026-09-07) — 2 honest, by-design 501s remain (stats/ws needs `@fastify/websocket`; scanner manifest-signing has no signing service). Domain-model unit test files landed in `3f48069`. · **Depends on:** Phase 4 (entitlements must exist)

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

## Execution plan

Superseded by `docs/PHASE_5_HTTP_WIRING_PLAN.md` — that doc is the current,
accurate breakdown of what shipped and what remains. (An older pre-implementation
"Execution Plan (Agent-driven)" section lived here inline; it had been duplicated
into the file as a line-number-prefixed paste and was removed 2026-09-01.)

## Session Log

### 2026-08-21 — HTTP wiring session

Prior state at session start: domain models / ports / services / memory +
Firestore adapters / contracts all existed and were wired into `v2-services.ts`,
but every route in `phase5-routes.ts` returned `501` regardless (confirmed by
reading the file directly — this contradicted an uncommitted `ROADMAP.md` edit
claiming "done … 29/29 contract tests pass", which was never actually true until
this session).

What changed: split the routes into `door/scanner-routes.ts` (sessions,
check-ins, verify, lookup, offline-sync, magic QR — override and offline-manifest
stay honest 501s, see below), `door/door-sale-routes.ts` (walk-in/dine-in/sales,
server-side price recalc confirmed against `door-service.ts`),
`door/cover-wallet-routes.ts` (issue/get/debit/credit/terminate/reconcile —
freeze/unfreeze stay 501, no service method exists). `phase5-routes.ts` now holds
only the two genuinely-deferred routes (`/door/stats`, `/door/stats/ws` — no
`@fastify/websocket` registered, no aggregation design).

Also fixed, all pre-existing and blocking (found while getting this to actually
run, not introduced by the routing work): `packages/core`'s
`infrastructure/utils.ts` didn't compile; `buildActorContext` had no
memory-driver fabrication path, 401/500-ing ~95 of 122 gateway tests;
`contract-suite.test.ts` imported `MemoryCoverWalletReconciliationRepository`
from the wrong file (the test had never actually run — "29/29" was aspirational);
reconciliation ids embedded a full eventId and blew the 64-char id cap;
`runReconciliation` double-counted the opening balance.

Verified: `pnpm --filter @c1rcle/core build` clean, gateway typecheck clean,
`pnpm --filter api-gateway exec vitest run` → 122/122. Core was reported here as
231/232 with `compare-and-set.test.ts` failing — **that measurement was on the
uncommitted tree; see the 2026-09-01 entry, it is now 232/232.**

Still open, by design (see `docs/PHASE_5_HTTP_WIRING_PLAN.md`): live door stats
+ WebSocket, `/door/override` (FSM has no `denied → overridden` transition),
`/door/offline-manifest` (nothing signs one), cover-wallet freeze/unfreeze (no
service method), a real scanner-device bearer-token auth layer (routes currently
authenticate via cookie session like every other v2 route). Also unresolved,
found but out of scope here: `ScannerSession.organizationId` is set to the
creating actor's id, not the real org (worked around at the route layer);
`scanTicket`/`scanMagicTicket` read the client's `deviceId` field as a
session-token lookup key, not a hardware id.

### 2026-09-07 — Phase 5 completion: override, stats, freeze/unfreeze, domain tests

Committed `0342d80` (door override), `53727c8` (door stats read model),
`2ec1e61` (cover-wallet freeze/unfreeze), `3f48069` (5 domain-model unit test
files: `scan-ledger.test.ts`, `event-code.test.ts`, `door-sale.test.ts`,
`cover-wallet.test.ts`, `cover-wallet-reconciliation.test.ts`).

Phase 5 now has 2 honest 501s by design:
1. `GET /door/stats/ws` — needs `@fastify/websocket` registered on the app
2. Scanner QR manifest-signing (`scanner-routes.ts:422`) — no signing service
   exists; correctly documented at the call site

### 2026-09-01 — doc reconciliation

- The "core 231/232, 1 known failure = `compare-and-set.test.ts`" claim is
  **stale**. `pnpm --filter @c1rcle/core test` is **232/232** and has been green
  since the recovery commit `7e2d6c9`. The 231/232 was measured on the
  uncommitted pre-recovery tree, never on a commit.
- Removed the duplicated line-number-prefixed paste of an older version of this
  file (the whole "Execution Plan (Agent-driven)" + "Security Checklist" block
  with `NN:` prefixes and a second `**Status:** not started` line).
- **Still to do for Phase 5 (as of 2026-09-01):** the 6 honest 501s (Founder
  Tasks A2 + B1 + B2), and **5 domain-model unit test files**. **All completed
  as of 2026-09-07** — see session log entry above. Only 2 honest 501s remain
  (stats/ws, scanner manifest-signing).
