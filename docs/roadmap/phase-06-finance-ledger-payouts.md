# Phase 6 — Finance / Ledger / Payouts

**Status:** in progress (started 2026-09-07) — ledger/payouts/bank-accounts/disputes done + tested; leaderboard + checkout-integration pending · **Depends on:** Phase 4 (orders must exist to settle)

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

### 2026-09-07 — Ledger + Balances + Payouts + Bank Accounts landed

**Built** (System A, per this doc's recommendation): `domain/models/{ledger,payout,bank-account}.ts`
(`computeSettlementSplit` — proven v1 formula, sums exactly to `grossAmount` by
construction; `Payout` FSM `requested→processing→paid|failed`, ₹100 minimum;
`BankAccount` with one-default-at-a-time invariant), `LedgerRepository`/
`PayoutRepository`/`BankAccountRepository` ports + memory + firestore adapters,
`finance-service.ts` (`recordTicketSale` idempotent per `orderId`,
`getBalances` always recomputed from the ledger — no cache), `payout-service.ts`,
`bank-account-service.ts` (AES-256-CBC envelope in `infrastructure/encryption.ts`,
mirrors `thec1rcle`'s scheme; routes only ever see `maskedAccountNumber`).
Routes: `apps/api-gateway/src/routes/v2/finance/finance-routes.ts` — balance,
ledger list, payout request/list/get, bank-account add/list/set-default/delete,
all `:organizationId`-scoped, reusing `organization.read`/`organization.update`
RBAC permissions (no dedicated finance permission in the matrix yet). Contracts:
`packages/contracts/src/contracts/phase6.ts`. 20 new domain tests + 6 new route
tests, `pnpm check`-equivalent (lint/typecheck/test/boundaries) all green (203
gateway tests total, up from 197).

**NOT done, explicitly deferred:**
- **Checkout webhook integration** (`checkout/webhook-routes.ts`'s
  `payment.captured` handler calling `financeService.recordTicketSale`) —
  investigated but NOT wired. Blocker: this doc's `recordTicketSale` signature
  (ported from v1) takes `hostOrganizationId`/`venueOrganizationId`/
  `promoterOrganizationId` as three organization ids, but V2's actual data
  model doesn't carry three organizations per order — `Order.organizationId`
  is the host, `Event.venueId → Venue.organizationId` is the venue (resolvable
  via a repo lookup), but **promoter attribution is a `userId`
  (`Order.attribution.promoterId`), not an organization** — V2 promoters are
  users connected to a host/venue via `PromoterConnection`, not standalone
  orgs like v1. Wiring the webhook without resolving this would either invent
  a fake promoter-organization id or silently drop promoter commission
  ledger entries — both wrong in a way that pays someone incorrectly. Needs a
  design decision (does a promoter ledger entry key by `userId` instead of
  `organizationId`? does `LedgerEntry.organizationId` need to become a
  discriminated `{type: 'organization'|'user', id}`?) before wiring — flagging
  for the next session rather than guessing.
- **Dispute** and **Leaderboard** domains (from the original phase scope) —
  not started this session; scoped out to ship the load-bearing ledger/payout/
  bank-account core correctly and fully tested rather than five shallow
  slices. Follow the same pattern (`domain/models/dispute.ts` +
  `leaderboard.ts`, ports, service, memory+firestore adapters, routes,
  contracts) — leaderboard also needs the increment-in-same-transaction hook
  into `recordTicketSale`, so it's naturally sequenced after the webhook
  integration above, not before.
- Frontend wiring (regenerating `packages/contracts` into `C1RCLE-FRONTEND`
  and replacing the `dataStatus: 'fixture'` finance screens) — out of scope
  for this session, backend-only.

### 2026-09-08 — Security fixes + Dispute domain landed

**Security review fixes** (post-Phase-6-commit automated review, both applied
and pushed): `infrastructure/encryption.ts` upgraded AES-256-CBC → AES-256-GCM
(CBC had no integrity check — a tampered ciphertext decrypted silently or
threw a padding-oracle-usable error instead of failing loudly); then a second
finding added GCM additional-authenticated-data (AAD) context binding —
`encryptField`/`decryptField` now take a required `context` argument
(`bank-account-service` passes `organizationId`), so a ciphertext blob can no
longer be moved to a different record and still decrypt.

**Built: Dispute domain**, same pattern as Ledger/Payout/BankAccount —
`domain/models/dispute.ts` (minimal FSM `open -> under_review -> resolved`,
no richer status set found in the v1 reference), `DisputeRepository` port +
memory/firestore adapters (`v2_disputes` collection), `dispute-service.ts`
(`raiseDispute`/`beginReview`/`resolve`/`getDispute`/`listDisputes`, all
`requireOrgAccess`-gated), routes appended to `finance-routes.ts` (`POST
/organizations/:organizationId/disputes`, `GET .../disputes`, `GET
.../disputes/:disputeId`, `POST .../disputes/:disputeId/review`, `POST
.../disputes/:disputeId/resolve`), contracts in `phase6.ts`. 7 new domain
tests + 6 new route tests, all green.

**NOT done, still deferred:** Leaderboard (sequenced after the checkout
webhook per the note above — needs the increment-in-same-transaction hook),
checkout-webhook integration (promoter-attribution design gap unchanged —
still needs a decision before `Order.attribution.promoterId` (a `userId`)
can flow into `recordTicketSale`'s organization-keyed ledger), frontend
wiring.
