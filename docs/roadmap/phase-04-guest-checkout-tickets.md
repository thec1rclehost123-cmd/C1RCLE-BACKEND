# Phase 4 — Guest checkout & tickets

**Status:** not started · **Depends on:** Phase 3 (event-catalog/tiers)

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

(none yet)
