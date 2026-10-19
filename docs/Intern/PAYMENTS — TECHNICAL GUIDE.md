# THEC1RCLE Payments: Technical Guide

**Baseline:** Items marked (to be decided) are pending. Rates, windows and names are config values. Companion: _Payments: Business Rules_. 

## 1. Architecture and principles

```text
Guest app / dashboards -> (BFF, same origin) -> API gateway v2
   Checkout / Subscription / Refund / Payout services -> FinanceService (ledger) <- computeSettlementLegs()
   Provider ports: PaymentProvider | SubscriptionProvider | PayoutProvider -> Razorpay
   Razorpay webhooks -> raw-body verify -> event log (inbox) -> queue -> handlers
   State change + event -> outbox -> relay -> event bus -> consumers (ledger, risk, notify, analytics)
   Risk service | Recovery engine + DLQ | Reconciliation + exceptions | Provider router + health | Ops console
```

1. Server owns every number (integer paise; rates in basis points). 2. Money movement (provider) and accounting (ledger) are separate; the ledger is the source of truth. 3. Every step is idempotent and resumable. 4. Webhook is truth, browser callback is convenience. 5. Providers sit behind ports (memory/test drivers; future rails such as Route). 6. The ledger is **double-entry**: every posting balances and entries are immutable (3.1). 7. Every money object has an **explicit state machine**; illegal transitions are rejected (15). 8. A state change and its event are written in one transaction (outbox) and consumers deduplicate (inbox) (16). 9. Every request carries a **correlation id** end to end (24). 10. Nothing fails silently: retry, then dead-letter queue, then a human (17).

## 2. Ticket payment flow

| Step     | Endpoint                                    | Rules                                                                                                                 |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Quote    | `POST /checkout/quote`                      | Full breakdown; UI renders it as is                                                                                   |
| Hold     | `POST /checkout/holds` (Idempotency-Key)    | Stores frozen pricing, `commissionRateBps` (from the venue's plan), event split snapshot, referral attribution, **attendee name/email/phone** |
| Attempt  | `POST /payments/attempts` (Idempotency-Key) | Creates Razorpay order; **persist `providerOrderId` on the hold** (compare-and-set)                                   |
| Checkout | Browser `checkout.js`                       | Opened from a click; `timeout` matches hold TTL; button disabled after click                                          |
| Verify   | `POST /payments/:id/verify`                 | Callback signature check, then `confirmPayment`                                                                       |
| Webhook  | `POST /webhooks/payments/razorpay`          | `payment.captured` calls the same `confirmPayment`                                                                    |

**Required corrections (from audit):**

1. Callback signature = HMAC-SHA256 of `razorpayOrderId|razorpayPaymentId` with the **API key secret**; equal-length check, then `timingSafeEqual`.
2. `confirmPayment` verifies: captured, exact amount and currency, **provider order id equals the one on the hold**, and `actor.userId === hold.userId` on the verify path.
3. Fulfilment steps recorded and resumable (Section 5).
4. Startup fails if `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET` are missing outside memory mode; enable the readiness credential check.
5. Captured-after-expiry: build the order from the frozen hold if inventory remains, else auto-refund and alert; daily job lists captured payments without orders.
6. Fix the missing `createFollowerFanOutConsumer` import first (route tests blocked).
7. Provider calls get timeouts, bounded retries and transient/permanent error classification.

**Pre-checkout validation:** reject if the event is cancelled, ended or unpublished; host or venue beneficiary not `verified`; hold expired or not the caller's; split config missing or invalid; or paid checkout disabled by flag.

## 3. Settlement engine and ledger

One pure, unit-tested function writes its result once onto the order:

```text
input: grandTotal, subtotal, customerFees, gst, commissionBps (snapshot), split{model, venueBps, hosts[shareBps]}, promoter?
commission = round(subtotal * commissionBps / 10000)  # venue's plan rate, snapshotted; plan-based commission comes later, 0 until then
promoter = min(promoterAmount, subtotal - commission)  # paid first, out of ticket revenue, never from fees
distributable = subtotal - commission - promoter
venue = round(distributable * venueBps / 10000)        # base: after promoter and platform commission
hostTotal = distributable - venue                      # absorbs the rounding paisa
hostNet = hostTotal, split across hosts by shareBps (remainder paisa to first host)
platform customer fee = customerFees + gst             # (to be decided: revenue vs cost recovery)
```

**Plan-based commission is a later phase.** Until plans carry rates, `commissionBps` is 0 (default plan), so the platform earns only the customer fee and GST on tickets; the engine, snapshot and posting rules already handle a non-zero rate, so enabling it is config only. The business example's "flat 5% commission" is a placeholder for that later rate.

**Invariants:** legs sum to `grandTotal`; no negative leg; promoter never exceeds ticket revenue after commission (`subtotal - commission`), and is shared by venue and host through the smaller distributable; split validated at publish (`venueBps` + host side = 10000; host shares sum to 10000); config **locked after the first paid order** (audited admin override); Razorpay fee and GST on it recorded as a separate platform **expense**, never netted silently.

**Ledger legs:** `customer_fee`, `platform_commission`, `venue_share`, `host_share` (per host), `promoter_commission`. Fields: `orderId`, `eventId`, `beneficiaryId/Type`, `amount` (paise), `currency`, `state`, `releaseAfter`, `payoutId`, `reversalOf`; idempotency key `orderId + leg + beneficiary`. States: `earned` (platform), `held` -> `releasable` -> `payout_requested` -> `paid`; exits `cancelled`, `reversed`, `failed`. Append-only (corrections are reversing entries). Reconciliation invariant: **platform custody balance >= sum of unreleased beneficiary legs**. The full invariant catalogue is in 3.2.

### 3.1 Double-entry journal (the books)

The legs above are the **beneficiary sub-ledger** (what each party is owed and in what state). The **journal** is the double-entry book of record. Every business event posts one `journal_entry` made of two or more `journal_lines`; total debits equal total credits, always.

- `journal_entries`: `entryId`, `postingKey` (unique; idempotency), `eventType`, `sourceType/sourceId` (order, refund, payout, settlement, dispute), `correlationId`, `currency`, `effectiveDate`, `period`, `createdBy` (system or userId), `approvalId?`, `reversalOf?`.
- `journal_lines`: `entryId`, `accountId`, `direction` (debit or credit), `amountPaise` (integer, positive), `beneficiaryId?`, `orderId?`, `eventId?`, `provider?`.
- One posting function is the only writer. It checks the entry balances, then writes entry, lines and the matching sub-ledger leg changes in one transaction. Entries are immutable; a mistake is fixed by a reversing entry that references the original, never an edit.
- Account balances are derived from lines (periodic snapshots plus increments); dashboards never trust stored counters.

**Chart of accounts (starter set)**

| Code | Account | Type |
| ---- | ------- | ---- |
| 1100 | Gateway receivable (captured, not yet settled), per provider | Asset |
| 1110 | Bank: collection account | Asset |
| 1120 | Payouts in transit | Asset |
| 1300 | Recoverable from beneficiaries (refund after payout) | Asset |
| 1400 | GST input credit (on gateway fees) | Asset |
| 1500 | Disputed amounts receivable | Asset |
| 2100 / 2110 / 2120 | Venue payable / Host payable / Promoter payable | Liability |
| 2200 | GST payable | Liability |
| 4100 / 4110 / 4200 | Commission revenue / Convenience fee revenue / Subscription revenue | Revenue |
| 5100 | Gateway fees | Expense |
| 5200 | Chargeback and refund losses | Expense |
| 5300 | Write-offs (maker-checker only) | Expense |

**Posting rules** (₹ shown for readability; stored as paise; figures from the business example: host-owned 80/20, 10% promoter, no platform commission applied in the example, so no 4100 line; where the venue's plan charges commission, 4100 is credited and venue and host shares fall)

| Event | Debit | Credit |
| ----- | ----- | ------ |
| Payment captured (₹1,088.50) | 1100 Gateway receivable 1,088.50 | 2110 Host 720.00; 2100 Venue 180.00; 2120 Promoter 100.00; 4100 Commission (plan rate, 0.00 in this example); 4110 Convenience fee 75.00; 2200 GST 13.50 |
| Settlement received (illustrative 2% fee + 18% GST) | 1110 Bank 1,062.81; 5100 Gateway fees 21.77; 1400 GST input 3.92 | 1100 Gateway receivable 1,088.50 |
| Full refund before payout (ticket price only) | 2110 Host 720; 2100 Venue 180; 2120 Promoter 100; 4100 Commission (if any) | 1100 Gateway receivable 1,000 |
| Event cancelled (fees also refunded) | As above, plus 4110 75.00 and 2200 13.50 | 1100 Gateway receivable (extra 88.50) |
| Payout requested | 2110 / 2100 / 2120 payable | 1120 Payouts in transit |
| Payout paid | 1120 Payouts in transit | 1110 Bank |
| Payout failed or returned by bank | Failed: 2110 payable (reverse the request). Returned after paid: 1110 Bank | Failed: 1120. Returned: 2110 payable; leg back to `releasable` |
| Refund after payout | 1300 Recoverable (host, venue, promoter shares); 4100 Commission | 1100 Gateway receivable |
| Recovery from a later payout | 2110 / 2100 / 2120 payable | 1300 Recoverable |
| Dispute opened | 1500 Disputed receivable | 1100 Gateway receivable |
| Dispute won | 1100 Gateway receivable | 1500 Disputed receivable |
| Dispute lost | Same as a refund, plus 5200 for any chargeback fee | 1500 Disputed receivable |
| Subscription charge (price + GST) | 1100 Gateway receivable | 4200 Subscription revenue; 2200 GST payable |

Posting keys follow the existing idempotency pattern (`orderId + eventType`, `refundId + leg`, `payoutId + stage`). Whether subscription revenue is recognised on charge or over the period (annual plans) is **(to be decided)** with the CA; if over the period, add a deferred-revenue liability account.

### 3.2 Financial invariants (continuous, not just at write time)

| ID | Invariant | Enforced at | Checked |
| -- | --------- | ----------- | ------- |
| I1 | Every journal entry balances | Posting function, in-transaction | Hourly sample, daily full |
| I2 | Trial balance: total debits equal total credits | n/a | Daily, and at period close |
| I3 | Order legs sum to `grandTotal`; no negative leg | Settlement function | On write |
| I4 | Beneficiary payable balance equals sum of that beneficiary's unreleased legs | Posting function | Hourly |
| I5 | Refunds on a payment never exceed the captured amount | Refund executor, in-transaction | On write, daily |
| I6 | Payout never exceeds the beneficiary's releasable balance; one payout per key | Release job | On write |
| I7 | One provider payment maps to at most one order (unique index) | Unique key | On write |
| I8 | A beneficiary balance is negative only through a recorded 1300 recoverable | Posting function | Hourly |
| I9 | Custody: bank (1110) plus gateway receivable (1100) is at least all beneficiary payables | n/a | Hourly |
| I10 | Posted entries, audit records and settled payments are never updated or deleted | Security rules, service-only writes | Daily hash verification |
| I11 | A captured order has its payment entry; a refunded order has its reversal | n/a | Hourly |
| I12 | A closed period receives no new entries | Posting function | On write |

Firestore has no CHECK constraints, so enforcement is the single posting function plus transactions plus a **verifier job**. On a breach: severity critical, page ops, **auto-trip `AUTO_PAYOUTS_ENABLED` and `REFUND_EXECUTOR_ENABLED`** (Section 10 flags), open a reconciliation exception (Section 18), and block period close. Invariant status is a tile on the Ops console (Section 19).

## 4. Fulfilment (recoverable)

Order carries `fulfilmentSteps`: `order_saved, hold_converted, promo_recorded, tickets_issued, ledger_written, referral_recorded, notified`.

1. One Firestore transaction: paid order (id from payment id), hold conversion, promo redemption **only if a promo applied**, entitlements (honour `admitsPerUnit`).
2. Post-commit outbox consumers (outbox and inbox rules in Section 16): ledger legs, referral and leaderboard, QR tickets and email.
3. Repair job (every few minutes, run by the recovery engine in Section 17) runs the first incomplete step of stalled orders. A retry on an existing order **resumes**; it never just returns.

## 5. Subscriptions

**Port:** `createPlan`, `createSubscription({planId, customerRef, totalCount, startAt?, notes})`, `update(id, {planId?, quantity?, applyAt: now|cycle_end})`, `cancel(id, atCycleEnd)`, `pause`, `resume`, `fetch`.

| Endpoint                                     | Purpose                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `GET /plans?audience=` (venue, member)       | Plan catalogue mapped to provider plan ids: venue dashboard monthly/yearly; mobile Premium and VIP monthly/yearly |
| `POST /subscriptions` (Idempotency-Key)      | Create; returns Checkout data                        |
| `POST /subscriptions/:id/verify`             | Callback signature check; state confirmed by webhook |
| `PATCH /subscriptions/:id`                   | Upgrade/downgrade (to be decided: proration)         |
| `POST /subscriptions/:id/cancel`             | Now or at cycle end                                  |
| `GET /subscriptions/me`, `GET /invoices`     | Status, history, invoices                            |

Trial: set `startAt` in the future. **Local states:** `trialing` (authenticated, before first charge), `active`, `past_due` (provider `pending`; grace period; number of days to be decided), `suspended` (provider `halted` after grace; premium off, data kept), `cancelled` (access until paid period ends). Provider rules: after `halted` -> `active`, earlier failed charges are **not** re-attempted; a **cancelled subscription cannot restart** (create new); pause only from `active`. **Webhooks:** `subscription.authenticated, .activated, .charged, .updated, .pending, .halted, .paused, .resumed, .cancelled, .completed`: dedupe by event id, update state, drive entitlements, notifications and invoices. Never activate access from the browser callback. **Entitlements:** `canUse(feature, owner)` and `commissionBps(venueId)` come from the venue's active plan (no plan means the default plan); the rate is copied onto the hold/order at purchase. Plan-to-rate table in config (to be decided). Also to be decided: whether the venue picks its own commission rate (for example by choosing a plan) or only the per-event venue/host split, with the platform commission set by THEC1RCLE (a host-side commission setting may already exist in the product). **Invoices:** one GST invoice per successful charge and per convenience-fee settlement; sequential numbers, GSTIN, SAC, tax breakup, immutable PDF. Razorpay invoices vs in-house (to be decided); in-house numbering stays authoritative.

## 6. Payouts

- **Beneficiary:** `{id, ownerType (venue|organisation|individual), ownerId, kycStatus, providerRef, bankLast4, verifiedAt}`; organiser type individual, company or venue (KYC documents differ). Bank numbers encrypted, masked in logs and responses. Gate: a paid event publishes only if host and venue beneficiaries are `verified`.
- **Port:** `createPayout({beneficiaryRef, amount, idempotencyKey, reference, narration})`, `getPayout`. Rail (to be decided; recommended start: bank transfer or manual, Route later): manual, bank-transfer payouts product, or Route. Confirm availability, KYC and fees with Razorpay; never mark `paid` without provider confirmation or an operator action with evidence.
- **Release job:** (1) event `completed` (organiser close-out or scheduled), then wait `releaseAfter` (config, **0**); (2) select `held` legs excluding refunded, `refund_requested`, disputed, frozen or `riskHold` (Section 22); mark `releasable`; (3) group by beneficiary and event, one payout with key `payout:{eventId}:{beneficiaryId}`, legs -> `payout_requested`; (4) provider webhook or operator confirmation -> `paid` or `failed`; (5) event status `partial` until all paid; failed payouts retry with backoff, then go to the DLQ (Section 17). Admin approve/pause/retry, all audited and subject to maker-checker (Section 20). Payout state follows Section 15.
- **Settings** (per beneficiary, platform defaults): `autoPayout` (on), `minPayoutThresholdPaise` (roll over), `payoutMode` (`per_event` default or `monthly_batch` + `preferredPayoutDay` 1 to 28), `maxHoldDays` (ops alert).
- **Dashboard stats** (earned, paid out, pending, last payout) computed from the ledger, not stored counters.

## 7. Refunds

Reuse the existing approval workflow, then a **refund executor**:

- **Before payout:** `refundPayment(paymentId, amount, idempotencyKey)`; on `refund.processed`: order `refunded` (partial stays `paid` with `refundedAmount`), void entitlements, cancel held legs proportionally, reverse promoter commission, apply fee-refund policy from config (to be decided).
- **After payout:** refund the customer the same way; create **negative-balance recovery entries** against the beneficiaries' future payouts (to be decided); platform funds the gap.
- **Event cancelled:** bulk executor over all paid orders; fees refunded; all legs cancelled.
- **`refund.failed`:** back to `approved`, alert, order stays locked until resolved.
- Idempotent per refund id; ledger reversals keyed `refundId + leg`.

## 8. Webhooks, polling, reconciliation

Single endpoint, raw-body HMAC (webhook secret), respond 200 within seconds, enqueue. Provider events are translated to canonical events (Section 25).

| Event                                | Handler                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `payment.captured`                   | `confirmPayment`                                      |
| `payment.failed`                     | Record failure; hold stays active                     |
| `refund.created`                     | Refund `processing`; customer sees "refund initiated" |
| `refund.processed` / `.failed`       | Refund executor final result                          |
| `payment.dispute.created/.lost/.won` | Freeze legs, alert, reverse on loss                   |
| `subscription.*`                     | Section 5                                             |
| Payout and settlement events         | Payout state, settlement tracking, reconciliation     |

Event log: `eventId, type, payloadHash, receivedAt, processedAt, status, error`. Dedupe on event id; ignore events older than \~5 minutes at ingestion but allow replay from the log; tolerate out-of-order arrival by fetching current provider state. **Polling fallback (every 5 min):** holds with a `providerOrderId` and no order, created or active within the last hour; fetch the Razorpay order's payments, call `confirmPayment` if `captured`; small batches, respect rate limits, log every recovery and alert on repeats. **Daily reconciliation** (full design, bank matching and exception workflow in Section 18): compare Razorpay settlement and payment data with the ledger (captured payments, fees, refunds, settlements). Flag payment without order, order without capture, refund without reversal, payout without reference, subscription charge without invoice; custody check (held funds vs unreleased legs). Reports (gross/net/platform/ticket/subscription revenue, taxes, fees, refunds, payouts, settlements, event and month-wise) come from ledger plus subscription charges; beneficiaries see only their own legs.

## 9. Notifications

Payout released or failed -> venue, host, promoter. KYC incomplete or rejected -> beneficiary. Refund processed or failed -> customer (ops on failure). Commission approved, held or rejected -> promoter. Subscription charge failed, grace ending, suspended -> subscriber. Payout failure, reconciliation mismatch, captured-without-order -> ops and finance (high priority). Approval requested or expiring -> checkers. Risk hold, anomaly alert, DLQ item, invariant breach, provider degraded -> ops, risk and finance (P1 pages for money at risk, Section 24). Sent via the existing notification service, keyed by event id to avoid duplicates.

## 10. Security, rollback, regulatory

- **Security:** secrets in a managed secret store with KMS envelope encryption and a rotation schedule (Section 27); none in client code; raw-body webhook verification with length-checked constant-time compare; idempotency keys on every mutating payment, refund, payout and subscription call; admin-only approvals, holds, releases, split overrides, no self-approval; encrypted, masked bank details; hash-chained append-only audit log for payment, refund, payout and config changes (Section 29); maker-checker on money-out and config changes (Section 20); rate limits; fraud and risk engine and promoter fraud detection (Sections 21, 22); no card data stored.
- **Pre-launch review:** threat review and penetration test of payment, refund, payout and webhook endpoints; secrets audit; admin access review; tests for signature tampering, replay, races, idempotency abuse; check bank data encryption and append-only audit logs.
- **Feature flags:** `PAID_CHECKOUT_ENABLED` (free RSVP and existing orders unaffected), `AUTO_PAYOUTS_ENABLED` (pay manually from the `releasable` report), `REFUND_EXECUTOR_ENABLED` (refund in dashboard, then record `refund_id`), `SUBSCRIPTIONS_ENABLED` (existing continue, webhooks still processed). Rollback never deletes ledger entries or orders and never alters money already moved. Checkout failing: disable flag, investigate, re-enable after a test-mode pass. Payout job misbehaving: disable, freeze events, pay manually, mark legs `paid` with bank reference. Webhooks missing: polling fallback, replay stored events. Refund error: disable, refund manually, record. Invariant breach: payout and refund flags trip automatically (Section 3.2); disaster recovery steps in Section 28.
- **Regulatory check (to be decided):** this design collects all ticket money into THEC1RCLE's own account first. Confirm with a lawyer and Razorpay that this fits RBI payment aggregator rules, or whether Razorpay Route is required; this can change the payout design, so do it before Phase 6.

## 11. Endpoints (new; reuse existing partner-finance endpoints)

| Method | Endpoint                                                       | Purpose                                          |
| ------ | -------------------------------------------------------------- | ------------------------------------------------ |
| GET    | `/banking/status/:ownerType/:ownerId`                          | Beneficiary and KYC status                       |
| POST   | `/banking/accounts`                                            | Submit bank details, create provider beneficiary |
| GET    | `/banking/onboarding-link`                                     | Provider-hosted KYC link if the rail uses one    |
| GET    | `/payouts/me`, `/payouts/order/:orderId`                       | Payout history; per-order status                 |
| GET    | `/admin/payouts?status=`                                       | Pending, processing, failed                      |
| POST   | `/admin/payouts/release/:eventId`                              | Manual release (audited)                         |
| POST   | `/admin/payouts/:id/retry`, `/freeze`, `/unfreeze`, `/approve` | Admin controls (unfreeze, approve via maker-checker) |
| GET    | `/admin/payments/search`, `/admin/payments/:id/timeline`       | Payment 360 view by correlation id               |
| GET/POST | `/admin/exceptions`, `/admin/exceptions/:id/assign`, `/resolve` | Reconciliation exception queue                  |
| GET/POST | `/admin/dlq`, `/admin/dlq/:id/replay`, `/discard`            | Dead letters (bulk replay and discard need a checker) |
| GET/POST | `/admin/approvals`, `/admin/approvals/:id/approve`, `/reject` | Maker-checker inbox                              |
| GET/POST | `/admin/risk/queue`, `/admin/risk/rules`, `/admin/risk/decisions/:id/outcome` | Risk review, rules, feedback      |
| GET    | `/admin/providers/health`, `/admin/invariants`, `/admin/slo`   | Health, invariant and SLO status                 |
| GET/POST | `/admin/periods/:period/close`, `/admin/reports/:id`         | Period close and reports                         |

## 12. Phases, Owners



| Phase | Scope                                                                    | Estimate | Owner              | Done when                                            |
| ----- | ------------------------------------------------------------------------ | -------- | ------------------ | ---------------------------------------------------- |
| 0     | Fix import                                                               | 0.5 d    | Backend            | Route tests run                                      |
| 1     | Signature, order-id binding, credentials                                 | 2 d      | Backend            | Real test payment verifies; forged callback rejected |
| 2     | Recoverable fulfilment, attendee data, captured-after-expiry             | 3 d      | Backend            | Worker killed mid-step still completes order         |
| 3     | Guest BFF, Checkout, server quote, paid UX                               | 5 d      | Frontend + Backend | First paid test purchase in real UI                  |
| 4     | Settlement engine, split config, plan commission snapshot, ledger states | 3 d      | Backend            | Legs sum; plan change leaves old orders unchanged    |
| 5     | Refund executor and webhooks                                             | 3 d      | Backend            | Approved refund returns money and reconciles         |
| 6     | Beneficiary onboarding, publish gate                                     | 4 d      | Backend + Frontend | Unverified org cannot publish paid event             |
| 7     | Event completion, release job, payouts, notifications                    | 4 d      | Backend            | Test event pays once per beneficiary, retry-safe     |
| 8     | Disputes, reconciliation, alerts, reports                                | 4 d      | Backend + Finance  | No unexplained differences                           |
| 9     | Subscriptions (parallel after Phase 1)                                   | 6 d      | Backend + Frontend | Trial, renewal, failure, upgrade, cancel verified    |
| 1B    | State machines, outbox/inbox, correlation IDs, hash-chained audit log, secret store + envelope encryption | 8 d | Backend + Platform | Illegal transitions rejected; crash between commit and publish loses no event; one id traces a payment |
| 1C    | Payment simulator v1 and invariant checker harness                       | 4 d      | Backend            | Phases 2 to 8 are tested against injected failures   |
| 4B    | Double-entry journal, posting rules, invariants I1 to I12, verifier job  | 5 d      | Backend + Finance  | Trial balance is zero; breach trips payout flags     |
| 7B    | Maker-checker, recovery engine + DLQ, Ops console v1                     | 8 d      | Backend + Frontend | Money-out actions need a checker; stuck items surface and replay safely |
| 8B    | Advanced reconciliation (bank matching), exception workflow, SLO dashboards and alerts | 6 d | Backend + Finance | Every difference has an owner and due date          |
| 10    | Fraud and risk engine v1, promoter fraud detection v1, review queue      | 8 d      | Backend + Risk     | Shadow-mode rules logged; flagged commissions held   |
| 11    | Provider health monitoring, circuit breaker, router; second adapter if approved | 6 d (+5 d per adapter) | Backend | Method hidden when provider degrades; contract tests pass on all adapters |
| 12    | Anomaly detection, finance reports, analytics store, period close         | 10 d     | Backend + Finance  | Month closes from the ledger with no manual numbers |
| 13    | Disaster recovery, key rotation drills, chaos suite and game day         | 6 d      | Platform + Backend | Restore drill meets RPO/RTO; leaked-key drill done  |

**Launch gates.** Real money in production only after 1B, 1C, 4B, 7B and the backup and rotation basics of 13. `AUTO_PAYOUTS_ENABLED` only after 8B and 10 v1 are live and the first restore drill has passed.

## 13. Tests and config

**Tests:** callback only, webhook only, both racing; tampered signature, wrong order, amount or user; duplicate and out-of-order webhooks; crash after each fulfilment step; captured after expiry; rounding with promos, multi-host, venue-owned, promoter above the distributable amount (promoter is paid first and shrinks both venue and host shares); plan change after purchase; split locked after first sale; refunds (before and after payout, partial, cancellation, failed, fee variants); payouts (one per beneficiary per event, failure and retry, frozen beneficiary, dispute blocks release); subscriptions (trial to first charge, renewal, failed charge to `halted`, recovery, upgrade/downgrade, cancel at cycle end, new subscription after cancel, invoice per charge); reconciliation catches injected mismatches. **Added:** every allowed and disallowed state transition; outbox crash between commit and publish; duplicate and out-of-order inbox delivery; journal balance and posting rules under random splits (property-based); each invariant I1 to I12 can be broken in a test and is caught; maker-checker (self-approval, changed payload, expired request, replay of an executed request); DLQ replay does not double-apply; recovery engine on every task type; risk rules in shadow and enforced mode, fail-open behaviour; promoter fraud scenarios (self-referral, linked accounts, burst, refund-heavy promoter); anomaly alerts with minimum-volume gate; provider degradation, circuit breaker and failover that does not double-charge; webhook-secret rotation overlap; restore drill followed by invariants and reconciliation; period close lock; correlation id present on every log, event, journal entry and audit record.

**Config:** `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET` (required outside memory driver); `PAYOUT_RELEASE_WINDOW_HOURS=0`; `PLAN_COMMISSION_BPS={basic,pro,premium}` (to be decided); `CUSTOMER_FEE_PLATFORM_BPS=500`, `CUSTOMER_FEE_PAYMENT_BPS=250`, `GST_BPS=1800`; `FEES_REFUNDABLE_ON_REFUND=false` (to be decided); `SUBSCRIPTION_GRACE_DAYS` (number of days to be decided); feature flags from Section 10. **Added:** `APPROVAL_POLICY` (action, thresholds, approver count, roles; to be decided); `APPROVAL_EXPIRY_HOURS=24`; `RISK_SCORE_BANDS`, `PROMOTER_RISK_T1/T2/T3` (to be decided); `RECOVERY_BACKOFF=[1m,5m,15m,1h,6h]` and per-type max attempts; `RECON_TOLERANCE_PAISE`, `SETTLEMENT_EXPECTED_DAYS=2`; `EXCEPTION_SLA_HOURS` by severity (to be decided); `PROVIDER_DEFAULT=razorpay`, `PROVIDER_ROUTING_RULES`, `BREAKER_FAILURE_RATE`, `BREAKER_MIN_VOLUME`; `SECRET_ROTATION_DAYS=90`; `RPO_MINUTES`, `RTO_HOURS` (to be decided); `AUDIT_RETENTION_YEARS` (to be decided with the CA); `PERIOD_CLOSE_DAY`; `SLO_*` targets from Section 24.

## 14. Additions

**Payment methods.** Standard Checkout shows the methods enabled on the Razorpay account: UPI, cards, net banking, wallets. EMI (optional) and international cards (later) need activation by Razorpay (to be decided). Store the method used on each payment (from the fetched payment) for history and reports.

**Financial record per ticket payment** (on the order and its ledger entries): `eventId, venueId, hostId(s), promoterId?, ticketType, quantity, discountType, discountAmount, couponCode, platformFee, customerFee, gst, paymentStatus, paymentId (transaction ID), paymentMethod`.

**Settlement record per payment** (collection `settlement_records`, fed by settlement events and the daily Razorpay report): `paymentId, settlementStatus, settlementId, settlementDate, payoutStatus, bankTransferStatus, failures[]` (failed settlement log). Shown in admin and used by reconciliation.

**Discount types.** Pricing engine supports `promo_code` and `referral` discounts (a customer discount tied to a promoter's code or link, separate from the promoter's commission); each stores `discountType`, `discountSource`, `couponCode`. A promo code or referral link tied to a promoter also sets promoter attribution. All reduce the subtotal before fees. (to be decided) Whether the platform or host side absorbs discounts instead of the current proportional effect.

**Live dashboard updates.** Webhook handlers update scoped Firestore documents (order, payment, payout, settlement, subscription). Dashboards subscribe to their own scoped documents (Firestore listeners, or short polling or server-sent events through the BFF) so changes appear within seconds. Clients never write payment state; until the server confirms, the UI shows `processing`.

**Dashboard fields** (read from ledger and settlement records, scoped by owner): Venue: total ticket revenue, net earnings, pending and completed payouts, settlement history. Host: ticket revenue, revenue share, event earnings, pending settlements, payment history. Promoter: tickets sold, revenue generated, commission earned, pending and completed payouts, history. All: total earned, paid out, pending, last payout date.

**Service fees.** The brief's "service fees (if applicable)" is undefined (to be decided). Reserve a ledger leg type `service_fee` but build nothing until it is defined or dropped.

**App store billing for mobile memberships (to be decided).** If Apple or Google require in-app purchase for digital memberships, entitlements must also accept store purchases. Add `source: razorpay | app_store | play_store` to subscription records and let `canUse(feature, owner)` read any active source; keep store-billed revenue and invoices separate from Razorpay revenue. Verify the current store policy and any India-specific rules before building mobile memberships.

## 15. Explicit state machines

Every money object has one state machine. A single `transition(entity, event, actor)` function is the **only** writer of `status`. It checks the transition table, writes the new state, appends to `stateHistory` (`from, to, at, causeEventId, actor, correlationId`), and emits an outbox event (Section 16) in the same transaction. An illegal transition is rejected, logged as `illegal_transition` and counted as a metric. An event that arrives out of order for a terminal state is recorded and ignored, and the handler fetches current provider state (Section 8).

| Machine | States | Allowed transitions |
| ------- | ------ | ------------------- |
| **Hold** | `active, payment_pending, converted, expired, released` | active to payment_pending (attempt created); payment_pending to converted (confirmed) or active (attempt failed); active or payment_pending to expired (TTL); active to released (user leaves). `converted` is terminal. |
| **Payment** | `created, attempted, authorized, captured, failed, partially_refunded, refunded, disputed, charged_back` | created to attempted; attempted to authorized, captured or failed; authorized to captured or failed; captured to partially_refunded, refunded or disputed; partially_refunded to refunded or disputed; disputed to captured (won) or charged_back (lost). `failed`, `refunded`, `charged_back` are terminal. A failed event after `captured` is ignored and flagged. |
| **Order** | `paid, fulfilling, fulfilled, cancelled` plus `refundedAmount`, `disputed` flag | paid to fulfilling to fulfilled (steps in Section 4); paid or fulfilled to cancelled (event cancelled, full refund). A partial refund keeps the order `paid` with `refundedAmount`, as in Section 7; the payment record carries `partially_refunded`. |
| **Refund** | `requested, approved, rejected, processing, settled, failed, manual` | requested to approved or rejected; approved to processing; processing to settled or failed; failed to approved (retry) or manual (operator refunds in the provider dashboard and records `refund_id` with evidence). `settled`, `rejected` are terminal. |
| **Payout** | `scheduled, pending_approval, approved, processing, paid, failed, returned, frozen, cancelled` | scheduled to pending_approval (above threshold) or approved; pending_approval to approved or cancelled; approved to processing; processing to paid or failed; failed to approved (retry) or escalated to the DLQ; paid to returned (bank returned the money); any pre-`processing` state to frozen and back (unfreeze needs a checker, Section 20). |
| **Ledger leg** | As Section 3 | earned, held, releasable, payout_requested, paid; exits cancelled, reversed, failed. |
| **Subscription** | As Section 5 | trialing, active, past_due, suspended, cancelled. |

Rules: a payout can move to `processing` only if its legs are `payout_requested` and invariants I4 and I6 hold; a refund can move to `processing` only if I5 holds; no state is ever deleted or rewritten. Transition tables live in code as data and are covered by a test that walks every allowed and every disallowed pair.

## 16. Event architecture: outbox, inbox, event catalog

**Outbox.** The state change and its event are written in **one transaction**. Collection `outbox`: `eventId, aggregateType, aggregateId, seq` (per-aggregate sequence), `type, version, payload, correlationId, causationId, createdAt, status` (pending, published, failed), `attempts, publishedAt`. A relay worker reads pending events in `seq` order per aggregate, publishes to the queue, then marks them published (at-least-once delivery). Failures back off and are retried; an event older than a few minutes alerts. This replaces the informal "post-commit outbox consumers" in Section 4.

**Inbox.** Collection `inbox`: `consumer, eventId, receivedAt, processedAt, status, error`, unique on `(consumer, eventId)`. A handler records its inbox row inside the same transaction as its own effect, so a duplicate delivery changes nothing (exactly-once effect). The provider **webhook event log** in Section 8 is the provider inbox; internal consumers (ledger posting, referral and leaderboard, QR tickets, notifications, analytics) each get their own inbox.

**Event catalog (past-tense facts, versioned).**

| Domain | Events |
| ------ | ------ |
| Payment and order | `PaymentCaptured, PaymentFailed, OrderPaid, TicketsIssued, OrderCancelled` |
| Refund | `RefundRequested, RefundApproved, RefundSettled, RefundFailed` |
| Payout | `PayoutScheduled, PayoutApproved, PayoutPaid, PayoutFailed, PayoutReturned` |
| Ledger | `JournalPosted, LegsHeld, LegsReleasable, LegReversed` |
| Dispute | `DisputeOpened, DisputeWon, DisputeLost` |
| Subscription | `SubscriptionCharged, SubscriptionHalted, SubscriptionCancelled` |
| Control | `RiskDecisionMade, ApprovalRequested, ApprovalDecided, ExceptionOpened, InvariantBreached, ProviderHealthChanged, AnomalyDetected` |

Envelope: `eventId, type, version, occurredAt, aggregateId, seq, correlationId, causationId, actor, payload`. Payloads carry ids and amounts, **never** bank numbers or personal data. Schema changes are additive within a version; a breaking change gets a new version and both run until consumers move. Consumers must be idempotent, tolerate duplicates and out-of-order arrival (use `seq`), and never call back into the producer synchronously.

## 17. Recovery engine and dead-letter queue

The repair job, polling fallback and payout retry become one engine with one policy. Collection `recovery_tasks`: `taskId, type, subjectId, attempts, nextRunAt, lastError, errorClass` (transient or permanent), `status`.

| Task type | Trigger | Action |
| --------- | ------- | ------ |
| Stalled fulfilment | Order step incomplete for more than a few minutes | Run next step (Section 4) |
| Captured without order | Provider shows captured, no order | `confirmPayment`, else auto-refund and alert |
| Payment stuck | Attempt `attempted` or `authorized` past threshold | Fetch provider state, transition |
| Refund or payout stuck in `processing` | Past threshold | Fetch provider state, transition |
| Missing webhook | Expected event not seen | Poll provider, replay from event log |
| Outbox stuck | Pending event past threshold | Re-publish |
| Subscription drift | Local state differs from provider | Fetch and align |
| Journal imbalance or custody breach | Invariant I1, I2, I9 | **No auto-fix.** Escalate to DLQ at critical priority |

**Retry policy:** exponential backoff with jitter (default 1 min, 5 min, 15 min, 1 h, 6 h), a per-type maximum, and every attempt reuses the original idempotency key. Permanent errors (validation, closed account, KYC failure) skip retries and go straight to the DLQ.

**DLQ.** Collection `dead_letters`: `source` (queue, outbox, recovery, inbox), `ref`, `type`, `error`, `attempts`, `firstFailedAt`, `owner`, `status` (open, investigating, replayed, resolved, discarded), `resolutionNote`. Rules: any DLQ item touching money is **P1**; items are never auto-discarded; discarding needs a reason plus a checker; single replay by ops, **bulk replay needs a checker** (Section 20); replay always goes through the normal handler so inbox deduplication protects against double effects. Metrics: DLQ depth, age of oldest item, replay success rate.

## 18. Advanced reconciliation and exception management

**What is compared** (extends the daily job in Section 8):

| Check | Left | Right |
| ----- | ---- | ----- |
| R1 Gateway | Provider payments, refunds, fees | Journal account 1100 and payment records |
| R2 Settlement | Provider settlement report | Bank statement credits (UTR) |
| R3 Payouts | Payout records | Payout provider and bank debits (UTR) |
| R4 Books | Journal payables | Sub-ledger legs and custody (I4, I9) |
| R5 Subscriptions | Provider subscription charges | Invoices and journal 4200 |

**Matching.** Keys are `providerPaymentId`, `settlementId`, `utr`. Supported shapes: one-to-one, one settlement to many payments, and many to one. Amounts match exactly; fees match the expected fee table within a configured tolerance. Items inside the expected settlement window (T+2 working days, config) are **in transit**, not exceptions, and age into exceptions after the window. Light checks run hourly (pending versus provider); the full run is daily. Bank statements arrive by file upload or bank API **(to be decided)**.

**Exception record** (`recon_exceptions`): `exceptionId, check, type, severity, subjectRefs, expectedPaise, actualPaise, diffPaise, detectedAt, owner, status` (open, investigating, waiting_provider, resolved, written_off), `resolutionCode, resolutionEntryId, dueAt, notes[], evidence[]`.

Types: `payment_without_order, order_without_capture, amount_mismatch, duplicate_payment, refund_without_reversal, refund_not_at_provider, payout_without_utr, settlement_missing_or_short, fee_mismatch, bank_credit_unmatched, subscription_charge_without_invoice, custody_shortfall, unexplained_difference`.

**Workflow:** auto-resolve known benign cases (timing, rounding within tolerance) with a recorded reason; route the rest by type (Finance, Backend, Ops); target resolution by severity (critical same day, high 1 business day, normal 3, all **to be decided**); every resolution either links evidence or posts an adjusting journal entry, and write-offs above the threshold need a checker; repeat patterns open a problem record for engineering. Reporting: open count, ageing buckets, value at risk, last clean run date. Done when a run completes with zero unexplained differences and every exception has an owner and a due date.

## 19. Payment Operations Console

An internal, role-gated app for support, ops, finance and risk. It calls the same service APIs as everything else; **no console action edits the ledger or a status directly**. Corrections are requests that go through the posting function, state machines and approvals.

| Module | What it does |
| ------ | ------------ |
| Payment 360 | Search by payment, order, refund or payout id, UTR, email, phone, event. One page shows the timeline built from `correlationId`: state history, provider events, webhooks, fulfilment steps, journal entries, risk decisions, approvals, audit records. |
| Exceptions | Queue from Section 18: assign, add notes and evidence, resolve, propose write-off. |
| Recovery and DLQ | Stuck tasks and dead letters: retry, replay, discard with reason (Sections 17, 20). |
| Refunds and payouts | Boards by state; approve, pause, retry, manual release, all through maker-checker. |
| Risk review | Held orders, flagged promoters and hosts, anomaly alerts (Sections 21 to 23); release or reject with notes. |
| Approvals inbox | Pending maker-checker requests with the exact payload to be executed. |
| Health | Invariants (I1 to I12), SLOs, provider health, outbox lag, DLQ depth. |
| Controls | Feature flags and kill switches (changes audited; enabling payouts needs a checker). |
| Reports | Section 30, exports logged. |

**Roles:** `support` (read, masked data), `ops` (recovery, replay), `finance` (reconcile, approve, close periods), `risk` (review queue, rules), `admin` (config, roles), `auditor` (read-only, full audit access). Least privilege: personal data and bank details are masked by default, and a reveal needs a reason and is audited. Every action requires a reason code and writes an audit record (Section 29).

## 20. Maker-checker approvals

Collection `approval_requests`: `id, action, subject, payload, payloadHash, amountPaise, makerId, requiredApprovals, approvals[], status` (pending, approved, rejected, expired, executed), `expiresAt, reason, executedAt`. Rules:

- The checker is never the maker and must hold the required role.
- Approval is bound to `payloadHash`; execution performs **exactly** the approved payload, once. A changed payload needs a new request.
- Requests expire (default 24 h, config). Every decision records who, when and why.
- **Safety actions are single-actor, risk-increasing actions are dual.** Freeze, pause and hold need one person. Unfreeze, release, bulk replay and any change that sends money out need a checker.
- Policy lives in `APPROVAL_POLICY` (action, thresholds, approver count, roles), so amounts are config, not code.

| Action | Approval |
| ------ | -------- |
| Refund | Existing workflow: fewer approvers for small amounts, more for large, always for a redeemed ticket |
| Payout approve (above threshold), manual release, unfreeze | Finance maker, different finance or admin checker |
| Ledger adjustment, write-off, reconciliation write-off above threshold | Finance maker plus checker; evidence mandatory |
| Bulk DLQ replay, DLQ discard | Ops maker plus checker |
| Split override after first sale; commission or plan table; fee rates; GST rate | Admin maker plus checker; applies to future orders only |
| Beneficiary bank detail change | Re-verification plus checker; payouts to the new account held for a cooling period (to be decided) |
| Release of risk-held commissions or payouts | Risk maker plus finance checker above threshold |
| Enable `AUTO_PAYOUTS_ENABLED`, `REFUND_EXECUTOR_ENABLED` | Admin maker plus checker |
| Period close | Finance maker plus checker (Section 30) |

## 21. Fraud and risk engine

A risk service scores activity and returns a decision. It is called at four points:

| Point | Timing | Decisions |
| ----- | ------ | --------- |
| Hold and attempt | Synchronous, budget under 150 ms | allow, challenge (extra verification, lower limits), block |
| After capture | Asynchronous | allow, review (hold tickets or payout for the order) |
| Before payout | Asynchronous | allow, hold for review |
| Before commission release | Asynchronous | allow, hold (Section 22) |

If the service is unavailable at checkout it **fails open to a minimal built-in rule set** (hard velocity caps and blocklists) and logs the degradation; it never silently approves everything.

**Signals:** attempts and failures per user, device, IP and payment instrument over short windows (card testing shows as many small failures); new account with a high-value or large-quantity order; mismatch between account, phone and payment country; repeated refunds or disputes by the same user; blocklists (email, phone, device, bank account, IP range); order patterns that suggest resale or scraping. No card data is stored; only provider-returned attributes (method, issuer, network, last digits where permitted) are used. Device and IP are stored hashed or truncated and handled per data-protection law **(to be confirmed with counsel)**.

**How it works:** rules in `risk_rules` (versioned, config-driven) produce weighted hits that sum to a score; score bands map to decisions. Every decision is stored (`riskDecisions`: inputs, rule hits, score, decision, rule version, correlationId). New rules run in **shadow mode** first (logged, not enforced). Analysts record outcomes (confirmed fraud, false positive); chargebacks feed back automatically; rules are reviewed against these outcomes at least monthly. Customers see a neutral message, never the rule that fired.

## 22. Advanced promoter fraud detection

Promoter commission is the most gameable money flow, so it has its own detection.

| Pattern | Detection |
| ------- | --------- |
| Self or linked referral | Buyer matches promoter on user, device, IP, phone, email, payment instrument or bank account, directly or through a link graph (shared device, bank or phone forms a cluster id) |
| Collusion | Promoter, host or venue share a bank account, KYC identity or device; payout accounts reused across promoters |
| Velocity and bursts | Orders per promoter per hour versus its baseline; many small orders; one buyer many orders; bursts shortly before event completion |
| Order quality | Refund, dispute and chargeback rate of attributed orders versus platform average; cancellations within N days; **tickets never scanned** (paid but not redeemed) |
| Commission anomalies | Promoter share of an event's sales or of the distributable amount far above peers; promo code used from unusual geographies or at unusual volume (code leakage) |
| Fake host or event | New host, high ticket price, fast sales from few instruments, early payout request |

**Scoring:** `promoter_risk_score` (0 to 100) per promoter and per attributed order, recomputed on events and nightly, with the contributing signals stored.

| Score | Action |
| ----- | ------ |
| Above T1 | Hold that order's commission (leg flagged `riskHold`) |
| Above T2 | Hold all of the promoter's commissions; open a review |
| Above T3 | Suspend attribution for the promoter's codes and links |
| Confirmed fraud | Reverse commission (`reversed`), claw back through 1300 against future commissions, blocklist the linked identifiers |

Thresholds are config. The release job in Section 6 excludes `riskHold` legs. A new promoter's or host's first payout is held for review **(to be decided)**, and an optional policy pays commission only on **redeemed** tickets **(to be decided, business)**. Releasing flagged money follows Section 20.

## 23. Automated anomaly detection

**Metrics watched:** payment success rate (by method, bank or issuer, provider), order-create and capture latency, webhook lag, refund rate, dispute rate, payout failure rate, average order value, orders per minute per event, promoter commission share, reconciliation exception rate, risk block rate, outbox lag.

**Methods, in order of adoption:** (1) hard thresholds for known limits; (2) rolling baselines by hour-of-week, flagging a robust deviation (median and MAD) with a **minimum-volume gate** so small samples do not alert; (3) rate-of-change alerts for sudden drops or spikes; (4) multivariate or ML models for promoter and host behaviour, only after enough history exists.

An alert carries severity, the affected slice, a comparison to baseline, a runbook link, and deduplication. Automatic responses are limited to **reversible protective actions** (open a circuit breaker for a method, hold the next payout for a flagged host); anything else is a recommendation to a human. A weekly review of false positives tunes thresholds. Alerts appear in the Ops console and page on-call for money-at-risk signals.

## 24. Observability, correlation IDs and payment SLOs

**Correlation.** The BFF or gateway creates `X-Correlation-Id` (a valid client-supplied UUID is accepted, anything else replaced). It is propagated through service calls, queue messages and outbox events (`correlationId`, `causationId`), structured logs, provider calls (stored in the order `notes` so webhooks carry it back; if absent, derive it from `providerOrderId`), journal entries, audit records, risk decisions and exceptions. One id retrieves the whole story in the Payment 360 view. Tracing uses OpenTelemetry spans around provider calls, transitions, posting and handlers.

**Logging:** structured JSON; never log secrets, signatures, full bank numbers or card data; mask personal data.

**SLOs** (targets are starting values, **to be decided and tuned**):

| SLI | Target | Window |
| --- | ------ | ------ |
| Checkout API availability (quote, hold, attempt, verify) | 99.9% | 30 days |
| Quote and hold latency p95 | under 500 ms | 30 days |
| Webhook acknowledged p99 | under 2 s | 30 days |
| Captured payment to confirmed order p95 | under 10 s | 30 days |
| Captured payments with an order within 15 min | 99.99% (all within 1 h, else exception) | 30 days |
| Outbox publish lag p99 | under 30 s | 30 days |
| Refund submitted to provider after approval, p95 | under 5 min | 30 days |
| Payout initiated after release, p95 | under 15 min | 30 days |
| Daily reconciliation finished by 09:00 IST | 99% of days | 30 days |
| Invariant checks passing | 100% | continuous |
| Critical exceptions past due | 0 | continuous |

**Alerting:** burn-rate alerts on error budgets (fast 1 h, slow 6 h). P1 pages for money-at-risk (invariant breach, custody shortfall, money DLQ item, checkout down); P2 opens a ticket. Every alert links to a runbook. Dashboards: payment funnel (quote, hold, attempt, captured), provider health, backlogs, SLO status.

## 25. Multi-provider readiness

The ports (`PaymentProvider`, `SubscriptionProvider`, `PayoutProvider`) stay; the following make a second provider a new adapter, not a rewrite.

- **Neutral data.** Every payment, refund, payout, subscription, settlement and journal line carries `provider`; ids are `providerPaymentId`, `providerOrderId`, and so on. Ledger accounts that are per provider (1100) are keyed by provider.
- **Canonical events.** Each adapter translates provider webhooks into an internal `ProviderEvent` (`provider, type, providerEventId, objectIds, amount, currency`) with canonical types (`payment.captured`, `payment.failed`, `refund.processed`, `payout.paid`, `dispute.opened`, and so on). Handlers only see canonical events. Each adapter owns its own signature verification and secrets.
- **Capabilities.** `capabilities()` declares methods, subscriptions and mandates, partial refunds, payouts, split or route support, currencies, minimum amounts and settlement cycle. Features check capabilities rather than assuming Razorpay.
- **Reconciliation port.** `ReconciliationPort.fetchSettlementReport(date)` and `fetchPayments(range)` per adapter feed Section 18; fee tables are per provider.
- **Router.** `ProviderRouter.select(context)` is config-driven (method, amount, bank, health, cost); default is Razorpay. A payment is **bound to its provider on creation**. A retry on another provider is a **new attempt**; before failing over, the engine fetches the first attempt's state to be sure no capture happened. If two attempts on one hold both capture, the later one is auto-refunded.
- **Contract tests.** One shared suite runs against every adapter and against the simulator (Section 31).
- **Limits.** Subscriptions and recurring mandates are not portable between providers; existing subscribers stay where they started. Payouts may use a different provider from collection. Adding a second provider is a business decision **(to be decided)**.

## 26. Provider health monitoring

**Signals** per provider and method (UPI, card, net banking by bank, wallet): attempts and success rate, failure by error class (user declines such as insufficient funds are **not** provider faults; technical failures are), latency of order create and fetch (p50, p95), webhook delay (capture time versus receipt) and ack errors, 5xx, timeouts and 429s, settlement lag, payout success rate. A lightweight synthetic probe runs every minute (the readiness credential check plus a cheap read call) and a test-mode canary payment runs daily.

**Health state:** `healthy, degraded, unavailable, recovering`, with hysteresis and a minimum-volume gate so one bad minute does not flap it. Thresholds are config. Each change is stored (`provider_health_events`) and emitted as `ProviderHealthChanged`.

**Circuit breaker** around every provider call: opens after a failure rate or consecutive-failure threshold, probes in half-open state, then closes. While open: the affected method is hidden or shows "temporarily unavailable" instead of failing at checkout, the router moves traffic if another provider is enabled, the payout job pauses (does not fail), and the recovery engine keeps polling so captured payments are still confirmed. Health feeds the router, the Ops console, alerts and the anomaly detector.

## 27. Secrets, KMS and key rotation

Replaces "secrets in environment only" in Section 10.

- **Secret store.** Razorpay key id and secret, webhook secret, payout credentials, signing keys and service credentials live in a managed secret store, injected at runtime, versioned. Each service has its own identity and can read only what it needs. Nothing in the repo, CI logs or client code; CI runs secret scanning.
- **Envelope encryption.** Bank account numbers and sensitive personal data are encrypted with a data key per record, wrapped by a KMS key. Store `keyVersion`. Only the payout service may unwrap; every unwrap is in the cloud audit log. A keyed hash (blind index) of the bank account supports duplicate and collusion detection without decrypting.
- **Rotation schedule:**

| Secret or key | Cadence | Method |
| ------------- | ------- | ------ |
| Provider API secret | 90 days, plus on staff exit or suspected leak | Create new, deploy, verify, revoke old |
| Webhook secret | 90 days | Verify against current and previous during an overlap window; confirm how Razorpay supports overlap (for example a second webhook URL) before the first rehearsal |
| KMS key | Yearly (automatic) | New version; data keys re-wrapped lazily |
| Internal signing keys | 90 days | `kid` in tokens; old keys accepted until expiry |

- **Emergency drill.** Leaked key: revoke, rotate, rotate the webhook secret, review provider and access logs for misuse, run reconciliation. Rehearsed in staging at least twice a year.
- **Access control.** Production secret changes need two people; break-glass access is time-boxed and audited; quarterly access review; alert on unusual secret reads.

## 28. Disaster recovery

**Targets (to be decided; proposed):** Tier 0 (journal, orders, payments, outbox, inbox, audit log): RPO 5 min or better, RTO 4 h. Tier 1 (refunds, payouts, subscriptions): RPO 15 min, RTO 8 h. Tier 2 (dashboards, reports, analytics): RPO 24 h, RTO 24 h.

- **Backups.** Point-in-time recovery on the database (retention per platform limit) plus scheduled exports to a **separate project** in an immutable, retention-locked bucket; journal and audit log exported on their own. Config, flags and infrastructure are in code; secrets and KMS keys have documented recreation steps.
- **Resilience.** Multi-region database location; stateless services across zones; warm standby in a second region for payment services **(to be decided on cost)**.
- **Playbooks:** region outage; bad migration or data corruption (restore to a side database, diff, replay); accidental deletion; queue loss (rebuild from outbox, inbox and event log); credential compromise (Section 27); provider outage (Section 26); ransomware.
- **After any restore, in this order:** (1) trip `AUTO_PAYOUTS_ENABLED` and `REFUND_EXECUTOR_ENABLED` off; (2) restore; (3) replay provider events since the restore point from the event log and the provider API; (4) before re-sending any payout or refund, look it up at the provider by reference, since money may already have moved; (5) run reconciliation and all invariants; (6) re-enable with a checker's approval.
- **Drills:** restore into an isolated environment every quarter and run invariants on it; a game day every half-year; record actual RPO and RTO against targets and fix the gaps.
- **Retention:** financial records and the audit log follow Section 29.

## 29. Financial audit trail

Collection `audit_log`, append-only, written only by service identities through one append API; security rules allow no update or delete. Fields: `auditId, at` (server time), `actor` (`type`: user, admin, system, provider; `id`; `role`), `action` (for example `refund.approve`), `subject`, `before` and `after` (masked diff), `reason`, `approvalId`, `correlationId`, `ip`, `userAgent`, `result` (success, denied, error), `hash`, `prevHash`.

- **Coverage:** all state transitions of the machines in Section 15; approvals and rejections; config, flag and rate changes; split overrides; ledger adjustments and write-offs; role and access changes; reveals of masked data; exports; admin logins; DLQ actions; risk overrides. Cloud audit logs cover KMS and secret access.
- **Tamper evidence.** Each record hashes its content plus the previous hash. A daily root hash is written to a separate project and an immutable bucket, and a verifier job checks the chain (invariant I10).
- **Relationship to the ledger.** The journal records money; the audit log records who did what. They link by `correlationId` and entry ids. Application logs are not an audit trail.
- **Retention and access:** retention to be set with the CA and counsel (company books of account are generally kept for 8 years; confirm). The `auditor` role has read-only search by subject, actor and time, and can export (exports are themselves audited).

## 30. Financial reporting and analytics

**Sources and reproducibility.** Financial reports read the journal; beneficiary views read the sub-ledger; settlement views read `settlement_records`. Each run records its parameters and the ledger watermark it read, so the same report can be reproduced; closed periods use stored snapshots.

| Report | Purpose |
| ------ | ------- |
| Trial balance and account statements | Proof that books balance; drill-down to entries |
| Liability to beneficiaries | Held, releasable and in transit by beneficiary and age |
| Platform revenue and margin | Commission, convenience fee, subscription, less gateway fees (5100); by event, month, plan |
| GST | Output GST by type, invoice register, working data for GST returns, input credit on gateway fees |
| Settlement and cash position | Expected versus received, in-transit ageing, custody versus liabilities |
| Payouts and refunds | Ageing, failures, UTRs; refund, dispute and chargeback rates by event, promoter, method |
| Reconciliation | Last clean run, open exceptions, ageing, value at risk |
| Promoters and risk | Performance with risk flags; blocked, reviewed and false-positive counts |
| Subscriptions | Recurring revenue, churn, failed renewals, grace and suspensions; store-billed shown separately |

**Analytics.** Events (Section 16) stream to an analytics store; it is never in the transaction path and holds minimised personal data. Metrics: funnel (quote, hold, attempt, captured), success by method, bank and provider, average order value, discount cost by type, time to payout, event-level profit and loss, risk outcomes. Partners see only their own rows.

**Period close (monthly):** reconciliation clean, invariants passing, open exceptions explained, finance maker plus checker approve the close, the period locks (I12), later corrections post as adjusting entries in the open period. **Exports:** CSV, XLSX and PDF, large ones asynchronous, stamped with generator, time and watermark; every export is audited; reports can be scheduled to finance and the CA.

## 31. Payment simulator and failure testing

**Simulator.** A provider driver that implements all three ports, `ReconciliationPort` and a webhook emitter, controlled by scripted, seeded scenarios (API and console, non-production only). Scenarios: success; each failure class; slow response; **timeout after capture** (money moved, no response); duplicate, delayed, lost and out-of-order webhooks; wrong amount or order id; invalid signature; unknown fields; partial refund; refund failed; payout failed or returned; short or missing settlement; dispute lifecycle; 429 and 5xx; full outage. It can also generate settlement and bank files with injected mismatches for reconciliation tests. It doubles as the contract-test reference and for load tests.

**Fault injection.** Kill a worker after each fulfilment step; crash between commit and outbox publish; queue unavailable or delivering duplicates; database latency and contention; clock skew; concurrent refund and payout release on the same legs; double approval race; flash-sale race on inventory with capture after expiry; secret rotation under traffic; breaker flapping; replay of a very large event backlog; zone loss in staging.

**Method.** The oracle is the invariant checker (Section 3.2): after every scenario all of I1 to I12 must hold and reconciliation must show no unexplained difference. Property-based tests run the settlement function and posting rules over random splits, promos, hosts and rounding. Contract tests run on every adapter. Chaos runs in staging in CI and in a quarterly game day; production never gets fault injection on money-moving paths. Flash-sale load targets **(to be decided)**.

_Verify limits, payloads and product availability against live Razorpay docs and your account manager before each phase._

