# THEC1RCLE Payments — Implementation Task Plan

> **Source of requirements:** [Technical Guide](<PAYMENTS — TECHNICAL GUIDE.md>) (guide section numbers below are written as plain `N`, for example "per 3.1"), plus the companion _Payments: Business Rules_.
> **Repos:**
> - `BE` = `C1RCLE-BACKEND` (Fastify 5 gateway + `packages/core` + `packages/contracts`)
> - `FE` = `C1RCLE-FRONTEND` (Next.js 16 guest-portal / partner-dashboard / admin-console)
>
> **Ordering rules this plan follows:**
> 1. Backend first. Phases 0–15 are backend/platform. Frontend work starts at Phase 16.
> 2. Subscriptions are the final phase (Phase 19).
> 3. Real money in production only after the launch gates in 12 are met (see Phase 18).

---

## 0. How to use this file

- Work **phase by phase**. Each phase lists **Depends on**, then tasks grouped by **Create / Modify / Integrate / Test**, then an **Exit gate**. Don't start a phase until every phase it depends on has passed its exit gate.
- Task IDs (`4.12`) are stable. Reference them in commit messages and PR titles, for example `feat(payments): 4.12 resumable fulfilment steps`.
- Owner tags: `[BE]` backend, `[FE]` frontend, `[PLAT]` platform/devops, `[FIN]` finance, `[RISK]` risk, `[BIZ]` business/legal decision.
- **Every BE task's definition of done:** it follows the architecture laws in `CLAUDE.md`. Routes stay thin, services use ports, `process.env` is read only in `apps/api-gateway/src/config/index.ts`, and there are no `.collection()` calls outside `infrastructure/`. It has memory **and** Firestore adapters, unit plus route tests, and `pnpm check` is green from the `BE` root.
- **Every FE task's definition of done:** network calls go only through `@c1rcle/api-client`, env vars only through `@c1rcle/config`, there are no inline styles, and `pnpm check` is green from the `FE` root.
- Status tracking: per `CLAUDE.md`, live status belongs in `BE/docs/roadmap/ROADMAP.md`. Task **0.6** adds a "Payments v2" row there that points to this file. Track task progress there, referencing task IDs from this file.
- Money is always **integer paise** and rates are always **basis points (bps)**. No floats on any money path. This is a code-review blocker.

---

## 1. Baseline: what exists today and what happens to it

| Area | Existing code (BE unless noted) | Verdict |
|---|---|---|
| Pricing | `domain/models/pricing.ts` (5% platform + 2.5% payment fee + 18% GST on fees, integer paise) | **Keep the formula.** Move the rates from constants to config bps (`CUSTOMER_FEE_*_BPS`, `GST_BPS`) and snapshot them onto the hold (4). |
| Quote / hold | `application/checkout/checkout-service.ts` `quote`, `createHold`; `CartReservation` (`active/converted/released`) | **Keep and extend.** Add attendee data, the `payment_pending` and `expired` states, `providerOrderId`, and a split/commission snapshot. |
| Provider port | `domain/ports/payment-provider.ts` (`createOrder/verifyPayment/capturePayment/refundPayment/getPayment`) plus `MemoryPaymentProvider` | **Refactor.** Split into `PaymentProvider`, `PayoutProvider`, `SubscriptionProvider` and `ReconciliationPort`, add `capabilities()`, and return `orderId`, `method` and `status` from `getPayment`. |
| Razorpay adapter | `apps/api-gateway/src/lib/payments/razorpay-adapter.ts` | **Fix.** The callback signature algorithm is wrong (audit Critical #2), length checks are missing, and there are no timeouts, retries or error classes. |
| Payment routes | `routes/v2/checkout/{checkout,payment,webhook}-routes.ts` | **Keep the routes and URLs**, rewire them to the new services, and keep the raw-body webhook (it is strong). |
| Fulfilment | `CheckoutService.confirmPayment` does order save → hold convert → promo → entitlements → `recordSettlement`, with no transaction and an early return on an existing order | **Replace** with `FulfilmentService` (transaction, steps, outbox), per audit Critical #3 and #4. |
| Settlement split | `domain/models/ledger.ts` `computeSettlementSplit(grossAmount, platformFeeRate…)` plus `PLAN_TIER_PLATFORM_FEE_RATE` (15/12/10%) | **Replace** with `computeSettlementLegs()` per 3. The current formula charges a plan rate on the **grand total including fees**; the guide charges `commissionBps` (default **0**) on the **subtotal**, pays the promoter first, and splits the rest venue/host. See decision **DP-01**. |
| Partner ledger | `LedgerEntry` (`pending/settled/paid_out`, `v2_partner_ledger`), `FinanceService.recordTicketSale/getBalances` | **Evolve** into the beneficiary sub-ledger (legs with the 3 states) **plus** a new double-entry journal (3.1). Migrate existing rows (6.10). |
| Venue share | `Partnership.venueShareRate` (whole %, max 50), negotiated via `POST /partnerships/:id/venue-share` | **Keep** as the *default source* for the new per-event `EventSplitConfig` (bps, multi-host), validated at publish and locked after the first sale (5). |
| Payouts | `domain/models/payout.ts` (`requested→processing→paid/failed`, `frozen`, ₹100 min), partner-initiated drawdown; `AdminPayoutService.runBatch` only flips status | **Replace the lifecycle** with 15 Payout states driven by the release job and a `PayoutProvider`. The partner "request payout" route is kept only as an on-demand trigger of the release job (DP-06). |
| Bank accounts | `BankAccount` (AES-256-GCM, `verified: boolean`, `v2_bank_accounts`) plus `bank-account-service.ts` | **Evolve** into `Beneficiary` (ownerType, kycStatus, providerRef, bankLast4, blind index); later move to KMS envelope encryption (15). |
| Refunds | `AdminRefundRequest` (`pending/approved/rejected/settled/failed`, N-approver accumulator, thresholds in `PlatformSettings`); `RefundService` never calls the provider | **Keep approvals.** Extend the FSM to 15 (`processing`, `manual`) and add a `RefundExecutor` (7). |
| Disputes | `Dispute` = a partner challenging a ledger entry (`open→under_review→resolved`) | **Keep as is** (different concept). Add a **new** `Chargeback` entity for `payment.dispute.*` (11). |
| Dual control | `admin-authority.ts` TIER1/2/3, propose→resolve (`v2_proposed_actions`), proposer ≠ resolver | **Generalise** into maker-checker `ApprovalRequest` with `payloadHash`, expiry, N approvers and `APPROVAL_POLICY` (10). Don't build a second mechanism. |
| Audit | `AdminAuditRepository` (`v2_admin_audit_logs`, before/after, ip, UA); domain `AuditRepository` is memory-only | **Evolve** into the hash-chained `audit_log` (29) with `correlationId` and `result` (2). |
| Outbox / event bus | `domain/ports/outbox.ts`, `MemoryOutboxStore`, `InProcessEventBus` (in-memory dedupe sets) | **Complete it.** Add a Firestore outbox in the same transaction as the business write, a durable inbox, and a relay in the worker (2). Decision D-021 already demanded this. |
| Transactions | `TxContext` marker on repository ports, **ignored** by Firestore adapters (`_tx`) | **Implement** a `UnitOfWork` port and Firestore `runTransaction` adapter, and make the money repos honour `tx` (2). |
| Idempotency | `IdempotencyService` (`v2_idempotency_records`, 24h) | **Keep and reuse** on every mutating money endpoint. |
| Correlation | `lib/request-tracing.ts` (`x-request-id`) | **Extend** to `X-Correlation-Id` propagated end to end (2). |
| Feature flags | `PlatformSettings.featureFlags` (admin-editable, `v2_platform_settings`) | **Reuse** for `PAID_CHECKOUT_ENABLED`, `AUTO_PAYOUTS_ENABLED`, `REFUND_EXECUTOR_ENABLED`, `SUBSCRIPTIONS_ENABLED`, with an automatic trip on invariant breach (0, 6). |
| Background jobs | One `setInterval` in `apps/api-gateway/src/app.ts` (hold sweep) | **Replace** with a dedicated **payments worker process** (2.15). |
| Readiness | `lib/readiness.ts` supports `paymentProviderActive`, but `buildApp` never passes it | **Fix** (1). |
| FE checkout | `CheckoutFlowClient.tsx` paid path is a preview (local 5% fee, link to `/confirmation/preview-…`); no BFF routes, no api-client methods | **Build** (16). |
| FE finance | `partner-dashboard/src/lib/finance/api-finance-repository.ts` (live balances/payouts/bank), `components/partner-v3/finance/*`; admin-console `refunds/`, `payouts/`, `disputes/`, `proposals/`, `audit/`, `settings/` pages | **Extend and rewire** to the new endpoints (17). |

---

## 2. Target modular architecture

### 2.1 Runtime topology

```text
Guest portal / Partner dashboard / Admin(Ops) console
   └─(same-origin BFF, CSRF, cookie)→ API gateway  (apps/api-gateway, `src/server.ts`)  ← HTTP only, thin routes
                                         │ writes state + outbox in ONE Firestore transaction
                                         ▼
                                   Firestore (v2_* collections)
                                         ▲
   Payments worker (apps/api-gateway, NEW entrypoint `src/worker.ts`, separate Render service)
     ├─ OutboxRelay           (pending outbox → in-process bus → consumers with durable inbox)
     ├─ RecoveryEngine        (stalled fulfilment, captured-without-order, stuck refunds/payouts, polling fallback)
     ├─ ReleaseJob            (held → releasable → payout_requested)
     ├─ ReconciliationJob     (hourly light / daily full)
     ├─ InvariantVerifier     (I1–I12, hourly/daily)
     ├─ ProviderHealthProbe   (every minute)
     └─ AnomalyDetector, PeriodClose helpers, Subscription drift (later phases)
Razorpay ──webhooks──→ gateway `/api/v2/webhooks/payments/razorpay` → verify → provider-event inbox → outbox → worker
```

**Why the worker is a second entrypoint in the same app package rather than a new `apps/*`:** it reuses `config/index.ts` (the only `process.env` reader), `lib/v2-services.ts` (the composition root) and `lib/payments/*` (the Razorpay adapters) without an app depending on another app. Separation is enforced at deploy time (a separate process and Render service) and by module boundaries in `packages/core`.

### 2.2 Service map (each service owns one responsibility)

All services live in `BE/packages/core/src/application/<module>/`. They are pure TypeScript, depend only on ports, and are wired in `apps/api-gateway/src/lib/v2-services.ts`.

| # | Service (module) | Responsibility | Owns collections | Calls |
|---|---|---|---|---|
| S1 | `PricingService` (`pricing/`, exists) | Server quote; fee/GST math from config bps | — | catalog repos |
| S2 | `CheckoutService` (`checkout/`, slimmed) | Quote, hold, pre-checkout validation, attendee capture | `v2_cart_reservations` | S1, S11, S15, S16 |
| S3 | `PaymentService` (`payments/`, **new**) | Payment attempts, provider order binding, callback verify, payment FSM | `v2_payments`, `v2_payment_attempts` | `PaymentProvider` via S17 |
| S4 | `FulfilmentService` (`fulfilment/`, **new**) | `confirmPayment`: one-transaction order/hold/promo/entitlements, steps, resume, captured-after-expiry | `v2_orders`, `v2_entitlements`, `v2_promo_redemptions` | S3, S5 (via outbox) |
| S5 | `SettlementService` (`settlement/`, **new**) | Runs pure `computeSettlementLegs()` once per order and stores the result on the order | — (writes via S6) | S6 |
| S6 | `LedgerPostingService` (`ledger/`, **new**) | The **only** writer of journal entries, lines and sub-ledger legs; balance check; period lock | `v2_journal_entries`, `v2_journal_lines`, `v2_ledger_legs`, `v2_account_balances` | — |
| S7 | `FinanceQueryService` (`finance/finance-service.ts`, refactored) | Read-side balances and dashboard stats from the ledger | — | S6 repos |
| S8 | `RefundService` (exists) + `RefundExecutor` (`refunds/`, **new**) | Approvals (existing), then provider refund, entitlement void, ledger reversal | `v2_refund_requests` | S3, S6, S17 |
| S9 | `BeneficiaryService` (`beneficiaries/`, evolves `bank-account-service`) | KYC status, provider beneficiary/fund account, publish gate | `v2_beneficiaries` | `PayoutProvider` |
| S10 | `PayoutService` (`payouts/`, rewritten) + `ReleaseJob` | Release eligibility, grouping, payout FSM, provider payout, settings | `v2_payouts`, `v2_payout_settings` | S6, S9, S13, S17 |
| S11 | `ProviderEventIngestor` (`webhooks/`, **new**) | Verify, persist the provider-event inbox, map to canonical `ProviderEvent`, enqueue | `v2_provider_events` | adapters |
| S12 | `ReconciliationService` (`reconciliation/`, **new**) | R1–R5 matching, settlement records, exceptions workflow | `v2_settlement_records`, `v2_recon_runs`, `v2_recon_exceptions` | `ReconciliationPort`, S6 |
| S13 | `ApprovalService` (`approvals/`, generalises admin-authority) | Maker-checker with payloadHash, expiry, policy | `v2_approval_requests` (migrated from `v2_proposed_actions`) | S14 |
| S14 | `AuditTrailService` (`audit/`, **new**) | Hash-chained append-only audit, daily root hash | `v2_audit_log`, `v2_audit_roots` | — |
| S15 | `RiskService` + `PromoterFraudService` (`risk/`, **new**) | Scoring, decisions, shadow mode, holds | `v2_risk_rules`, `v2_risk_decisions`, `v2_promoter_risk`, `v2_identity_links` | — |
| S16 | `FeatureFlagService` (`platform/`, wraps PlatformSettings) | Flag reads plus automatic kill-switch trip | `v2_platform_settings` | S14 |
| S17 | `ProviderRouter` + `ProviderHealthService` + `CircuitBreaker` (`providers/`, **new**) | Select a provider, health state, breaker | `v2_provider_health_events` | adapters |
| S18 | `RecoveryEngine` + `DeadLetterService` (`recovery/`, **new**) | Retry policy, task types, DLQ, replay | `v2_recovery_tasks`, `v2_dead_letters` | S3, S4, S8, S10 |
| S19 | `InvariantService` (`invariants/`, **new**) | I1–I12 checks, breach handling | `v2_invariant_runs` | S6, S16 |
| S20 | `ReportingService` + `PeriodCloseService` (`reporting/`, **new**) | Reports, exports, period lock, analytics stream | `v2_periods`, `v2_report_runs` | S6 |
| S21 | `AnomalyService` (`anomaly/`, **new**) | Baselines, alerts, protective actions | `v2_anomaly_alerts`, `v2_metric_baselines` | S17, S16 |
| S22 | `NotificationService` (exists) + payment consumers | 9 notifications keyed by event id | `v2_notifications` | outbox |
| S23 | `SubscriptionService` + `InvoiceService` + `EntitlementPlanResolver` (`subscriptions/`, **Phase 19**) | Plans, subscriptions FSM, invoices, `canUse`, `commissionBps` | `v2_plans`, `v2_subscriptions`, `v2_invoices`, `v2_invoice_counters` | `SubscriptionProvider` |

**Ports** (`BE/packages/core/src/domain/ports/`): `payment-provider.ts` (refactor), `payout-provider.ts`, `subscription-provider.ts`, `reconciliation-port.ts`, `unit-of-work.ts`, `clock.ts`, `id-generator.ts`, `secret-store.ts`, `kms.ts`, `outbox.ts` (extend), `inbox.ts`, `plan-resolver.ts`.

**Adapters:**
- Razorpay: `BE/apps/api-gateway/src/lib/payments/razorpay-{payment,payout,subscription,reconciliation}-adapter.ts`.
- Simulator: `BE/packages/core/src/infrastructure/simulator/` (memory driver, I/O-free).
- Firestore: `BE/packages/core/src/infrastructure/firestore/firestore-*.ts`.

### 2.3 Boundary rules to add (`BE/scripts/check-boundaries.mjs`)

- Only `application/ledger/**` may import journal/leg repository **write** methods.
- Only `domain/state-machines/transition.ts` may assign `.status` on Payment/Order/Refund/Payout/Hold/Leg/Subscription aggregates (lint rule plus boundary grep).
- `apps/api-gateway/src/worker.ts` must not import `routes/**`, and `routes/**` must not import `worker/**`.
- No `Number`/float arithmetic in `domain/models/{pricing,settlement,journal}.ts`: grep for `* 0.`, `/ 100)` without `Math.round`, and `parseFloat`.

---

## 3. Decisions to record before or during build

Record each decision in `BE/docs/architecture/decisions.md` as `D-031…`. "Default" is what this plan builds if nobody decides; every default is reversible by config.

| ID | Question | Default this plan uses | Blocks |
|---|---|---|---|
| DP-01 | Retire the plan-tier platform fee (15/12/10% of the **grand total**, D-019) in favour of 3 `commissionBps` on the **subtotal**? | **Yes.** `PLAN_COMMISSION_BPS` defaults to 0 for every plan; `Organization.platformFeePercent` is no longer read by settlement; the existing ledger rows stay as historical. | 5 |
| DP-02 | Customer fee + GST: revenue vs cost recovery (3) | Post to 4110 Convenience fee revenue and 2200 GST payable; revisit with the CA | 6 |
| DP-03 | `FEES_REFUNDABLE_ON_REFUND` | `false` (fees refunded only on event cancellation) | 7 |
| DP-04 | Negative-balance recovery after payout (7) | Record a 1300 Recoverable and net it off future payouts; the platform funds the gap | 7, 9 |
| DP-05 | Payout rail (6) | **Manual** first (operator marks paid with UTR and evidence), RazorpayX payouts adapter second, Route later | 9 |
| DP-06 | Keep partner-initiated "request payout"? | Keep the endpoint; it now triggers the release job for that beneficiary (respects `minPayoutThresholdPaise`) | 9 |
| DP-07 | Event "completed" signal | New `Event.completedAt` set by organiser close-out (`POST /organizations/:org/events/:id/close-out`) or a scheduled job at `endsAt + EVENT_AUTO_COMPLETE_HOURS`; `EventStatus` stays as is | 9 |
| DP-08 | RBI payment-aggregator fit (10): money collected into THEC1RCLE's account vs Route | **Must be answered by lawyer + Razorpay before Phase 9**; 9 is built behind the `PayoutProvider` port so Route can replace it | 9 `[BIZ]` |
| DP-09 | Discount absorption (14) | Current proportional effect (discount reduces subtotal before split) | 5 |
| DP-10 | Approval policy thresholds and roles (20) | Reuse refund thresholds from `PlatformSettings`; payouts above ₹50,000 need a checker | 10 |
| DP-11 | Exception SLAs, risk bands, promoter T1/T2/T3, RPO/RTO, audit retention | Proposed values in 13/28 as config; finance and risk confirm | 11–15 |
| DP-12 | Subscription proration, grace days, Razorpay vs in-house invoices, app-store billing | Decided at the start of Phase 19 | 19 |
| DP-13 | Venue chooses commission plan vs platform sets it (5) | Platform sets it via `PLAN_COMMISSION_BPS`; venue/host only set the per-event split | 5, 19 |
| DP-14 | First payout of a new host/promoter held for review; commission only on redeemed tickets (22) | Both **off** by config (`FIRST_PAYOUT_REVIEW=false`, `COMMISSION_ON_REDEEMED_ONLY=false`) | 12 |

---

## Phase 0 — Unblock and baseline

**Goal:** route tests run, tooling works, flags exist, and the docs stop lying. **Depends on:** nothing.

### Modify
- **0.1 `[BE]`** ~~Add the missing `createFollowerFanOutConsumer` import in `apps/api-gateway/src/lib/v2-services.ts:288` (from `@c1rcle/core`; confirm the export in `application/social/notification-consumers.ts` or `application/index.ts`). Re-run `checkout-routes.test.ts`, `payment-routes.test.ts` and `webhook-routes.test.ts`; all 23 must load and pass.~~ **Done on staging (import already present).**
- **0.2 `[BE]`** Fix the `scripts/contract-parity.mjs` default path. Resolve `../../C1RCLE-FRONTEND` when `../C1RCLE-FRONTEND` is absent (keep the `C1RCLE_FRONTEND_PATH` override) and document it in `BE/CLAUDE.md`/`CLAUDE.md`. Make the script build FE `packages/contracts` if `dist` is missing, or fail with a clear message.
- **0.3 `[BE]`** Fix documentation drift (audit #19–21):
  - Update `docs/integration-flows/checkout.md` and `docs/api-contracts/openapi.yaml` to the runtime routes (`/checkout/quote`, `/checkout/holds`, `/payments/attempts`, `/payments/:id/verify`).
  - Correct `docs/operations/staging-environment-contract.md`.
  - Mark Phases 4 and 6 in `ROADMAP.md` as "backend primitives done; product payments in progress → Payments v2".
- **0.4 `[BE]`** Add payment flag keys with safe defaults to `PlatformSettings.featureFlags` reads through a new `FeatureFlagService` (`application/platform/feature-flag-service.ts`): `PAID_CHECKOUT_ENABLED=false`, `AUTO_PAYOUTS_ENABLED=false`, `REFUND_EXECUTOR_ENABLED=false`, `SUBSCRIPTIONS_ENABLED=false`. Expose `isEnabled(flag)` and `trip(flag, reason, correlationId)`. A trip writes an audit record; for now it uses the existing admin audit and moves to the S14 audit trail in 2.
- **0.5 `[BE]`** Gate `POST /checkout/holds` and `POST /payments/attempts` on `PAID_CHECKOUT_ENABLED` for paid tiers (403 `feature_disabled`). Free RSVP is unaffected.

### Create
- **0.6 `[BE]`** Add a ROADMAP row "Payments v2 — see `PAYMENTS — IMPLEMENTATION TASK PLAN.md`" and a new `docs/roadmap/phase-09-payments-v2.md` with a Session Log (same convention as the other phase files).
- **0.7 `[BE]`** Record decisions DP-01…DP-14 as `D-031…` stubs in `docs/architecture/decisions.md` (status `proposed`/`chosen`).
- **0.8 `[BE]`** Add a `packages/core/src/config/payments.ts` schema for every payment config key in 13 with defaults. Core receives it via DI; the gateway `config/index.ts` parses env into it. Keys:
  - **Rates:** `CUSTOMER_FEE_PLATFORM_BPS=500`, `CUSTOMER_FEE_PAYMENT_BPS=250`, `GST_BPS=1800`, `PLAN_COMMISSION_BPS={"basic":0,"pro":0,"premium":0}`.
  - **Refunds and payouts:** `FEES_REFUNDABLE_ON_REFUND=false`, `PAYOUT_RELEASE_WINDOW_HOURS=0`.
  - **Recovery:** `RECOVERY_BACKOFF=[60,300,900,3600,21600]` (seconds).
  - **Reconciliation:** `RECON_TOLERANCE_PAISE`, `SETTLEMENT_EXPECTED_DAYS=2`.
  - **Approvals:** `APPROVAL_EXPIRY_HOURS=24`, `APPROVAL_POLICY` (JSON).
  - **Provider routing:** `PROVIDER_DEFAULT=razorpay`, `PROVIDER_ROUTING_RULES`, `BREAKER_FAILURE_RATE`, `BREAKER_MIN_VOLUME`.
  - **Secrets and DR:** `SECRET_ROTATION_DAYS=90`, `RPO_MINUTES`, `RTO_HOURS`, `AUDIT_RETENTION_YEARS`.
  - **Period close and SLOs:** `PERIOD_CLOSE_DAY`, `SLO_*`.
  - **Holds:** `HOLD_TTL_SECONDS=600`.
  - **Added by this plan:** `EVENT_AUTO_COMPLETE_HOURS`, `FIRST_PAYOUT_REVIEW`, `COMMISSION_ON_REDEEMED_ONLY`.

### Test
- **0.9** `config/index.test.ts` covers the defaults and invalid values (negative bps, bad JSON) for every new key.

**Exit gate:** `pnpm check` green in `BE`; `pnpm contract-parity` runs from the default layout; the checkout route suites execute; flags default off.

---

## Phase 1 — Provider correctness and credentials (2 corrections 1, 4, 7)

**Goal:** a real Razorpay test payment verifies, and a forged callback is rejected. **Depends on:** 0.

### Modify
- **1.1 `[BE]`** `razorpay-adapter.ts` `verifyPayment`: HMAC-SHA256 of `${razorpayOrderId}|${razorpayPaymentId}` with **`keySecret`** (not the webhook secret). Hex-compare via an equal-length check, then `timingSafeEqual`; a length mismatch returns `InvalidOperationError`, never a `RangeError`.
- **1.2 `[BE]`** `verifyWebhookSignature` gets the same length guard. Extract both into a shared `lib/payments/hmac.ts` (`safeHexEqual`).
- **1.3 `[BE]`** `MemoryPaymentProvider` mirrors the **real** scheme (`order|payment`, key secret) so tests exercise the production algorithm; update `generateSignature` and every test that builds signatures.
- **1.4 `[BE]`** Extend the `PaymentVerificationResponse` returned by `getPayment` to `{ paymentId, providerOrderId, amountPaise, currency, status, captured, method, bank?, wallet?, vpa?, cardNetwork?, cardLast4?, errorCode?, errorReason?, createdAt, capturedAt?, notes }`. Map Razorpay `order_id`, `method`, `status`, `currency` and `notes`. The method attributes feed 14 and 21.
- **1.5 `[BE]`** `createOrder`:
  - Assert that the provider-returned `amount` and `currency` equal the request (audit #13).
  - Pass `notes: { holdId, eventId, organizationId, correlationId }` (24).
  - Set `receipt` to the hold id (truncated to 40 characters).
  - Explicitly request `payment_capture`/auto-capture and document it (audit #15).
- **1.6 `[BE]`** Provider HTTP hardening in a new `lib/payments/http.ts`:
  - `AbortController` timeout per call (config `PROVIDER_TIMEOUT_MS`, default 8000).
  - Bounded retries with jitter, only on idempotent GETs and on POSTs that carry a provider idempotency key.
  - Error classification into `ProviderTransientError` (timeouts, 5xx, 429) and `ProviderPermanentError` (4xx validation, auth), declared in `domain/errors.ts`.
- **1.7 `[BE]`** `lib/v2-services.ts:307` removes the `'test_key_id' / 'test_key_secret' / 'test_webhook_secret'` fallbacks.
- **1.8 `[BE]`** `config/index.ts` uses a `superRefine`: when `STORAGE_DRIVER !== 'memory'`, require `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`, so startup fails with a clear message.
- **1.9 `[BE]`** `app.ts` passes `paymentProviderActive: config.STORAGE_DRIVER !== 'memory'` to `createReadinessChecks`. The probe makes a cheap authenticated read (for example `GET /v1/payments?count=1`) with a timeout.
- **1.10 `[BE]`** Remove `capturePayment` from the hot path; keep it on the port for manual-capture accounts and document "auto-capture required" in `docs/operations/`.

### Create
- **1.11 `[BE]`** Add `docs/operations/razorpay-account-setup.md`: test/live key generation, webhook URL `https://<gateway>/api/v2/webhooks/payments/razorpay`, the events to subscribe (`payment.captured`, `payment.failed`, `order.paid`, `refund.created/processed/failed`, `payment.dispute.*`, `settlement.processed`, later `payout.*` and `subscription.*`), auto-capture settings, enabled methods (14), and where secrets live.

### Test
- **1.12** Adapter tests with the **official Razorpay test vector** (known order id, payment id, secret and expected signature), plus a wrong secret, a swapped order, a truncated signature (no throw), and a non-hex signature.
- **1.13** Route test: a forged callback returns 400/401 and creates no order; a valid callback plus captured payment creates the order.
- **1.14** Config test: firestore driver without Razorpay keys means `loadConfig` throws.
- **1.15** Manual: one real **test-mode** payment through Razorpay Checkout (a standalone HTML harness under `BE/scripts/dev/razorpay-checkout-harness.html` that calls the gateway) verifies end to end.

**Exit gate:** 1.12–1.15 pass; readiness shows `paymentProvider: ok` on staging.

---

## Phase 2 — Platform foundations (1 principles 6–10, 15, 16, 24, 29)

**Goal:** every later money feature can write state and event atomically, has an explicit FSM, carries one correlation id, and leaves a tamper-evident audit trail. **Depends on:** 0.

### 2A. Unit of work and transactions
- **2.1 `[BE]`** Create `domain/ports/unit-of-work.ts`:
  - `interface UnitOfWork { run<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> }`.
  - Repositories accept `tx` and must perform **reads before writes** (Firestore rule). Document this.
- **2.2 `[BE]`** Create `infrastructure/firestore/firestore-unit-of-work.ts`. It wraps `db.runTransaction`; the `TxContext` carries the Firestore `Transaction` inside the infra layer (opaque to core).
- **2.3 `[BE]`** Create `infrastructure/memory/memory-unit-of-work.ts`: a serialised mutex plus a copy-on-write journal so a thrown `fn` rolls back memory repos.
- **2.4 `[BE]`** Make the money-path Firestore repos honour `tx`, with compare-and-set inside the transaction: `firestore-order-repository.ts` (today `_tx` is ignored), `firestore-cart-reservation-repository.ts`, `firestore-entitlement-repository.ts`, `firestore-promo-redemption-repository.ts`, `firestore-refund-request-repository.ts`, `firestore-payout-repository.ts`, `firestore-ledger-repository.ts`, `firestore-bank-account-repository.ts`. Refactor `compare-and-set.ts` to accept an optional transaction.
- **2.5 `[BE]`** Extend `infrastructure/contract-suite.test.ts` so every adapter above runs a "write two aggregates in one `run`, throw, assert neither persisted" case against memory and the Firestore emulator.

### 2B. State-machine kernel (15)
- **2.6 `[BE]`** Create `domain/state-machines/`:
  - `transition.ts` is the single writer: `transition(entity, event, actor, { correlationId, causeEventId, now })`. It returns `{ next, historyEntry, outboxEvent }` and throws `IllegalTransitionError` (logged as `illegal_transition`, metric counter).
  - Machines (tables as data, built on the existing `fsm.ts`): `hold.ts`, `payment.ts`, `order.ts`, `refund.ts`, `payout.ts`, `ledger-leg.ts`, `subscription.ts`. Each has exactly the 15 states and transitions.
  - Terminal-state late events: record and ignore, then flag for a provider-state fetch.
- **2.7 `[BE]`** Add `stateHistory: { from, to, at, causeEventId, actor, correlationId }[]` to Order, CartReservation, AdminRefundRequest and Payout, plus the new Payment and Leg (capped inline at 50 entries; overflow goes to a `…_history` subcollection).
- **2.8 `[BE]`** Write `state-machines.test.ts`, a table-driven test that walks **every allowed and every disallowed pair** for every machine (15 rule).

### 2C. Outbox, inbox, event catalog (16)
- **2.9 `[BE]`** Extend `domain/ports/outbox.ts` with the envelope `eventId, type, version, occurredAt, aggregateType, aggregateId, seq, correlationId, causationId, actor, payload`, plus `status` (`pending|published|failed`), `attempts` and `publishedAt`. Add `append(event, tx)`.
- **2.10 `[BE]`** Create `infrastructure/firestore/firestore-outbox-store.ts` (`v2_outbox`). It writes inside the caller's transaction and keeps a per-aggregate `seq` counter doc (`v2_outbox_seq/{aggregateType}:{aggregateId}`) incremented in the same transaction. Fulfils D-021.
- **2.11 `[BE]`** Create `domain/ports/inbox.ts` plus Firestore and memory adapters (`v2_inbox`, doc id `${consumer}:${eventId}`). `claim(consumer, eventId, tx)` returns false if the row is already processed. Handlers record the inbox row **in the same transaction** as their effect.
- **2.12 `[BE]`** Refactor `application/events/event-bus.ts`: replace the in-memory `processedByHandler` sets with the durable inbox, add `consumer` names, and order delivery by `seq` per aggregate.
- **2.13 `[BE]`** Create `domain/payment-events.ts` with the **versioned event catalog** from 16 (Payment/Order, Refund, Payout, Ledger, Dispute, Subscription, Control) as typed `EventPayloads`. Payloads carry ids and amounts only; a lint test asserts no `accountNumber|ifsc|email|phone` keys.
- **2.14 `[BE]`** Create `application/events/outbox-relay.ts`. It reads pending rows by `seq`, publishes to the bus, marks them published, backs off on failure, and alerts on rows older than `OUTBOX_LAG_ALERT_SECONDS`.

### 2D. Payments worker process
- **2.15 `[BE][PLAT]`** Create `apps/api-gateway/src/worker.ts` plus `src/worker/scheduler.ts`:
  - Single-process job scheduler (interval plus jitter).
  - Firestore **lease** per job (`v2_job_leases/{job}` with `holder`, `expiresAt`) so only one worker instance runs a job.
  - Graceful shutdown (reuse `lib/shutdown.ts`).
  - Jobs registered here: OutboxRelay (2), hold sweep (moved out of `app.ts`), and later phases' jobs.
- **2.16 `[BE]`** Remove the `setInterval` hold sweep from `app.ts` (moved to the worker). Add the `package.json` scripts `dev:worker` and `start:worker`, and a turbo `dev` task that runs both.
- **2.17 `[PLAT]`** Add a `render.yaml` **background worker** service `c1rcle-payments-worker` (same image, `node dist/worker.js`, same env group). Update the `Dockerfile` if the entry differs, and update `deploy/staging/validate-environment.mjs` to validate the worker env.

### 2E. Correlation ids and observability base (24)
- **2.18 `[BE]`** Extend `lib/request-tracing.ts`:
  - Accept a client `X-Correlation-Id` only if it is a valid UUID; otherwise generate one.
  - Echo it in the response and put it on `request.correlationId`.
  - Add it to the logger child bindings and pass it into `ActorContext` (`application/context.ts` gains `correlationId`).
- **2.19 `[BE]`** Propagate the correlation id into outbox envelopes, provider `notes`, audit records and (later) journal entries. Worker jobs create a new correlation id per task and set `causationId`.
- **2.20 `[BE]`** Add log redaction in `lib/logger-config.ts`: redact `signature`, `x-razorpay-signature`, `accountNumber`, `ifsc`, `card`, `vpa`, secrets, and mask email and phone.

### 2F. Hash-chained audit trail (29)
- **2.21 `[BE]`** Create `domain/models/audit-entry.ts` (fields per 29: `auditId, at, actor{type,id,role}, action, subject, before, after, reason, approvalId, correlationId, ip, userAgent, result, hash, prevHash`) and `application/audit/audit-trail-service.ts`, the single `append()`.
  - The chain head lives in `v2_audit_chain_head`, updated in the same transaction.
  - `hash = sha256(canonicalJson(record without hash) + prevHash)`.
- **2.22 `[BE]`** Firestore and memory adapters for `v2_audit_log`. Make `AdminAuditRepository` write through `AuditTrailService` (keep the `v2_admin_audit_logs` reads for history and backfill the chain from now on).
- **2.23 `[BE]`** `firestore.rules`: deny all client reads and writes on `v2_audit_log`, `v2_outbox`, `v2_inbox`, `v2_journal_*`, `v2_ledger_legs`, `v2_payments*`, `v2_payouts`, `v2_beneficiaries`, `v2_refund_requests` and the other payment collections (service-account only). Add emulator rules tests.

### Test
- **2.24** Crash test: throw after the business write but before commit, and assert no outbox row. Commit, kill before relay, restart, and assert the event is delivered exactly once to each consumer.
- **2.25** Duplicate and out-of-order delivery to the inbox causes no double effect.
- **2.26** Audit chain verification detects a modified record and a deleted record.
- **2.27** Correlation id is present on the response header, the log line, the outbox row and the audit row for one request.

**Exit gate:** illegal transitions are rejected (2.8); a crash between commit and publish loses no event (2.24); one id traces a request (2.27); the worker runs on staging with a lease.

---

## Phase 3 — Payment simulator and invariant harness v1 (31, 3.2)

**Goal:** 4–11 are tested against injected failures, not just happy paths. **Depends on:** 1, 2.

### Create
- **3.1 `[BE]`** Refactor the provider ports (prerequisite for the simulator):
  - `domain/ports/payment-provider.ts`: `createOrder`, `verifyCheckoutSignature`, `getPayment`, `listPaymentsForOrder(providerOrderId)`, `refundPayment`, `getRefund`, `capabilities()`.
  - `payout-provider.ts`: `createBeneficiary`, `createPayout({beneficiaryRef, amountPaise, idempotencyKey, reference, narration})`, `getPayout`, `capabilities()`.
  - `subscription-provider.ts`: signatures only, implemented in 19.
  - `reconciliation-port.ts`: `fetchSettlementReport(date)`, `fetchPayments(range)`, `fetchRefunds(range)`.
  - `ProviderCapabilities { provider, methods[], partialRefunds, payouts, route, subscriptions, currencies[], minAmountPaise, settlementCycleDays }`.
- **3.2 `[BE]`** Create `infrastructure/simulator/payment-simulator.ts`, implementing all ports plus a `WebhookEmitter` that produces correctly signed Razorpay-shaped payloads.
  - Seeded, scripted scenarios: success; each failure class; slow response; **timeout after capture**; duplicate, delayed, lost and out-of-order webhooks; wrong amount or order; invalid signature; unknown fields; partial refund; refund failed; payout failed or returned; short or missing settlement; dispute lifecycle; 429/5xx; full outage.
  - Generates settlement and bank files with injected mismatches.
- **3.3 `[BE]`** Replace `MemoryPaymentProvider` usage in `v2-services.ts` with the simulator (`STORAGE_DRIVER=memory` or `PAYMENT_PROVIDER=simulator`). Keep the `simulateCapture` escape hatch as `simulator.script(...)`.
- **3.4 `[BE]`** Add non-production simulator control routes `POST /api/v2/internal/simulator/scenarios` and `/simulator/webhooks/emit`. They are registered **only** when `NODE_ENV !== 'production'` and the simulator is the active provider, so they 404 by absence otherwise.
- **3.5 `[BE]`** Create `application/invariants/invariant-checker.ts`: a pluggable registry of `Invariant { id, check(deps): Promise<Violation[]> }`. In this phase it registers **I3, I5, I7, I11** (others land with their data in 6/9). Expose a test helper `assertAllInvariants()`.
- **3.6 `[BE]`** Create the **adapter contract-test suite** `packages/core/src/infrastructure/provider-contract.suite.ts`, run against the simulator now and the Razorpay adapter (recorded fixtures, `nock`-style fetch stub) from 1.

### Test
- **3.7** Scenario tests for: success, timeout-after-capture, duplicate webhook, out-of-order webhook, wrong amount. Each ends with `assertAllInvariants()`.

**Exit gate:** the contract suite passes on the simulator and the Razorpay fixtures; a scenario can be scripted in one line inside any service test.

---

## Phase 4 — Payment service and recoverable fulfilment (2, 4, 8 webhook part)

**Goal:** a worker killed mid-step still completes the order, and every captured payment ends with an order or a recorded refund. **Depends on:** 1, 2, 3.

### 4A. Contracts (freeze for the frontend)
- **4.1 `[BE]`** `packages/contracts/src/contracts/checkout.ts`:
  - Hold request: add `attendee: { name, email, phone }` (zod email and E.164 phone).
  - Quote response: add the full breakdown `{ lines[], subtotalPaise, discountPaise, discountType, couponCode, platformFeePaise, paymentFeePaise, gstPaise, grandTotalPaise, currency, holdTtlSeconds }`.
  - Attempt response: add `{ paymentId (local), providerOrderId, amountPaise, currency, keyId, holdExpiresAt, prefill: {name,email,contact}, notes }`.
  - Add `GET /payments/:paymentId/status` returning `{ status: processing|paid|failed|expired|refunded, orderId? }`.
  - Run `scripts/export-contracts.mjs` and `pnpm contract-parity`.

### 4B. Domain
- **4.2 `[BE]`** Create the `domain/models/payment.ts` aggregate: `id, holdId, userId, provider, providerOrderId, providerPaymentId?, amountPaise, currency, status (15 Payment), method?, methodDetails?, refundedPaise, disputed, stateHistory, correlationId`, plus a unique index `provider+providerPaymentId` (invariant I7).
- **4.3 `[BE]`** Create `domain/models/payment-attempt.ts` (one per `POST /payments/attempts`): `id, paymentId, holdId, providerOrderId, idempotencyKey, createdAt`.
- **4.4 `[BE]`** Modify `cart-reservation.ts`:
  - Status becomes the 15 Hold machine (`active, payment_pending, converted, expired, released`).
  - Add `providerOrderId`, `attendee`, `commissionBpsSnapshot`, `splitSnapshot` (filled in 5), `feeRatesSnapshot`, `discountType`, `discountSource`.
  - Data migration: `released` stays as is; expired holds are swept to `expired`.
- **4.5 `[BE]`** Modify `order.ts`:
  - Status set: guide 15 Order (`paid, fulfilling, fulfilled, cancelled`) plus `refundedPaise` and a `disputed` flag. Keep the `refund_requested` lock (an existing, proven invariant) as an Order **lock flag** `refundLock: refundId|null` instead of a status, so it composes with `fulfilled`.
  - Add `fulfilmentSteps: Record<'order_saved'|'hold_converted'|'promo_recorded'|'tickets_issued'|'ledger_written'|'referral_recorded'|'notified', {doneAt, attempt}>`, `paymentRecordId`, and the 14 financial record fields (`venueId, hostIds, promoterId?, ticketType, quantity, discountType, discountAmount, couponCode, platformFee, customerFee, gst, paymentStatus, paymentMethod`).
  - Write a migration script for existing `v2_orders` (`awaiting_payment/pending` → leave; `paid` → `fulfilled` with all steps marked done).

### 4C. Services
- **4.6 `[BE]`** Create `application/payments/payment-service.ts` (S3):
  - `createAttempt(actor, holdId, idemKey)`:
    - Assert `actor.userId === hold.userId`; hold `active`, not expired, and pre-checkout validation passes (4.10).
    - Call `provider.createOrder`.
    - In one UoW: create the Payment (`created→attempted`), the Attempt, and compare-and-set the hold to `payment_pending` with `providerOrderId`, plus outbox `PaymentAttempted`.
    - On a retry with the same key, return the existing attempt (no new provider order).
  - `verifyCallback(actor, {paymentId, providerOrderId, signature})`: check the signature with the key secret, then `fulfilment.confirmPayment(..., source:'callback', actor)`.
  - `getStatus(actor, paymentId)`: owner-scoped.
- **4.7 `[BE]`** Create `application/fulfilment/fulfilment-service.ts` (S4) `confirmPayment({ providerPaymentId, providerOrderId, source, actor? })`:
  1. Fetch the provider payment. Require `captured`, the exact `amountPaise` and `currency`, and `payment.providerOrderId === hold.providerOrderId` (looked up by `providerOrderId`, never by caller-supplied holdId alone). On the callback path also require `actor.userId === hold.userId`.
  2. **One transaction** (UoW): order (`id = ORD-{providerPaymentId}`, contact = hold.attendee) created `paid`; Payment `captured`; hold `converted`; promo redemption **only if `appliedPromoCode`** (fixes audit #18); entitlements honouring `admitsPerUnit` from tier metadata (fixes audit #17, reading `TicketTier.admitsPerUnit`/couple flag); steps `order_saved, hold_converted, promo_recorded, tickets_issued` marked; outbox `PaymentCaptured`, `OrderPaid`, `TicketsIssued`.
  3. If the order already exists, **resume**: run the first incomplete step (never return early).
  4. Post-commit work happens via outbox consumers: `ledger_written` (5/6 consumer), `referral_recorded` (referral + leaderboard consumer, moved out of `recordSettlement`), `notified` (QR email). Each consumer marks its step inside its own transaction with an inbox claim.
- **4.8 `[BE]`** Captured-after-expiry (2 correction 5), `fulfilment/late-capture-policy.ts`:
  - If the hold is `expired/released` but inventory remains (`InventoryService.getAvailableQuantity`), build the order from the **frozen** hold pricing.
  - Otherwise auto-refund through the refund executor path with reason `late_capture_no_inventory` (until 7 lands: create an `AdminRefundRequest` with `approversRequired=0` plus an ops alert and a recovery task) and emit `ExceptionOpened`.
- **4.9 `[BE]`** Slim `CheckoutService` (S2): delete `createPaymentIntent`/`confirmPayment`/`recordSettlement` (moved to S3, S4 and S5). Keep `quote`, `createHold` and `settleOrder` → delegate to S5 (the door-sale path still uses it; update `door-ticket-sale-service.ts`).
- **4.10 `[BE]`** Pre-checkout validation, `checkout/pre-checkout-validator.ts`, called by `createHold` and `createAttempt`. Reject when:
  - the event is cancelled, ended or not published;
  - (from 8) the host/venue beneficiary is not `verified`;
  - the hold is expired or not the caller's;
  - the split config is missing or invalid (from 5);
  - `PAID_CHECKOUT_ENABLED` is off.

  Each case has a typed error code mapped in `plugins/error-handler.ts`.

### 4D. Webhook path (provider inbox)
- **4.11 `[BE]`** Create `application/webhooks/provider-event-ingestor.ts` (S11) plus `v2_provider_events`:
  - Persist `eventId (x-razorpay-event-id), type, payloadHash, receivedAt, processedAt, status, error, provider`, deduplicating on `eventId`.
  - Ignore events older than ~5 minutes at ingestion unless they arrive through a replay.
  - Map to a canonical `ProviderEvent` (25).
  - Respond 200 fast, then process via the outbox (`ProviderEventReceived`) in the worker.
- **4.12 `[BE]`** Modify `routes/v2/checkout/webhook-routes.ts`: keep the raw body and HMAC; replace the inline `confirmPayment` with `ingestor.ingest(rawBody, headers)`. Handlers in `application/webhooks/handlers/`: `payment-captured.ts` → `confirmPayment`; `payment-failed.ts` → Payment `failed`, hold stays `active` (back from `payment_pending`); unknown types → recorded, 200.
- **4.13 `[BE]`** Modify `routes/v2/checkout/payment-routes.ts`: thin calls to S3 (`createAttempt`, `verifyCallback`, `getStatus`); the `Idempotency-Key` is required on attempts.

### 4E. Polling fallback and repair (pre-10 minimal)
- **4.14 `[BE]`** Worker job `payments-poller` (every 5 minutes):
  - Select holds in `payment_pending` with a `providerOrderId`, no order, created within the last hour.
  - Call `provider.listPaymentsForOrder` and `confirmPayment` if any are `captured`.
  - Use small batches with rate-limit backoff; log every recovery and alert on repeats.
- **4.15 `[BE]`** Worker job `fulfilment-repair` (every 2 minutes): orders with an incomplete step older than `FULFILMENT_STALL_SECONDS` run their first incomplete step. This is folded into the RecoveryEngine in 10.
- **4.16 `[BE]`** Worker job `captured-without-order` (daily): `reconciliationPort.fetchPayments(yesterday)` lists captured payments with no order, then triggers `confirmPayment` or the late-capture policy and alerts.

### Test (13)
- **4.17** Callback only; webhook only; both racing (memory + emulator) produce one order and one set of tickets.
- **4.18** Tampered signature; wrong order id; wrong amount; wrong currency; wrong user on callback.
- **4.19** Crash after each fulfilment step (fault injection hook in UoW and consumers), then repair, then a fully fulfilled order with `assertAllInvariants()`.
- **4.20** Captured after expiry, both with inventory left and with it sold out.
- **4.21** Payment failed, then a retry attempt on the same hold succeeds; a duplicate attempt with the same key returns the same provider order.
- **4.22** Attendee contact persists to the order (not `guest@example.com`); couple tier issues admits=2.

**Exit gate:** 4.17–4.22 green; one real test-mode purchase on staging through the 1 harness produces a `fulfilled` order with all steps done (`ledger_written` is a no-op placeholder until 5/6).

---

## Phase 5 — Settlement engine and event split config (3)

**Goal:** legs always sum to the grand total; a plan or split change never alters old orders. **Depends on:** 4.

### Create
- **5.1 `[BE]`** `domain/models/settlement.ts` with the pure `computeSettlementLegs(input)`, exactly per 3:
  - Inputs: `grandTotal, subtotal, customerFees, gst, commissionBps, split {model:'venue_owned'|'host_owned', venueBps, hosts:[{beneficiaryId, shareBps}]}, promoter? {beneficiaryId, amountPaise}`.
  - `commission = round(subtotal*commissionBps/10000)`.
  - `promoter = min(promoterAmount, subtotal-commission)`.
  - `distributable = subtotal - commission - promoter`.
  - `venue = round(distributable*venueBps/10000)`.
  - `hostTotal = distributable - venue`, split across hosts by `shareBps` with the remainder paisa to the first host.
  - `platformCustomerFee = customerFees + gst`.
  - Returns legs `customer_fee, platform_commission, venue_share, host_share[], promoter_commission` and asserts the invariants: legs sum to `grandTotal`, no negative leg.
- **5.2 `[BE]`** `domain/models/event-split.ts`: `EventSplitConfig { eventId, model, venueBps, hosts[], lockedAt|null, version, history[] }`. Validation: `venueBps + hostSide = 10000`, host shares sum to 10000, every beneficiary id resolves. Collection `v2_event_splits`.
- **5.3 `[BE]`** `domain/ports/plan-resolver.ts`: `commissionBps(venueOrgId): Promise<number>`. The **default implementation** reads `PLAN_COMMISSION_BPS` by org plan (`Organization` plan, default `basic` → 0). Phase 19 swaps in the subscription-backed resolver.
- **5.4 `[BE]`** `application/settlement/settlement-service.ts` (S5):
  - Snapshot at **hold** time: `commissionBps`, `splitSnapshot`, and promoter attribution amount (wired into `CheckoutService.createHold`, written on the hold; 4.4 fields).
  - At fulfilment, the `ledger_written` consumer calls `computeSettlementLegs(snapshot)`, writes `order.settlement = {legs, computedAt, inputsHash}` **once**, and hands the legs to S6 (6). Until 6 lands, this writes to the existing `FinanceService.recordTicketSale` via an adapter that maps legs to `LedgerEntry` rows (temporary, removed in 6.9).
- **5.5 `[BE]`** `application/events/event-split-service.ts`:
  - `getSplit`, `setSplit` (organiser; the default is seeded from `Partnership.venueShareRate × 100` bps, a host-owned 100% single host when there is no partnership).
  - `lockSplit` is called from fulfilment on the first paid order (same transaction).
  - `overrideSplit` requires a maker-checker approval; it creates an approval request once 10 lands, until then it needs a TIER3 propose→resolve.

### Modify
- **5.6 `[BE]`** `domain/models/pricing.ts`: fee rates come from the injected `feeConfig` (bps) instead of the `PLATFORM_FEE_PERCENT` constants. `applyPercent` is replaced by `applyBps(paise, bps) = Math.round(paise*bps/10000)` (keep half-up). The quote snapshot stores the bps used. Keep `assertReconciles`.
- **5.7 `[BE]`** `application/events/event-service.ts` publish: for events with paid tiers, require a valid `EventSplitConfig` (and, from 8, verified beneficiaries) and return a typed error listing what is missing.
- **5.8 `[BE]`** Deprecate `computeSettlementSplit`, `PLAN_TIER_PLATFORM_FEE_RATE` and `platformFeeRateForTier` (`ledger.ts`) and `platformFeePercentFor` usage in settlement (DP-01). Keep them only for reading historical rows; add `@deprecated` JSDoc and a lint ban on new imports.

### Contracts and routes
- **5.9 `[BE]`** Contracts in `packages/contracts/src/contracts/payments.ts`: `eventSplitSchema`, `setEventSplitRequestSchema`, the settlement legs DTO on the order. Routes: `GET/PUT /organizations/:organizationId/events/:eventId/split` (Idempotency-Key, If-Match; 409 `split_locked` after the first sale).

### Test (13 rounding cases)
- **5.10** The guide's worked example (₹1,000, 80/20 host-owned, 10% promoter, 0 commission → host 720, venue 180, promoter 100, fee 75, GST 13.50, total 1,088.50) passes exactly.
- **5.11** **Property-based** tests (`fast-check`, new devDependency) over random subtotals, promos, 1–5 hosts, venue/host-owned, promoter above the distributable, and non-zero commission: the sum always equals the grand total, no negative legs, and the remainder goes to the first host.
- **5.12** A plan change after purchase leaves the old order's legs unchanged; a split edit after the first sale returns 409.

**Exit gate:** 5.10–5.12 green; contracts exported; every paid test order on staging has `order.settlement`.

---

## Phase 6 — Double-entry journal, sub-ledger legs, invariants (3, 3.1, 3.2)

**Goal:** the trial balance is zero; a breach trips payout and refund flags. **Depends on:** 5.

### Create
- **6.1 `[BE]`** `domain/models/chart-of-accounts.ts`: the starter chart from 3.1 (1100…5300) as data, with `type` and `perProvider`/`perBeneficiary` flags.
- **6.2 `[BE]`** `domain/models/journal.ts`: `JournalEntry { entryId, postingKey, eventType, sourceType, sourceId, correlationId, currency, effectiveDate, period, createdBy, approvalId?, reversalOf? }` and `JournalLine { entryId, accountId, direction, amountPaise>0, beneficiaryId?, orderId?, eventId?, provider? }`. `assertBalanced(lines)`.
- **6.3 `[BE]`** `domain/models/ledger-leg.ts`: `LedgerLeg { id, orderId, eventId, leg, beneficiaryId, beneficiaryType, amountPaise, currency, state (15 leg machine), releaseAfter, payoutId, reversalOf, riskHold, disputeHold, idempotencyKey=orderId+leg+beneficiary }`.
- **6.4 `[BE]`** `domain/models/posting-rules.ts`: a pure function per event from the 3.1 table (`paymentCaptured`, `settlementReceived`, `refundBeforePayout`, `eventCancelled`, `payoutRequested`, `payoutPaid`, `payoutFailed`, `payoutReturned`, `refundAfterPayout`, `recoveryFromPayout`, `disputeOpened/Won/Lost`, `subscriptionCharged`). Each returns `{lines[], legChanges[]}`.
- **6.5 `[BE]`** `application/ledger/ledger-posting-service.ts` (S6), the **only writer**. `post(eventType, source, ctx)`:
  - Builds the lines via posting rules and asserts the entry balances (I1).
  - Rejects if the period is closed (I12).
  - Inside one UoW: writes the entry, the lines and the leg changes (via the leg FSM), increments `v2_account_balances/{account}:{beneficiary?}`, appends the outbox `JournalPosted`/`LegsHeld`, and claims `postingKey` uniquely.
- **6.6 `[BE]`** Repos plus Firestore and memory adapters: `JournalRepository` (`v2_journal_entries`, `v2_journal_lines`), `LedgerLegRepository` (`v2_ledger_legs`), `AccountBalanceRepository` (`v2_account_balances` plus a daily snapshot subcollection). Add the composite indexes to `firestore.indexes.json` (legs by `beneficiaryId+state`, `eventId+state`, `orderId`; lines by `accountId+effectiveDate`).
- **6.7 `[BE]`** Invariants I1, I2, I4, I8, I9, I10 (journal part), I11 and I12 in `application/invariants/`; worker jobs `invariants-hourly` (sample I1, I4, I8, I9, I11) and `invariants-daily` (full I1, I2, I10).
  - **On breach:** severity critical; `FeatureFlagService.trip('AUTO_PAYOUTS_ENABLED')` and `trip('REFUND_EXECUTOR_ENABLED')`; emit `InvariantBreached`; open a recon exception (placeholder collection until 11); block period close.
  - Write `v2_invariant_runs`.

### Modify
- **6.8 `[BE]`** The `ledger_written` fulfilment consumer (from 5.4) calls `posting.post('payment_captured', order)` (legs `held`, platform legs `earned`) instead of the temporary `recordTicketSale` adapter.
- **6.9 `[BE]`** Rewrite `application/finance/finance-service.ts` (S7) as **read-only**: `getBalances(beneficiary)` = sums of legs by state (`held`, `releasable`, `payout_requested`, `paid`); `listLegs`; dashboard stats (earned, paid out, pending, last payout) computed from the ledger. Delete `recordTicketSale` once every caller is migrated (door sales included: `door-ticket-sale-service.ts` → `settlementService.settle(order)`).
- **6.10 `[BE]`** Migration script `apps/api-gateway/src/scripts/migrate-partner-ledger-to-journal.ts`. It is idempotent and resumable: it reads `v2_partner_ledger` and creates opening-balance journal entries plus legs (`pending`→`held`, `settled`→`earned`/`releasable`, `paid_out`→`paid`). It writes a reconciliation report; running it twice changes nothing.
- **6.11 `[BE]`** Finance routes (`routes/v2/finance/finance-routes.ts`) and contracts (`phase6.ts`): balances and ledger list now return leg-based DTOs. **Add** new fields rather than removing old ones in this phase, so the FE keeps working until 17.

### Test
- **6.12** Every posting rule balances, including **property-based** random splits through `paymentCaptured → refund → payout` sequences, keeping the trial balance at 0.
- **6.13** Each of I1–I12 that has data by now can be **deliberately broken** in a test and is caught; a breach trips both flags.
- **6.14** Duplicate posting key changes nothing; reversal entries reference the original; there is no update or delete path on entries (repository has no such method; rules test).

**Exit gate:** trial balance is zero on staging after a scripted day of simulator traffic; migration dry run on a staging copy has zero differences; breach drill trips the flags.

---

## Phase 7 — Refund executor and refund webhooks (7, 8)

**Goal:** an approved refund returns money and reconciles. **Depends on:** 6.

### Modify
- **7.1 `[BE]`** `domain/models/refund-request.ts`:
  - Status becomes the 15 Refund machine. Map `pending`→`requested` (data migration) and add `processing`, `manual`, `failed→approved` (retry).
  - Fields: `providerRefundId`, `idempotencyKey = refund:{id}`, `feePolicy`, `kind: 'customer'|'event_cancellation'|'late_capture'`, `evidence[]` (for `manual`).
  - Keep the N-approver logic and the `hasRedeemedEntitlement` rule.
- **7.2 `[BE]`** `RefundService.approve`, after the last approval: emits `RefundApproved` (outbox) instead of stopping. Remove the "nothing settles" comment and replace it with a pointer to the executor.

### Create
- **7.3 `[BE]`** `application/refunds/refund-executor.ts` (S8), the consumer of `RefundApproved`, gated by `REFUND_EXECUTOR_ENABLED` (when off: stays `approved` and shows in the "refund manually" ops list).
  - Check I5 in the transaction (refunds ≤ captured), then `approved→processing`.
  - Call `provider.refundPayment({ paymentId, amountPaise, idempotencyKey })` and store `providerRefundId`.
  - Transient error: retry via a recovery task. Permanent error: `failed`, alert.
- **7.4 `[BE]`** Webhook handlers `refund-created.ts` (Refund `processing`; customer status "refund initiated"), `refund-processed.ts` and `refund-failed.ts`. On **processed**, in one UoW:
  - Refund `settled`; Payment `partially_refunded|refunded`; `order.refundedPaise += amount`; Order `cancelled` if full.
  - Void entitlements proportionally (newest unredeemed first; never a redeemed one without approval).
  - Ledger: `refundBeforePayout` (cancel `held` legs proportionally, reverse promoter commission), or `refundAfterPayout` (1300 Recoverable per DP-04), with fees per `FEES_REFUNDABLE_ON_REFUND`.
  - Release the order refund lock; notify the customer.

  On **failed**: `processing→failed→approved` (retry) with an alert; the order stays locked.
- **7.5 `[BE]`** `application/refunds/event-cancellation-refunds.ts`. On `event.cancelled` (existing domain event), a bulk executor creates `kind:'event_cancellation'` refunds for all `paid/fulfilled` orders (fees refunded, all legs cancelled). It is batched, resumable via recovery tasks, and needs an admin maker-checker approval to start (10; until then TIER3).
- **7.6 `[BE]`** Admin route `POST /admin/refunds/:id/manual` (operator refunded in the Razorpay dashboard): records `providerRefundId` and evidence, moves to `manual`, and posts the same ledger effects. Needs a checker.

### Test
- **7.7** Before payout: full, partial, and two partials summing to the total. After payout: recoverable created. Cancellation bulk. Failed then retry. Duplicate `refund.processed`. Fee variants. A refund exceeding captured is rejected (I5). Every case ends with `assertAllInvariants()`.

**Exit gate:** on staging with the Razorpay test account, an approved ₹600 refund shows `settled` with `providerRefundId`, the journal balances, and the partner balance drops accordingly.

---

## Phase 8 — Beneficiary onboarding and publish gate (backend) (6, 11 banking)

**Goal:** an unverified organisation cannot publish a paid event. **Depends on:** 2, 6.

### Create
- **8.1 `[BE]`** `domain/models/beneficiary.ts`:
  - Fields: `{ id, ownerType: venue|organisation|individual, ownerId (orgId or promoter orgId), organiserType: individual|company|venue, kycStatus: not_started|pending|verified|rejected|suspended, kycDocuments[], providerRef?, fundAccountRef?, bankLast4, ifsc, accountHolderName, accountNumberCipher, accountNumberBlindIndex, verifiedAt, verificationMethod, coolingUntil? }`.
  - FSM for `kycStatus`.
- **8.2 `[BE]`** `application/beneficiaries/beneficiary-service.ts` (S9), evolving `bank-account-service.ts`:
  - `submitBankAccount` (encrypt with existing `encryption.ts` now, KMS in 15; **blind index** = HMAC-SHA256 of the normalised account number with `BLIND_INDEX_KEY`).
  - `getStatus(ownerType, ownerId)`; `markVerified` (admin, or a provider penny-drop/fund-account validation callback when DP-05 picks an API rail); `reject`.
  - **Bank detail change:** re-verification plus a checker (10), with `coolingUntil = now + BANK_CHANGE_COOLING_HOURS`, during which payouts are held.
  - Reuse the existing KYC documents from onboarding (`domain/models/onboarding.ts`) where present; don't ask twice.
- **8.3 `[BE]`** Migration: `v2_bank_accounts` becomes `v2_beneficiaries` (one per org default account; `verified` maps to `kycStatus`). Keep the old collection read-only for one release.
- **8.4 `[BE]`** Routes and contracts (`packages/contracts/src/contracts/banking.ts`):
  - `GET /banking/status/:ownerType/:ownerId` (owner or admin).
  - `POST /banking/accounts` (Idempotency-Key).
  - `GET /banking/onboarding-link` (404 by absence unless the rail supports hosted KYC).
  - Admin: `POST /admin/beneficiaries/:id/verify|reject`.
  - Responses only ever contain `bankLast4`.
- **8.5 `[BE]`** Publish gate: `event-service.ts` publish and `pre-checkout-validator.ts` require every beneficiary in the event's split (host or hosts, venue, and the promoter **only if** attribution exists at purchase time) to be `verified`. If the promoter is unverified, attribution is still recorded but the commission leg is `held` with `riskHold='kyc_pending'`.

### Modify
- **8.6 `[BE]`** `finance-routes.ts` bank-account endpoints become thin proxies to S9 for backward compatibility (mark deprecated in the contracts).

### Test
- **8.7** Publishing a paid event with an unverified venue returns 422 `beneficiary_unverified`; a free event publishes. The account number never appears in a response or a log (redaction test). The blind index detects a duplicate account across two orgs.

**Exit gate:** 8.7 green; existing staging orgs migrated and visible with their KYC status.

---

## Phase 9 — Event completion, release job, payouts (6, 15 Payout)

**Goal:** a test event pays each beneficiary exactly once, retry-safe. **Depends on:** 6, 8, and decision DP-08 answered.

### Create
- **9.1 `[BE]`** Event completion (DP-07):
  - `Event.completedAt` and `POST /organizations/:org/events/:id/close-out` (organiser).
  - Worker job `event-auto-complete` (`endsAt + EVENT_AUTO_COMPLETE_HOURS`).
  - Emit `EventCompleted`.
- **9.2 `[BE]`** Rewrite `domain/models/payout.ts`:
  - Status set: the 15 Payout machine (`scheduled, pending_approval, approved, processing, paid, failed, returned, frozen, cancelled`).
  - Fields: `beneficiaryId, eventId?, legIds[], amountPaise, idempotencyKey = payout:{eventId}:{beneficiaryId}` (or `payout:batch:{yyyymm}:{beneficiaryId}`), `providerPayoutId`, `utr`, `failureReason`, `attempts`, `evidence[]`, `previousStatus` (keep the freeze/release semantics).
  - Migrate `requested→scheduled`. `processing` and `paid` keep their meaning, but a `paid` without a UTR is flagged.
- **9.3 `[BE]`** `domain/models/payout-settings.ts` plus `v2_payout_settings`: `autoPayout (true)`, `minPayoutThresholdPaise (10000, the current ₹100)`, `payoutMode per_event|monthly_batch`, `preferredPayoutDay 1–28`, `maxHoldDays`.
- **9.4 `[BE]`** `application/payouts/release-job.ts` (S10), worker job (hourly):
  1. For events with `completedAt + PAYOUT_RELEASE_WINDOW_HOURS ≤ now`, select `held` legs excluding refunded, `refund_requested` lock, disputed, frozen, `riskHold`, or beneficiary not verified or in cooling; post `LegsReleasable`.
  2. Group by beneficiary and event (or monthly batch), skip below the threshold (roll over), create the payout with the key above, legs → `payout_requested` (I6 checked in the transaction), posting `payoutRequested` (2110/2100/2120 → 1120).
  3. `scheduled→pending_approval` if above the `APPROVAL_POLICY` threshold, else `approved`.
  4. Mark the event's payout status `partial` until all are paid.
- **9.5 `[BE]`** `application/payouts/payout-executor.ts`, the consumer of `PayoutApproved`, gated by `AUTO_PAYOUTS_ENABLED` (off means it stays `approved` in the "pay manually" report).
  - `approved→processing`, then `payoutProvider.createPayout({ idempotencyKey })`.
  - Provider webhook (`payout.processed/failed/reversed`) or operator confirmation `POST /admin/payouts/:id/mark-paid {utr, evidence}` (needs a checker) → `paid` (post `payoutPaid` 1120 → 1110) or `failed` (reverse the request; legs back to `releasable`; retry with backoff, then DLQ in 10) or `returned` (post `payoutReturned`).
  - Never mark `paid` without provider confirmation or evidence.
- **9.6 `[BE]`** `domain/ports/payout-provider.ts` implementations:
  - `ManualPayoutProvider` (DP-05 default: creates an "instruction" record, status stays `processing` until an operator marks it paid).
  - `apps/api-gateway/src/lib/payments/razorpay-payout-adapter.ts` (RazorpayX: contacts, fund accounts, payouts, `X-Payout-Idempotency` header) behind config `PAYOUT_RAIL=manual|razorpayx`.
  - Simulator support (3).
- **9.7 `[BE]`** Recovery-from-payout: when building a payout, net it against the beneficiary's 1300 Recoverable balance (post `recoveryFromPayout`); a payout can be reduced to 0 (I8).

### Modify
- **9.8 `[BE]`** `payout-service.ts`: `requestPayout` (partner) now triggers the release job for that beneficiary (DP-06). Remove the direct `beginProcessing/completePayout` API from partner scope.
- **9.9 `[BE]`** `admin-payout-service.ts`: `runBatch` becomes "release now for event X" (`POST /admin/payouts/release/:eventId`, audited); keep freeze/unfreeze (unfreeze needs a checker); add `retry` and `approve`.
- **9.10 `[BE]`** Routes and contracts (`payouts.ts`): `GET /payouts/me`, `GET /payouts/order/:orderId`, `GET /admin/payouts?status=`, `POST /admin/payouts/release/:eventId`, `POST /admin/payouts/:id/{retry,freeze,unfreeze,approve,mark-paid}`, and `GET/PUT /organizations/:org/payout-settings`.
- **9.11 `[BE]`** Payment notification consumers (9): payout released or failed → venue, host, promoter; KYC incomplete or rejected → beneficiary. They live in `application/notifications/payment-consumers.ts`, keyed by event id.

### Test
- **9.12** One payout per beneficiary per event, even with the job run concurrently twice. Failure → retry → success. Frozen beneficiary skipped. Dispute hold blocks release. Monthly batch mode. Below-threshold roll-over. Returned after paid. Recovery netting. Invariants I4, I6 and I8 hold after each case.

**Exit gate:** a staging test event with host, venue and promoter releases three payouts (manual rail), marked paid with a UTR, and the journal balances; the RazorpayX adapter passes the contract suite on fixtures.

---

## Phase 10 — Maker-checker, recovery engine + DLQ, Ops console APIs (17, 19, 20)

**Goal:** money-out actions need a checker; stuck items surface and replay safely. **Depends on:** 2, 7, 9.

### 10A. Maker-checker (generalise admin-authority)
- **10.1 `[BE]`** `domain/models/approval-request.ts`: `{ id, action, subject, payload, payloadHash, amountPaise, makerId, requiredApprovals, requiredRoles, approvals[], status: pending|approved|rejected|expired|executed, expiresAt, reason, executedAt }`. Rules: the checker is never the maker, roles must match, and expiry defaults to 24h.
- **10.2 `[BE]`** `application/approvals/approval-service.ts` (S13):
  - `request(action, payload, maker)`, `approve(id, checker, reason)`, `reject`.
  - `execute(id)` runs **exactly** the stored payload once (recomputing `payloadHash` must match) through a registry `ApprovalActionHandler` per action.
  - Policy comes from `APPROVAL_POLICY`.
- **10.3 `[BE]`** Migrate the TIER3 `v2_proposed_actions` (`PAYOUT_FREEZE`, `PAYOUT_RELEASE`, `COMMISSION_ADJUST`, `ADMIN_*`) onto ApprovalService. `admin-authority.ts` keeps the tier/role checks but delegates dual control. The refund N-approver accumulator stays in RefundService but uses the same "maker ≠ checker" helper.
- **10.4 `[BE]`** Register the actions from the 20 table: payout approve above threshold, manual release, unfreeze, mark-paid, ledger adjustment, write-off, bulk DLQ replay, DLQ discard, split override, commission/plan/fee/GST table change, bank detail change, risk-hold release, enabling `AUTO_PAYOUTS_ENABLED`/`REFUND_EXECUTOR_ENABLED`, period close. **Safety actions** (freeze, pause, hold, flag trip) stay single-actor.
- **10.5 `[BE]`** Routes: `GET /admin/approvals`, `POST /admin/approvals/:id/approve|reject` (contracts `admin-approvals.ts`).

### 10B. Recovery engine and DLQ
- **10.6 `[BE]`** `domain/models/recovery-task.ts` (`v2_recovery_tasks`) and `dead-letter.ts` (`v2_dead_letters`), per 17.
- **10.7 `[BE]`** `application/recovery/recovery-engine.ts` (S18), a worker job (every minute):
  - Task types: stalled fulfilment, captured without order, payment stuck, refund/payout stuck in `processing`, missing webhook, outbox stuck, subscription drift (stub until 19), journal imbalance/custody breach (**no auto-fix**; goes to the DLQ as critical).
  - Backoff from `RECOVERY_BACKOFF` with jitter and a per-type max; every attempt reuses the original idempotency key; permanent errors go straight to the DLQ.
  - **Folds in** the 4.14–4.16 jobs and the payout retry.
- **10.8 `[BE]`** `application/recovery/dead-letter-service.ts`:
  - Any money DLQ item is P1.
  - Never auto-discard; discard needs a reason plus a checker.
  - Single replay by ops; bulk replay needs a checker.
  - Replay goes through the normal handler (inbox dedupe).
  - Metrics: depth, oldest age, replay success.
- **10.9 `[BE]`** Outbox relay and event bus failures after max attempts go to the DLQ (replaces `markFailed` as a silent end state).

### 10C. Ops console backend (19, 11)
- **10.10 `[BE]`** Admin roles: extend `AdminRole` with `risk` and `auditor`; keep `support` (read, masked), `ops`, `finance`, `admin`/`super`. Update `plugins/rbac.ts` with a permission matrix for every new admin route. **Every action requires `reasonCode` and writes an audit record.**
- **10.11 `[BE]`** Payment 360:
  - `GET /admin/payments/search?q=` (payment, order, refund or payout id, UTR, email, phone, event).
  - `GET /admin/payments/:id/timeline`: merges state history, provider events, webhooks, fulfilment steps, journal entries, risk decisions, approvals and audit by `correlationId`.
  - Masked by default; `POST /admin/reveal` with a reason is audited.
- **10.12 `[BE]`** `GET/POST /admin/dlq`, `/admin/dlq/:id/replay`, `/admin/dlq/:id/discard`, and a bulk replay that creates an approval.
- **10.13 `[BE]`** Controls: `GET/PUT /admin/controls/flags`. Enabling payout or refund flags needs an approval; disabling is single-actor.
- **10.14 `[BE]`** Health: `GET /admin/invariants` (last runs), `GET /admin/slo` (14 fills it), `GET /admin/providers/health` (13 fills it). Add the outbox lag and DLQ depth now.

### Test
- **10.15** Self-approval rejected; changed payload rejected; expired request; replay of an executed request is a no-op; DLQ replay does not double-apply; the recovery engine handles each task type with the simulator.

**Exit gate:** on staging, payout approval above the threshold requires a second finance user; a simulator "webhook lost" scenario recovers via polling and shows in the timeline.

---

## Phase 11 — Chargebacks, reconciliation, exceptions, settlement records (8, 14, 18)

**Goal:** every difference has an owner and a due date; a clean daily run has zero unexplained differences. **Depends on:** 6, 7, 9, 10.

### Create
- **11.1 `[BE]`** `domain/models/chargeback.ts` (`v2_chargebacks`), separate from the partner `Dispute`. Webhook handlers for `payment.dispute.created/.won/.lost`:
  - Created: Payment `disputed`, legs `disputeHold`, post `disputeOpened` (1100 → 1500), alert.
  - Won: `disputeWon`, release the holds.
  - Lost: Payment `charged_back`; the same as a refund plus 5200 for any fee; legs reversed (or 1300 if paid out).
  - Admin route to attach evidence.
- **11.2 `[BE]`** `domain/models/settlement-record.ts` (`v2_settlement_records`): `paymentId, settlementId, settlementDate, settlementStatus, payoutStatus, bankTransferStatus, utr, feePaise, taxPaise, failures[]`. Fed by `settlement.processed` webhooks and the daily report; posts `settlementReceived` (1110, 5100, 1400 / 1100).
- **11.3 `[BE]`** `apps/api-gateway/src/lib/payments/razorpay-reconciliation-adapter.ts`: Razorpay Settlements API (`/settlements`, `/settlements/recon/combined`), payments and refunds by date range, with paging and rate limits. The simulator implements the same port.
- **11.4 `[BE]`** `application/reconciliation/reconciliation-service.ts` (S12):
  - Checks R1 (gateway vs 1100 and payments), R2 (settlement vs bank credits by UTR), R3 (payouts vs payout provider and bank debits), R4 (journal payables vs legs and custody: I4, I9), R5 (subscription charges vs invoices: stub until 19).
  - Matching keys are `providerPaymentId`, `settlementId` and `utr`; supports 1:1, 1:N and N:1.
  - Exact amounts; fees within `RECON_TOLERANCE_PAISE` against a per-provider fee table.
  - In-transit window `SETTLEMENT_EXPECTED_DAYS` working days.
  - Worker jobs: `recon-hourly` (light) and `recon-daily` (full, by 09:00 IST).
- **11.5 `[BE]`** Bank statement ingestion (DP-11: file upload first): `POST /admin/reconciliation/bank-statements` (CSV/MT940 parser in `application/reconciliation/parsers/`), stored as `v2_bank_statement_lines`.
- **11.6 `[BE]`** `domain/models/recon-exception.ts` (`v2_recon_exceptions`, all fields and types from 18):
  - **Workflow:** auto-resolve benign cases (timing, rounding within tolerance) with a reason; route by type to Finance, Backend or Ops; `dueAt` from `EXCEPTION_SLA_HOURS`.
  - **Resolution:** evidence or an adjusting journal entry (via S6 with an `approvalId`); write-offs above the threshold need a checker.
  - **Repeat patterns** open a `problem` record.
- **11.7 `[BE]`** Routes: `GET/POST /admin/exceptions`, `/admin/exceptions/:id/assign`, `/admin/exceptions/:id/resolve`; `GET /admin/reconciliation/runs`.
- **11.8 `[BE]`** Notifications: payout failure, reconciliation mismatch and captured-without-order go to ops and finance (high priority).

### Test
- **11.9** The simulator generates settlement and bank files with injected mismatches (missing settlement, short settlement, fee mismatch, duplicate payment, refund without reversal, payout without UTR, unmatched bank credit, custody shortfall), and each is detected with the right type and severity. A dispute lifecycle (won and lost) keeps the invariants.

**Exit gate:** a seven-day simulated run reconciles with zero unexplained differences; every open exception has an owner and a `dueAt`.

---

## Phase 12 — Fraud, risk and promoter fraud v1 (21, 22)

**Goal:** rules run in shadow mode and are logged; flagged commissions are held. **Depends on:** 4, 6, 9.

### Create
- **12.1 `[BE]`** `domain/models/risk.ts`: `RiskRule { id, version, signal, params, weight, mode: shadow|enforced }`, `RiskDecision { id, point, subjectRef, inputs, ruleHits[], score, decision, ruleVersion, correlationId, outcome? }`, score bands from `RISK_SCORE_BANDS`.
- **12.2 `[BE]`** `application/risk/risk-service.ts` (S15), `evaluate(point, context)`:
  - Points: `hold_attempt` (sync, 150 ms budget: allow, challenge or block), `post_capture` (async: allow or review → hold tickets/payout), `pre_payout`, `pre_commission_release`.
  - **Fail-open to the built-in minimal rule set** (velocity caps plus blocklists) on timeout or error, and log the degradation.
- **12.3 `[BE]`** Signals (`application/risk/signals/`):
  - Attempts and failures per user, device hash, IP prefix and payment instrument over sliding windows (`v2_risk_counters` with TTL docs).
  - New account with a high-value order; country mismatch; repeat refunds or disputes; blocklists (`v2_risk_blocklist`: email, phone, device, bank blind index, IP range).
  - Device and IP stored hashed or truncated only.
- **12.4 `[BE]`** Wire `risk.evaluate('hold_attempt')` into `CheckoutService.createHold` and `PaymentService.createAttempt` (block → 403 with a neutral message; challenge → lower `maxPerUser`, flag). `post_capture` is an outbox consumer of `OrderPaid`.
- **12.5 `[BE]`** `application/risk/promoter-fraud-service.ts`:
  - Identity link graph `v2_identity_links` (shared device, bank blind index, phone → `clusterId`).
  - Detectors: self/linked referral, collusion (shared bank or KYC across promoter/host/venue), velocity and bursts versus baseline, order quality (refund/dispute/chargeback rates, **never-scanned tickets** via the scan ledger), commission anomalies, promo code leakage, fake host/event.
  - `promoter_risk_score` 0–100 per promoter and per attributed order, recomputed on events and nightly.
- **12.6 `[BE]`** Actions:
  - T1 → leg `riskHold`.
  - T2 → hold all of the promoter's commissions and open a review.
  - T3 → suspend attribution (the `referral-link-service.ts` resolver refuses codes).
  - Confirmed → reverse the commission (`reversed`), claw back via 1300, blocklist the identifiers.
  - The release job (9.4) already excludes `riskHold`.
  - Releasing flagged money needs risk maker plus finance checker (10).
- **12.7 `[BE]`** Routes: `GET /admin/risk/queue`, `GET/POST /admin/risk/rules` (versioned; a new rule starts in shadow), `POST /admin/risk/decisions/:id/outcome`. Chargebacks (11) feed outcomes automatically.
- **12.8 `[BE]`** Optional policies behind DP-14 flags: first-payout review, commission only on redeemed tickets.

### Test
- **12.9** Card-testing burst blocked in enforced mode and logged only in shadow; risk service down → fail-open minimal rules; self-referral, linked accounts, burst and refund-heavy promoter detected; a T1 hold excluded from release.

**Exit gate:** on staging, all v1 rules run in shadow for one week with decisions logged; a promoter fraud scenario produces a held commission.

---

## Phase 13 — Provider health, circuit breaker, router (25, 26)

**Goal:** a degraded method is hidden instead of failing at checkout; contract tests pass on all adapters. **Depends on:** 1, 3.

### Create
- **13.1 `[BE]`** `application/providers/circuit-breaker.ts`: closed → open (failure rate ≥ `BREAKER_FAILURE_RATE` with ≥ `BREAKER_MIN_VOLUME`, or N consecutive failures) → half-open probe → closed. Wrap every provider call (payment, payout, reconciliation). User declines (insufficient funds) do **not** count; technical failures do.
- **13.2 `[BE]`** `application/providers/provider-health-service.ts`:
  - Per provider and method: success rate, error class, p50/p95 latency, webhook delay (capture time vs receipt), 5xx, 429, timeouts, settlement lag, payout success.
  - States `healthy|degraded|unavailable|recovering` with hysteresis and a minimum-volume gate.
  - Changes stored in `v2_provider_health_events` and emitted as `ProviderHealthChanged`.
- **13.3 `[BE]`** Worker jobs: `provider-probe` (every minute: readiness credential check plus a cheap read) and `provider-canary` (daily test-mode canary payment in the **test** account, never live).
- **13.4 `[BE]`** `application/providers/provider-router.ts`: `select(context)` is config-driven (`PROVIDER_ROUTING_RULES`: method, amount, bank, health, cost; default Razorpay).
  - A payment is **bound to its provider** at creation.
  - Failover = a new attempt, only after fetching the first attempt's state shows no capture; if two attempts on one hold both capture, the later one is auto-refunded (a recovery task).
- **13.5 `[BE]`** Quote and attempt responses include `availableMethods` (methods with an open breaker are removed). Payout job pauses (does not fail) while the payout breaker is open; recovery keeps polling.
- **13.6 `[BE]`** Canonical event translation lives per adapter (`razorpay-event-mapper.ts`), so handlers only see `ProviderEvent`. Every money record carries `provider`. Account 1100 is keyed per provider.

### Test
- **13.7** Breaker opens and closes under simulator 5xx bursts; a method is hidden; failover does **not** double-charge (timeout-after-capture scenario); the provider contract suite passes on the simulator, the Razorpay payment adapter and the RazorpayX payout adapter.

**Exit gate:** the `/admin/providers/health` tile on staging reflects a simulated outage within 2 minutes and recovers.

---

## Phase 14 — Anomaly detection, reports, period close, analytics, SLOs (23, 24, 30)

**Goal:** a month closes from the ledger with no manual numbers. **Depends on:** 6, 11, 13.

### Create
- **14.1 `[BE]`** Metrics emission: a structured metric logger (`telemetry/metrics.ts`) for the 23 metrics; optional OpenTelemetry spans around provider calls, transitions, posting and handlers (`@opentelemetry/api` behind a `TELEMETRY_ENABLED` flag).
- **14.2 `[BE]`** `application/anomaly/anomaly-service.ts` (S21):
  - Methods: (1) hard thresholds, (2) hour-of-week rolling baselines with median/MAD and a minimum-volume gate, (3) rate-of-change.
  - Alerts (`v2_anomaly_alerts`) carry severity, slice, baseline comparison, runbook link and a dedupe key.
  - Automatic **reversible** actions only (open a breaker for a method, hold the next payout for a flagged host); everything else is a recommendation.
- **14.3 `[BE]`** SLO computation (24 table): a worker job aggregates SLIs into `v2_slo_windows`; burn-rate alerts (fast 1h, slow 6h); `GET /admin/slo`. P1 paging integration (`ALERT_WEBHOOK_URL`, for example Slack/PagerDuty), with every alert linking a runbook in `docs/operations/runbooks/`.
- **14.4 `[BE]`** `application/reporting/reporting-service.ts` (S20). Every 30 report reads the journal, legs or settlement records and records `parameters + ledgerWatermark` in `v2_report_runs`:
  - trial balance and account statements;
  - liability to beneficiaries (held, releasable, in-transit by age);
  - platform revenue and margin;
  - GST (output by type, invoice register, input credit);
  - settlement and cash position;
  - payouts and refunds;
  - reconciliation;
  - promoters and risk.

  Subscriptions are added in 19.
- **14.5 `[BE]`** Exports: CSV (reuse `lib/csv.ts`), XLSX and PDF. Large ones run asynchronously (a worker job writes to object storage via the existing `object-storage.ts` port and returns a signed URL). Exports are stamped with generator, time and watermark, and every export is audited.
- **14.6 `[BE]`** `application/reporting/period-close-service.ts`:
  - Preconditions: reconciliation clean, invariants passing, open exceptions explained.
  - Maker plus checker approve (10); then the period is locked (`v2_periods/{yyyy-mm}`, I12 enforced by S6) and the closing snapshot is stored.
  - Later corrections post to the open period.
- **14.7 `[BE]`** Analytics stream: an outbox consumer copies minimised events to `v2_analytics_payments` (never in the transaction path). Funnel, success by method/bank/provider, AOV, discount cost, time to payout, event P&L. Partners see only their rows (extend `analytics-service.ts`).
- **14.8 `[BE]`** Routes: `GET /admin/reports/:id`, `POST /admin/reports/:id/run`, `GET/POST /admin/periods/:period/close`, `GET /admin/anomalies`.

### Test
- **14.9** The anomaly minimum-volume gate suppresses small samples; a closed period rejects postings; the same report re-run against the same watermark gives identical output.

**Exit gate:** a simulated month closes via maker-checker; the trial balance and revenue reports match the journal exactly.

---

## Phase 15 — Secrets/KMS, key rotation, disaster recovery, chaos (27, 28, 31)

**Goal:** a restore drill meets RPO/RTO and a leaked-key drill is done. **Depends on:** 2, 8.

### Create
- **15.1 `[PLAT][BE]`** `domain/ports/secret-store.ts` plus a GCP Secret Manager adapter (`infrastructure/gcp/secret-manager.ts`; add `@google-cloud/secret-manager`, exempt in the boundaries script like `firebase-admin`).
  - Razorpay key and secret, webhook secret, payout credentials, `BLIND_INDEX_KEY`, `MAGIC_TICKET_SECRET` and internal signing keys load at startup by versioned name.
  - Env vars remain only for the memory/dev driver.
  - `config/index.ts` resolves secret **references** (`sm://…`) and is still the only `process.env` reader.
- **15.2 `[BE]`** `domain/ports/kms.ts` plus a Cloud KMS adapter: **envelope encryption** with a per-record data key wrapped by a KMS key and `keyVersion` stored. Only the payout service identity may unwrap. Migrate `infrastructure/encryption.ts` users (beneficiary account numbers) with a lazy re-wrap migration script.
- **15.3 `[BE]`** Webhook secret rotation: `RAZORPAY_WEBHOOK_SECRETS` (current plus previous); verification accepts either during the overlap window. Confirm the Razorpay overlap mechanism (a second webhook URL if needed) **before** the first rehearsal.
- **15.4 `[PLAT]`** Rotation schedule automation (27 table) plus runbooks `docs/operations/runbooks/{key-rotation,leaked-key}.md`. Production secret changes need two people; access reviewed quarterly; alert on unusual secret reads (cloud audit logs).
- **15.5 `[PLAT]`** Backups:
  - Firestore point-in-time recovery enabled.
  - Scheduled exports to a **separate GCP project** in a retention-locked bucket, with the journal and audit log exported separately.
  - Daily audit root hash written to the same immutable bucket (closes I10 with 2.21).
  - Infrastructure and config in code (`render.yaml`, Firestore indexes and rules).
- **15.6 `[PLAT][BE]`** Restore playbook `docs/operations/runbooks/restore.md`, implementing the 28 order:
  1. Trip the payout and refund flags.
  2. Restore.
  3. Replay provider events since the restore point (`v2_provider_events` plus provider API).
  4. Look up every payout and refund at the provider before any resend.
  5. Run reconciliation and all invariants.
  6. Re-enable with a checker.

  Add the script `scripts/post-restore-replay.ts`.
- **15.7 `[PLAT]`** Chaos suite in staging (`BE/apps/api-gateway/scenarios/chaos/*.test.ts`), run in CI nightly against the emulator plus the simulator:
  - kill the worker after each fulfilment step;
  - crash between commit and publish;
  - queue duplicates;
  - database contention;
  - clock skew;
  - concurrent refund plus payout release on the same legs;
  - double-approval race;
  - flash-sale race with capture after expiry;
  - secret rotation under traffic;
  - breaker flapping;
  - large backlog replay.

  The oracle is the invariant checker plus a reconciliation with no unexplained differences.

### Test / drills
- **15.8** First restore drill into an isolated project, with invariants and reconciliation run on the restored data; record actual RPO/RTO against `RPO_MINUTES`/`RTO_HOURS`.
- **15.9** Leaked-key drill in staging (revoke, rotate, rotate webhook secret, log review, reconciliation).

**Exit gate:** 15.8 and 15.9 are documented with timings; no secret appears in the repo, CI logs or client bundle (secret scanning enabled in CI: `gitleaks` step in `.github/workflows`).

---

## Phase 16 — Frontend: guest paid checkout (2 checkout step, guide Phase 3)

**Goal:** the first paid test purchase completes in the real guest UI. **Depends on:** 4, 5 (contract freeze); backend staging live with the Razorpay test keys.

> Read `FE/apps/guest-portal/node_modules/next/dist/docs/` before writing Next.js 16 code (CLAUDE.md gotcha).

### Contracts and client
- **16.1 `[FE]`** Sync `FE/packages/contracts` from the BE export (4.1, 5.9); `pnpm contract-parity` passes from `BE`.
- **16.2 `[FE]`** `packages/api-client`: add typed methods `checkout.quote`, `checkout.createHold`, `payments.createAttempt`, `payments.verify`, `payments.getStatus`, `orders.get`. Each passes `Idempotency-Key` where required and propagates `X-Correlation-Id`.

### BFF routes (`FE/apps/guest-portal/src/app/api/`)
Follow the `rsvp/route.ts` pattern: `assertSameOrigin` → `assertCsrf` → `forwardToGateway` with the cookie.
- **16.3 `[FE]`** `checkout/quote/route.ts` (POST).
- **16.4 `[FE]`** `checkout/holds/route.ts` (POST). Mint the `Idempotency-Key` **per checkout session** (stored in `sessionStorage` per event plus basket hash) so a double-click reuses it, not one key per call.
- **16.5 `[FE]`** `payments/attempts/route.ts` (POST, key per hold).
- **16.6 `[FE]`** `payments/[id]/verify/route.ts` (POST).
- **16.7 `[FE]`** `payments/[id]/status/route.ts` (GET, `no-store`).
- **16.8 `[FE]`** BFF route tests (CSRF missing → 403, gateway error passthrough, idempotency header forwarded).

### UI (`FE/apps/guest-portal/src/features/booking/`)
- **16.9 `[FE]`** `CheckoutFlowClient.tsx`: delete `PaymentPreview`, the local 5% fee math (line ~69) and the `/confirmation/preview-…` link. Selecting tiers calls the server quote (debounced) and renders the breakdown **as returned** (subtotal, discount, platform fee, payment fee, GST, total). Promo and referral codes go to the server.
- **16.10 `[FE]`** Attendee step: validate name, email and phone client-side (zod from contracts) and send them in the hold request.
- **16.11 `[FE]`** Create `features/booking/hooks/useRazorpayCheckout.ts`:
  - Load `https://checkout.razorpay.com/v1/checkout.js` via `next/script` (lazy) **only after** the attempt returns.
  - Open from the click handler with `{ key: keyId, order_id: providerOrderId, amount, currency, prefill, notes, timeout: secondsUntil(holdExpiresAt), retry: {enabled: true}, modal.ondismiss }`.
  - Disable the pay button after the click.
  - `handler` → verify BFF.
  - `payment.failed` → show the failure with a retry (same hold while active).
- **16.12 `[FE]`** Remove the card/UPI/net-banking selector, since Razorpay Checkout shows the account's enabled methods (14). Optionally pass `method` preference only if `availableMethods` (13.5) is present.
- **16.13 `[FE]`** Paid UX states (audit #8): `processing` (after the callback, poll `status` every 2s up to 60s; the webhook is the truth), `paid` → `/confirmation/[orderId]`, `failed`, `cancelled by user`, `hold expired` (countdown timer from `holdExpiresAt`; on expiry offer re-hold), `pending confirmation` (after 60s: "we'll email you", an order appears when the webhook lands). The UI never shows paid before the server confirms.
- **16.14 `[FE]`** CSP and headers: allow `checkout.razorpay.com` (script, frame) and `api.razorpay.com`/`lumberjack.razorpay.com` (connect) in the guest-portal `next.config` headers. Update `nginx` CSP in `BE/deploy` if the edge sets CSP (check `BE/docs/nginx/config-reference.md`).
- **16.15 `[FE]`** `confirmation/[id]/page.tsx`: render paid orders (breakdown, attendee, tickets/QR, payment method); remove the preview branch. `checkout/[id]/page.tsx`: remove the "paid checkout remains a preview" note (line ~25).
- **16.16 `[FE]`** Design system: use `@c1rcle/design-system` tokens and `@c1rcle/icons` only; no inline styles.

### Test
- **16.17** Unit and component tests for quote rendering (server numbers only), attendee validation, and each UX state with a mocked api-client.
- **16.18** Playwright E2E against staging with Razorpay **test mode**: success via UPI test VPA `success@razorpay`, failure (`failure@razorpay`), user dismiss, hold expiry. Store the specs in `FE/apps/guest-portal/e2e/paid-checkout.spec.ts`.

**Exit gate:** a Playwright run on staging completes a paid purchase and shows tickets in the wallet; `pnpm check` green in FE.

---

## Phase 17 — Frontend: partner finance and banking, Ops console (6, 14, 19)

**Goal:** partners onboard bank details and see ledger-true numbers; ops runs payments from the console. **Depends on:** 8–11, 16.

### Partner dashboard (`FE/apps/partner-dashboard`)
- **17.1 `[FE]`** Contracts sync (`banking.ts`, `payouts.ts`, updated `phase6.ts`); add api-client methods for banking, payouts, payout settings and event split.
- **17.2 `[FE]`** Banking onboarding: KYC status card, a bank account form (only `bankLast4` shown after submit), cooling-period notice on change, and a hosted onboarding link if the rail provides one. Location: `components/partner-v3/finance/FinanceBankCards.tsx` (extend) plus a new `BankingOnboardingPanel.tsx`; BFF under `src/app/api/bff/banking/*`.
- **17.3 `[FE]`** Rewire `lib/finance/api-finance-repository.ts` and `finance-view-model.ts` to the leg-based balances: earned, paid out, pending (held + releasable + payout requested), last payout, settlement history. Remove the `dataStatus: 'fixture'` finance surfaces for venue, host and promoter (`FinanceSummary`, `FinancePayoutHistory`, `FinanceOrdersTable`).
- **17.4 `[FE]`** Per-role dashboard fields (14): Venue (ticket revenue, net earnings, payouts, settlement history), Host (revenue share, event earnings, pending settlements), Promoter (tickets sold, revenue generated, commission earned, held-for-review reason).
- **17.5 `[FE]`** Event split editor (venue/host-owned, venue bps, multiple hosts with shares, locked badge after the first sale) in event detail `finance` tab: `app/venue/events/[eventId]/(detail)/finance/page.tsx` plus the host equivalent. Extend the existing `VenueSharePanel`.
- **17.6 `[FE]`** Payout settings form (auto payout, threshold, mode, preferred day) and event close-out action.
- **17.7 `[FE]`** Live updates (14): poll the BFF every 15s on finance screens (or SSE if the BE exposes `GET /organizations/:org/finance/stream` following the D-028 SSE pattern); show `processing` until the server confirms.

### Admin console = Ops console (`FE/apps/admin-console/src/app`)
- **17.8 `[FE]`** `payments/` Payment 360: search plus a timeline view (correlation-id story), masked fields with an audited reveal-with-reason dialog.
- **17.9 `[FE]`** `exceptions/`: queue, assign, notes and evidence upload, resolve, propose write-off.
- **17.10 `[FE]`** `recovery/`: recovery tasks and DLQ, replay, discard with reason, bulk replay → approval.
- **17.11 `[FE]`** Extend the existing `refunds/` and `payouts/` pages: boards by 15 state; approve, retry, manual refund with evidence, mark paid with UTR, freeze/unfreeze; everything through approvals.
- **17.12 `[FE]`** `approvals/`: an inbox showing the exact payload and diff; approve or reject with reason. Migrate the existing `proposals/` page or redirect it here.
- **17.13 `[FE]`** `risk/`: held orders, flagged promoters/hosts, rules list (shadow/enforced), outcome recording.
- **17.14 `[FE]`** `health/` (extend the existing page): invariants, SLOs, provider health, outbox lag, DLQ depth.
- **17.15 `[FE]`** `controls/`: feature flags and kill switches (enabling payouts or refunds creates an approval).
- **17.16 `[FE]`** `reports/` and `periods/`: run and download reports, close a period.
- **17.17 `[FE]`** Role-gated navigation for `support, ops, finance, risk, admin, auditor`; every mutating action requires a reason code field.

### Test
- **17.18** Component tests per screen; Playwright: partner adds a bank account → admin verifies → event published → purchase → close-out → payout approved by a second admin → marked paid → partner sees it paid.

**Exit gate:** the 17.18 E2E passes on staging; no finance surface reads fixtures.

---

## Phase 18 — Launch readiness and rollout (10, 12 launch gates)

**Goal:** turn on real money safely. **Depends on:** 0–17.

- **18.1 `[ALL]`** Launch gate checklist (12) confirmed in writing:
  - 1B (2), 1C (3), 4B (6), 7B (10) and 13 basics (15.5 backups, 15.4 rotation, 15.8 first restore drill) are done → **real money allowed**.
  - `AUTO_PAYOUTS_ENABLED` only after 8B (11) and 10 v1 (12) are live **and** the restore drill passed.
- **18.2 `[BIZ]`** DP-08 regulatory answer documented (lawyer plus Razorpay). If Route is required, implement `razorpay-route-payout-adapter.ts` behind the `PayoutProvider` port before enabling payouts.
- **18.3 `[PLAT]`** Threat review and **penetration test** of the payment, refund, payout and webhook endpoints. Cover signature tampering, replay, races, idempotency abuse, IDOR on `/payments/:id/status` and `/payouts/order/:id`, bank data encryption, and append-only audit (10 pre-launch review). Fix findings.
- **18.4 `[PLAT]`** Secrets audit and admin access review (who holds `finance`/`admin`/`super`).
- **18.5 `[PLAT]`** Production configuration:
  - Razorpay **live** keys in the secret store; the live webhook pointing at the prod gateway with the 1.11 event list; auto-capture on.
  - `render.yaml` prod web plus worker services; Firestore indexes deployed (`firebase deploy --only firestore:indexes,firestore:rules`).
  - Nginx passes the webhook raw body unmodified (`client_max_body_size`, no body rewriting); verify with `pnpm check:nginx`.
- **18.6 `[ALL]`** Staging full regression: the 13 test list, the chaos suite (15.7), all Playwright suites, and a 7-day reconciliation.
- **18.7 `[ALL]`** Rollout:
  1. `PAID_CHECKOUT_ENABLED` for internal test events only (allow-list by `eventId` flag).
  2. One friendly venue.
  3. General availability.
  4. `REFUND_EXECUTOR_ENABLED` (checker).
  5. Manual payouts.
  6. `AUTO_PAYOUTS_ENABLED` (checker) after the 18.1 conditions.
- **18.8 `[PLAT]`** Rollback runbooks per 10 in `docs/operations/runbooks/payments-rollback.md`:
  - Checkout failing: disable the flag, then investigate.
  - Payout job misbehaving: disable, freeze, pay manually and record the UTR.
  - Webhooks missing: polling plus replay.
  - Refund error.
  - Invariant breach: automatic trip.

  Rollback never deletes ledger entries or orders.
- **18.9 `[BE]`** Update `ROADMAP.md`, the phase-09 Session Log, `docs/integration-flows/checkout.md` and `ticket-booking-flow.md` to the shipped reality.

**Exit gate:** the first real-money order at the pilot venue reconciles the next day with zero exceptions.

---

## Phase 19 — Subscriptions and invoices (final phase) (5, 14 app-store note)

**Goal:** trial, renewal, failure, upgrade and cancel are verified for venue dashboard plans and member Premium/VIP. **Depends on:** 18 for production (development can start after 6 + 10). **Decide DP-12 and DP-13 first.**

### Backend
- **19.1 `[BE]`** `domain/models/plan.ts` (`v2_plans`): `{ id, audience: venue|member, tier: basic|pro|premium|vip, interval: monthly|yearly, pricePaise, gstBps, providerPlanId, features[], commissionBps (venue only) }`. Seed script `scripts/seed-plans.ts`. Plan-to-rate table in config (`PLAN_COMMISSION_BPS`).
- **19.2 `[BE]`** `domain/models/subscription.ts` (`v2_subscriptions`):
  - Local 15 states `trialing, active, past_due, suspended, cancelled`.
  - Fields `source: razorpay|app_store|play_store`, `providerSubscriptionId`, `currentPeriodStart/End`, `cancelAtCycleEnd`, `graceEndsAt`.
  - Provider rules encoded: halted→active does not re-attempt; a cancelled subscription cannot restart; pause only from `active`.
- **19.3 `[BE]`** Implement `SubscriptionProvider` in `apps/api-gateway/src/lib/payments/razorpay-subscription-adapter.ts`: `createPlan`, `createSubscription({planId, customerRef, totalCount, startAt?, notes})`, `update(id,{planId?,quantity?,applyAt})`, `cancel(id, atCycleEnd)`, `pause`, `resume`, `fetch`. Simulator support plus the contract suite.
- **19.4 `[BE]`** `application/subscriptions/subscription-service.ts` (S23):
  - Create (trial = future `startAt`; returns Checkout data), verify callback (signature only; **state comes from the webhook**), change plan (proration per DP-12), cancel now or at cycle end, `me`.
  - Behind `SUBSCRIPTIONS_ENABLED`.
- **19.5 `[BE]`** Webhook handlers for `subscription.authenticated, .activated, .charged, .updated, .pending, .halted, .paused, .resumed, .cancelled, .completed`. They dedupe via the provider-event inbox (4.11), transition the FSM, drive entitlements, notifications (charge failed, grace ending, suspended) and invoices. Ledger: `subscriptionCharged` (1100 / 4200 + 2200); deferred revenue account if the CA decides recognition over the period.
- **19.6 `[BE]`** `application/subscriptions/entitlement-plan-resolver.ts`: `canUse(feature, owner)` reads any active source; `commissionBps(venueId)` comes from the venue's active plan, or the default plan when there is none. **Swap this into the `PlanResolver` port** (5.3); the snapshot-at-hold behaviour is unchanged, so old orders are unaffected.
- **19.7 `[BE]`** `application/invoicing/invoice-service.ts`:
  - One GST invoice per successful charge **and** per convenience-fee settlement.
  - Sequential in-house numbering (`v2_invoice_counters/{fy}` incremented in a transaction; authoritative even if Razorpay invoices are used).
  - GSTIN, SAC, tax breakup, immutable PDF stored via the object-storage port.
  - `GET /invoices`, `GET /invoices/:id/pdf`.
- **19.8 `[BE]`** Routes and contracts (`subscriptions.ts`): `GET /plans?audience=`, `POST /subscriptions` (Idempotency-Key), `POST /subscriptions/:id/verify`, `PATCH /subscriptions/:id`, `POST /subscriptions/:id/cancel`, `GET /subscriptions/me`, `GET /invoices`.
- **19.9 `[BE]`** Recovery task "subscription drift" (fetch and align, 10.7); reconciliation R5 (charges vs invoices vs 4200, 11.4); the subscriptions report (MRR, churn, failed renewals, grace, suspensions; store-billed shown separately) in 14.4.
- **19.10 `[BIZ][BE]`** App-store billing check for mobile memberships. If required, add `app_store`/`play_store` receipt-verification adapters and keep that revenue and those invoices separate. This is out of scope for this repo's web apps until decided.

### Frontend
- **19.11 `[FE]`** Partner dashboard: a plans page (monthly/yearly, current plan, upgrade/downgrade preview, cancel at cycle end), Razorpay subscription Checkout (`subscription_id` instead of `order_id`), past-due and suspended banners, invoice list and download.
- **19.12 `[FE]`** Guest portal (web member plans, if in scope per DP-12): Premium/VIP purchase and management pages; feature gating via `canUse` returned in the session or profile DTO.
- **19.13 `[FE]`** Admin console: a subscriptions board and plan catalogue view (plan or commission table changes go through approvals).

### Test (13 subscription list)
- **19.14** Trial to first charge; renewal; failed charge → `past_due` → `halted`/`suspended`; recovery; upgrade/downgrade; cancel at cycle end; new subscription after cancel; one invoice per charge with sequential numbers; plan commission change affects only new holds; reconciliation R5 clean.

**Exit gate:** all 19.14 scenarios pass on the simulator and in Razorpay test mode on staging; `SUBSCRIPTIONS_ENABLED` rolled out via the 18.7 pattern.

---

## Appendix A — New and changed Firestore collections

| Collection | Phase | Notes |
|---|---|---|
| `v2_outbox`, `v2_outbox_seq`, `v2_inbox`, `v2_job_leases` | 2 | Service-only rules |
| `v2_audit_log`, `v2_audit_chain_head`, `v2_audit_roots` | 2 / 15 | Append-only; daily root exported |
| `v2_payments`, `v2_payment_attempts`, `v2_provider_events` | 4 | Unique `provider+providerPaymentId` via doc id |
| `v2_cart_reservations`, `v2_orders` (changed) | 4 | New states and fields plus migration |
| `v2_event_splits` | 5 | Locked after the first sale |
| `v2_journal_entries`, `v2_journal_lines`, `v2_ledger_legs`, `v2_account_balances`, `v2_invariant_runs` | 6 | `v2_partner_ledger` becomes read-only history |
| `v2_refund_requests` (changed) | 7 | 15 states |
| `v2_beneficiaries` | 8 | Replaces `v2_bank_accounts` |
| `v2_payouts` (changed), `v2_payout_settings` | 9 | |
| `v2_approval_requests`, `v2_recovery_tasks`, `v2_dead_letters` | 10 | Migrated from `v2_proposed_actions` |
| `v2_chargebacks`, `v2_settlement_records`, `v2_recon_runs`, `v2_recon_exceptions`, `v2_bank_statement_lines` | 11 | |
| `v2_risk_rules`, `v2_risk_decisions`, `v2_risk_counters`, `v2_risk_blocklist`, `v2_identity_links`, `v2_promoter_risk` | 12 | Hashed device/IP only |
| `v2_provider_health_events` | 13 | |
| `v2_anomaly_alerts`, `v2_metric_baselines`, `v2_slo_windows`, `v2_report_runs`, `v2_periods`, `v2_analytics_payments` | 14 | |
| `v2_plans`, `v2_subscriptions`, `v2_invoices`, `v2_invoice_counters` | 19 | |

For every collection: an add-it task in `firestore.indexes.json` and `firestore.rules`, a memory adapter, a Firestore adapter, and the contract-suite case.

## Appendix B — New API endpoints, by phase

| Phase | Endpoints |
|---|---|
| 4 | `GET /payments/:id/status` (plus changed quote/hold/attempt/verify payloads) |
| 5 | `GET/PUT /organizations/:org/events/:eventId/split` |
| 7 | `POST /admin/refunds/:id/manual` |
| 8 | `GET /banking/status/:ownerType/:ownerId`, `POST /banking/accounts`, `GET /banking/onboarding-link`, `POST /admin/beneficiaries/:id/{verify,reject}` |
| 9 | `POST /organizations/:org/events/:id/close-out`, `GET /payouts/me`, `GET /payouts/order/:orderId`, `GET /admin/payouts?status=`, `POST /admin/payouts/release/:eventId`, `POST /admin/payouts/:id/{retry,freeze,unfreeze,approve,mark-paid}`, `GET/PUT /organizations/:org/payout-settings` |
| 10 | `GET /admin/approvals`, `POST /admin/approvals/:id/{approve,reject}`, `GET /admin/payments/search`, `GET /admin/payments/:id/timeline`, `POST /admin/reveal`, `GET/POST /admin/dlq`, `POST /admin/dlq/:id/{replay,discard}`, `GET/PUT /admin/controls/flags`, `GET /admin/invariants` |
| 11 | `GET/POST /admin/exceptions`, `POST /admin/exceptions/:id/{assign,resolve}`, `GET /admin/reconciliation/runs`, `POST /admin/reconciliation/bank-statements` |
| 12 | `GET /admin/risk/queue`, `GET/POST /admin/risk/rules`, `POST /admin/risk/decisions/:id/outcome` |
| 13 | `GET /admin/providers/health` |
| 14 | `GET /admin/slo`, `GET /admin/anomalies`, `GET /admin/reports/:id`, `POST /admin/reports/:id/run`, `GET/POST /admin/periods/:period/close` |
| 19 | `GET /plans`, `POST /subscriptions`, `POST /subscriptions/:id/verify`, `PATCH /subscriptions/:id`, `POST /subscriptions/:id/cancel`, `GET /subscriptions/me`, `GET /invoices`, `GET /invoices/:id/pdf` |

Every endpoint needs:
- zod contracts in `BE/packages/contracts`, exported and mirrored to `FE`;
- a route-manifest entry;
- an RBAC permission;
- a rate-limit class;
- an `Idempotency-Key` on mutations;
- a route test.

## Appendix C — Cross-cutting test matrix (13), mapped to phases

| Test | Phase |
|---|---|
| Callback only / webhook only / racing | 4.17 |
| Tampered signature, wrong order/amount/user | 1.12, 4.18 |
| Duplicate and out-of-order webhooks | 3.7, 4.11 |
| Crash after each fulfilment step | 4.19, 15.7 |
| Captured after expiry | 4.20 |
| Rounding: promos, multi-host, venue-owned, promoter above distributable | 5.10–5.11 |
| Plan change after purchase; split locked after first sale | 5.12 |
| Refunds: before/after payout, partial, cancellation, failed, fees | 7.7 |
| Payouts: one per beneficiary per event, retry, frozen, dispute block | 9.12 |
| Every allowed and disallowed state transition | 2.8 |
| Outbox crash between commit and publish; inbox duplicates | 2.24–2.25 |
| Journal balance under random splits (property-based) | 6.12 |
| Each invariant I1–I12 breakable and caught | 3.5, 6.13 |
| Maker-checker abuse cases | 10.15 |
| DLQ replay idempotent; recovery per task type | 10.15 |
| Risk shadow vs enforced, fail-open; promoter fraud | 12.9 |
| Breaker and failover without double charge | 13.7 |
| Webhook secret rotation overlap | 15.3, 15.7 |
| Restore drill plus invariants plus reconciliation | 15.8 |
| Period close lock | 14.9 |
| Correlation id on every log, event, journal entry and audit record | 2.27 |
| Subscriptions lifecycle | 19.14 |

---

_Verify Razorpay limits, payloads and product availability (RazorpayX payouts, Route, Subscriptions, dispute APIs, settlement recon API) against live Razorpay docs and the account manager before starting 1, 9, 11 and 19._

---

## Reviewer notes (verified against `staging`)

- Confirmed real defects: callback signature scheme (task 1.1), no payment-to-hold binding, non-resumable fulfilment, settlement on grand total (DP-01). Fixed on branch `fix/payments-correctness`: signature, binding, ownership, currency, resumable fulfilment.
- Already done elsewhere: task 0.1 (import), 0.2 (parity path), 1.7 and 1.9 (placeholder fallbacks removed, readiness enabled) in PR #113, which uses fail-closed 503 instead of 1.8's boot failure because staging runs without Razorpay keys. Record that as a decision (D-031 is free).
- Missing from the repo: the companion "Payments: Business Rules" doc and the audit the task IDs cite.
- Not covered: Indian payout tax (TDS/TCS) and GST on the ticket price — confirm with the CA. Firestore ~1 write/sec/doc limits on balance and invoice counters.
- Suggested first slice: Phases 0-1, transactional fulfilment, minimal ledger, manual payouts, behind `PAID_CHECKOUT_ENABLED`.
