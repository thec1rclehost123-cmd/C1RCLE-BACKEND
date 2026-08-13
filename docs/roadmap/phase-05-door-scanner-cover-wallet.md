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

## Session Log

(none yet)
