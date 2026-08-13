# Phase 6 — Finance / Ledger / Payouts

**Status:** not started · **Depends on:** Phase 4 (orders must exist to settle)

v1 has **two coexisting systems** — pick one, do not port both.

## Recommended: port System A (`finance-service.ts`, `partner_ledger`)

- `recordTicketSale(eventId, orderId, grossAmount, {venueId, hostId,
  promoterId?, platformFeeRate, venueShareRate, promoterCommissionRate?})` —
  the only writer, called from checkout confirmation, one transaction,
  idempotent via `partner_ledger_idempotency/{orderId}`:
  ```
  platformFee        = round(gross * platformFeeRate)
  venueShare          = round(gross * venueShareRate)
  promoterCommission  = promoterId ? round(gross * promoterCommissionRate) : 0
  hostPayout          = gross - platformFee - venueShare - promoterCommission
  ```
  Rates are parameterized per-venue from the onboarding plan tier
  (`basic→15%, silver→12%, diamond→10%` platform fee — see Phase 2), not
  hardcoded — this is why System A is recommended over System B.
- **Balances always computed from the ledger, never cached as truth**:
  `getBalances()` reads a denormalized `partner_finance_aggregates/{partnerId}`
  doc (maintained via increment on every ledger write, with a short
  read-through cache); rebuilt by full scan if the aggregate doc is missing.
  Port this "no cache-ledger drift" design directly.
- Also increments promoter leaderboard stats
  (`leaderboard_stats/{promoterId}_{periodType}_{periodValue}_{city}`,
  buckets all_time/month/week × global/city) in the same transaction.

## System B (`ledger-engine.js`, hardcoded 5%/30-70 split) — reference only

Double-entry state machine `AUTHORIZED→CAPTURED→HELD→SETTLED→PAYABLE→PAID_OUT`
(+ `REFUND_PENDING→REFUNDED`, `EXPIRED`, `VOID`) is a genuinely good pattern
worth studying even if not ported wholesale — `settleEvent()`'s T+3-day
eligibility gate (`lifecycle==='completed' AND updatedAt<=now-3days AND
settlementStatus==='pending'`) is a real business rule to keep regardless of
which split formula wins.

## Other pieces to port

- Minimum promoter payout ₹100 (`requestPromoterPayout` validation).
- Bank accounts: `last4` only stored plaintext, full number encrypted
  (check `thec1rcle/apps/api-gateway/src/lib/encryption.ts` for the scheme
  before reimplementing); one `isDefault` at a time.
- Refunds: **confirm current `thec1rcle` code actually calls Razorpay's
  refund API** before porting — `PAYMENT_TICKET_CODE_REVIEW.md` documents an
  earlier revision that only marked orders "refunded" in Firestore without
  calling Razorpay; the version read during this session's research does
  call it (idempotent claim via a `status:'settling'` transactional lock),
  but re-verify at implementation time rather than trusting this note.

## Firestore collections

`v2_partner_ledger`, `v2_partner_ledger_idempotency`,
`v2_partner_finance_aggregates` (+ `daily` subcollection), `v2_payouts`,
`v2_bank_accounts`, `v2_disputes`, `v2_leaderboard_stats`.

## Session Log

(none yet)
