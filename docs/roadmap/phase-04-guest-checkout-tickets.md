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

1. **Inventory engine** — `calculateEffectiveInventory` with sharded counters
   and Redis cart-reservations; `strictMode` circuit breaker (503 +
   `Retry-After` on Redis degradation, default fails open to a Firestore count).
2. **Ports + adapters** — `OrderRepository`, `EntitlementRepository`,
   `CartReservationRepository`, `PromoRedemptionRepository`; memory + Firestore.
3. **`PaymentProvider` port** — same pluggable shape as `VerificationProvider`
   (Phase 2, D-018), so checkout is testable without real charges. Razorpay
   adapter behind it; **webhook HMAC verification is not optional** and needs
   its own tests.
4. **`CheckoutService`** — calculate → reserve → intent → confirm, with promo
   redemption and referral attribution captured at purchase.
5. **Routes + contracts** — guest checkout, ticket wallet, and the webhook
   endpoint. The wallet needs short-lived authorized QR issuance.
6. **Discovery/directory reads** for `/`, `/explore`, `/event/[id]` — the
   fixture-replacement table above.

**Confirm before wiring:** whether this reuses the `thec1rcle` Razorpay dev
sandbox keys or gets its own. Do not point at anything that can take a real
charge until that is settled.
