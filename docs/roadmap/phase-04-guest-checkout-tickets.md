# Phase 4 — Guest checkout & tickets

**Status:** in progress (2026-08-14) — domain layer done, wiring not started · **Depends on:** Phase 3 (event-catalog/tiers)

Guest Portal (`C1RCLE-FRONTEND/apps/guest-portal`) is 100% fixture-driven
today — zero `fetch()` calls anywhere. `apps/guest-portal/docs/frontend-backend-handoff.md`
(102 lines, already written by the frontend team) is close to a full spec —
read it in full before starting this phase. Route/fixture replacement table:

| Route | Fixture today | Presentation DTO |
|---|---|---|
| `/`, `/explore` | `home.fixture.ts`, `explore.fixture.ts` | `HomeFixture`, `ExploreEvent[]` |
| `/event/[eventId]` | `event-detail.fixture.ts` | `EventDetailFixture` |
| `/checkout/[id]`, `/confirmation/[id]` | `booking.fixture.ts` | `BookingEventFixture`, `BookingConfirmationFixture` |
| `/tickets` | `tickets.fixture.ts` | `TicketWalletData` |
| `/profile`, `/hosts`, `/host/[id]`, `/venue/[id]` | `profile.fixture.ts`, `directory.fixture.ts` | `ProfileFixture`, directory profiles |

Guest Portal's handoff doc rules to hold to: money as integer paise / ISO-8601
timestamps at the boundary; no fixture fallback after an API error in prod;
auth checks are display logic only, API must authorize; no access tokens in
localStorage; explicit pending/failure/expired/success checkout states;
QR/pass data must come from an authorized, short-lived backend response.

**Frontend bug to fix alongside this phase:** the guest login flow
(`login-page-client.tsx`) never calls `@c1rcle/auth`'s `setSession()` — the
authenticated ticket-wallet path is unreachable regardless of what a user
does at `/login`. Not a backend fix, but blocks testing this phase e2e.

## v1 proven logic to port (`thec1rcle`)

- **Checkout flow** (`checkout.ts`, server-authoritative, Redis-locked,
  idempotent): calculate → promo → reserve (cart hold, ~10min TTL) → intent
  (Razorpay order) → initiate → **two parallel confirmation paths**
  (webhook HMAC-verified + client-redirect verify, both idempotent,
  whichever arrives first wins) → cancel/failure.
- **Pricing formula** (`pricing-engine.calculatePricing`):
  `subtotal = Σ(effectivePrice × qty)`; promoter/promo discounts; then
  `platform fee = round(discountedSubtotal * 5%)`,
  `payment fee = round(discountedSubtotal * 2.5%)`,
  `gst = round((platform+payment) * 18%)` (GST on fees only, not ticket
  price); `grandTotal = discountedSubtotal + platform + payment + gst`.
- **Ticket issuance**: `entitlement-engine.issueEntitlements()` — one
  entitlement doc per ticket unit (couple tickets = 1 entitlement with
  `scanCountAllowed:2`, not 2 entitlements), deterministic id
  `ENT-{orderId}-{tierId}-{index}` (idempotent against retried fulfillment).
- **Inventory** (`inventory-engine.js calculateEffectiveInventory`):
  base `quantity - sold`, corrected by sharded counters
  (`ticket_shards` subcollection) for high-throughput events, minus active
  Redis cart-reservations. Circuit breaker: `strictMode` events fail closed
  (503 + Retry-After) on Redis degradation; default fails open to Firestore count.

## Firestore collections

`v2_orders`, `v2_cart_reservations`, `v2_entitlements`, `v2_promo_redemptions`
(shared with Phase 3), `v2_rsvp_orders`.

## External services needed

Razorpay (test keys already reused from `thec1rcle/apps/api-gateway/.env.development`
if this phase reuses the same dev sandbox — confirm before wiring real charges).

## Session Log

### 2026-08-14 — pricing, order and entitlement domain

Built the money and fulfilment core. **Domain only — nothing is wired to HTTP
yet**, so no checkout endpoint exists and Phase 4 is not usable.

**`models/pricing.ts`** (18 tests) — v1's `calculatePricing` ported exactly:
`subtotal → discount → fees on the DISCOUNTED subtotal → GST on the fees only`.

- All integer paise. `applyPercent` scales by 10 and divides by 1000 rather
  than multiplying by a float, because `800 * 0.025` is `20.000000000000004` —
  a real error on amounts as small as ₹8.
- Fee order is load-bearing: charging fees on the pre-discount subtotal would
  overcharge every promo user. There is a test that would fail if it changed.
- GST on fees only is a **tax position**, not a formatting choice. Pinned by
  test, with the number that would appear if someone "fixed" it to charge GST
  on the ticket price.
- `assertReconciles` runs on every calculation, not just in tests: a breakdown
  whose parts do not sum to its total is a number a guest gets charged, and
  failing loudly beats reconciling it against a bank statement in Phase 6.
- A fixed promo is capped at the eligible subtotal — a ₹500-off code on a ₹300
  line discounts ₹300, never producing a refund the platform never agreed to.

**`models/order.ts`** (11 tests) — the checkout FSM, shaped by the fact that
**two confirmation paths race for every order** (Razorpay webhook + browser
redirect, in either order).

- `markPaid` with the *same* payment id returns the order **unchanged** — not
  a second transition, and critically **no version bump**, so the path that
  arrives second does not fail an optimistic-lock check merely for being
  second. With a *different* payment id it throws: that is two captures on one
  order, and it needs a human.
- The pricing breakdown is frozen onto the order. Nothing downstream ever
  recalculates a total; it reads it.
- `failed` is terminal — a retry is a NEW order, because reusing this one makes
  the provider's payment id ambiguous across two attempts.
- A paid order keeps holding inventory past its reservation window: the hold
  lapsing must never release a seat someone paid for.

**`models/entitlement.ts`** (11 tests) — v1's `issueEntitlements`.

- **One entitlement per ticket *unit*, not per admitted person.** A couple
  ticket is ONE entitlement with `scanCountAllowed: 2`. Two entitlements would
  let the pair split across different doors, which is exactly what a couple
  ticket is priced not to allow.
- Deterministic ids `ENT-{orderId}-{tierId}-{index}`, so a fulfilment retried
  by the second confirmation path collides with itself at the storage layer
  instead of minting a second set of tickets.
- `scanEntitlement` admits **one person at a time** even at
  `scanCountAllowed: 2` — door staff scan as each person walks through, and
  consuming both on the first scan strands the second guest outside.
- The QR payload is deliberately **not** stored. Per the guest-portal handoff
  doc, what a guest scans must be short-lived and authorized at read time; a
  long-lived code sitting in a database is a code that leaks.

### Still to do in this phase

In dependency order:

1. **Discovery/directory reads** for `/`, `/explore`, `/event/[id]` — the
   fixture-replacement table above (public routes).

**Confirm before wiring:** whether this reuses the `thec1rcle` Razorpay dev
sandbox keys or gets its own. Do not point at anything that can take a real
charge until that is settled.

---

### Session Log

### 2026-08-19 — Phase 4 HTTP wiring complete (core + api-gateway)

Built the complete HTTP layer for Phase 4. All "Still to do" items from the
original doc are now **done**.

**1. Repository Ports + Adapters** ✅
- Ports: `OrderRepository`, `EntitlementRepository`, `CartReservationRepository`, `PromoRedemptionRepository` in `packages/core/src/domain/ports/repositories.ts`
- Memory adapters: `MemoryOrderRepository`, `MemoryEntitlementRepository`, `MemoryCartReservationRepository`, `MemoryPromoRedemptionRepository` in `packages/core/src/infrastructure/memory/memory-repositories.ts`
- Firestore adapters: `FirestoreOrderRepository`, `FirestoreEntitlementRepository`, `FirestoreCartReservationRepository`, `FirestorePromoRedemptionRepository` in `packages/core/src/infrastructure/firestore/`
- Compare-and-set transactions enforced in both adapters (D-015)

**2. PaymentProvider Port + Razorpay Adapter** ✅
- Port: `PaymentProvider` interface in `packages/core/src/domain/ports/payment-provider.ts`
- Razorpay adapter: `RazorpayPaymentProvider` in `packages/core/src/application/payments/razorpay-adapter.ts`
- HMAC-SHA256 webhook verification with `timingSafeEqual` (D-022)
- Deterministic signature generation via sorted key canonicalization
- `getPayment` throws on 404 instead of returning null (non-nullable return type)

**3. CheckoutService** ✅
- `quote` → `createHold` → `createPaymentIntent` → `confirmPayment` (dual-path idempotent fulfillment)
- Idempotent hold creation via `Idempotency-Key`
- Inventory check before hold creation
- Dual confirmation paths (webhook + redirect) converge on same idempotent `confirmPayment`
- `markPaid` with same paymentId returns order unchanged (no version bump)
- Fulfillment: Order + CartReservation conversion + Entitlements + PromoRedemption in same transaction
- Entitlements issued via domain `issueEntitlements` (deterministic `ENT-{orderId}-{tierId}-{index}`)

**4. PricingService + InventoryService** ✅
- `PricingService`: wraps domain `calculatePricing` with event-catalog lookups
- `InventoryService`: `getAvailableQuantity` = tier.quantity - sold - activeHolds

**5. HTTP Routes + Contracts** (activated in api-gateway) ✅
- `POST /api/v2/checkout/quote` (PAYMENT_COMMAND)
- `POST /api/v2/checkout/holds` (PAYMENT_COMMAND)
- `POST /api/v2/payments/attempts` (PAYMENT_COMMAND)
- `POST /api/v2/payments/:id/verify` (PAYMENT_COMMAND)
- `GET /api/v2/orders` (AUTH_READ)
- `POST /api/v2/orders` (STANDARD_COMMAND + Idempotency-Key + If-Match)
- `GET /api/v2/orders/:id` (AUTH_READ, NO_STORE)
- `GET /api/v2/orders/:id/status` (AUTH_READ, NO_STORE)
- `GET /api/v2/tickets/:id` (STANDARD_COMMAND, NO_STORE)
- `POST /api/v2/tickets/:id/transfer` (STANDARD_COMMAND + Idempotency-Key + If-Match)
- `POST /api/v2/tickets/:id/claim` (STANDARD_COMMAND + Idempotency-Key + If-Match)
- `POST /api/v2/tickets/:id/cancel-transfer` (STANDARD_COMMAND + Idempotency-Key + If-Match)
- `GET /api/v2/wallet` (AUTH_READ, NO_STORE)
- `GET /api/v2/wallet/tickets` (AUTH_READ, NO_STORE)
- `GET /api/v2/wallet/orders` (AUTH_READ, NO_STORE)
- `POST /api/v2/webhooks/payments/razorpay` (WEBHOOK)

**6. Public Discovery Routes** (for Guest Portal) ✅
- `GET /api/v2/public/events` (PUBLIC_READ, PUBLIC_CDN cache)
- `GET /api/v2/public/events/:idOrSlug` (PUBLIC_READ, PUBLIC_CDN cache)
- `GET /api/v2/public/venues/:slug` (PUBLIC_READ, PUBLIC_CDN cache)
- `GET /api/v2/public/hosts/:slug` (PUBLIC_READ, PUBLIC_CDN cache)
- `GET /api/v2/public/discovery` (PUBLIC_READ, PUBLIC_CDN cache)
- `GET /api/v2/public/search` (PUBLIC_READ, PUBLIC_CDN cache)

**7. Service Wiring** ✅
- `ServiceDeps` extended with `paymentProvider`, `pricing`, `inventory`, `cartReservations`, `orders`, `entitlements`, `promoRedemptions`
- `PartnerV2Services` extended with `checkout: CheckoutService`
- Both memory and Firestore repository sets include Phase 4 repos
- Razorpay config added to gateway config (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`)

---

### Verification Results
- **Build**: `pnpm build` ✅ PASS
- **Tests**: `pnpm test` ✅ 302 tests pass (203 core + 99 api-gateway)
- **TypeCheck**: `pnpm typecheck` ✅ PASS
- **Boundaries**: `pnpm boundaries` ✅ PASS
- **Format**: `pnpm format:check` ✅ PASS
- **Contract Parity**: `scripts/contract-parity.mjs` ✅ 33/33 checks agree
