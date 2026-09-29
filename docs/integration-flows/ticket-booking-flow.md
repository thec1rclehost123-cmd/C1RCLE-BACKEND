# Ticket booking flow (as built)

**Status:** LIVE for free (RSVP) events end-to-end; paid checkout is backend-ready
but still preview-only in the guest portal. This document describes the
current behavior — it supersedes the aspirational sequence in
`docs/integration-flows/checkout.md` for everything below.

**Frontend:** `C1RCLE-FRONTEND/apps/guest-portal` (event detail → checkout →
confirmation → tickets). **Backend:** `apps/api-gateway` (`/api/v2`),
`packages/core` (services/domain), `packages/contracts` (zod wire schemas,
mirrored into the frontend by `scripts/export-contracts.mjs`).

## 1. Big picture

~~~text
Guest browses event
  -> GET /api/v2/public/events/:idOrSlug (+ venue/host by-id, + /tiers)
  -> /checkout/:slug step 1 select tiers (REAL tier ids)
  -> step 2 attendee details (name + email required)
  -> step 3:
       ₹0 total  -> POST /api/rsvp (BFF) -> POST /api/v2/rsvp
                    -> /confirmation/:orderId (REAL order + pass)
       priced    -> preview confirmation (NO charge, same as before)
Logged-in guest opens /tickets
  -> GET /api/wallet/tickets (BFF) -> real entitlement cards
~~~

The backend is authoritative for eligibility, price, inventory, order state,
and ticket issuance. The frontend never invents those values; fixture data is
used only for the six hardcoded fixture slugs and the logged-out showcase.

## 2. RSVP flow (free events) — the live path

Eligibility (ALL must hold): event `status == published` **and**
`event.isFree == true` **and** tier price is zero. Quantity is fixed at **1** —
one RSVP ticket per account per event. No Razorpay, no holds, no promo or
referral codes.

### 2.1 Sequence

~~~text
Browser (step 3, ₹0 total, exactly 1 ticket selected)
  -> POST /api/rsvp { eventId, tierId }           [Next.js BFF, same-origin + CSRF]
       -> POST /api/v2/rsvp                       [gateway, session auth]
            CheckoutService.createRsvp:
              1. reject anonymous/system actors (401)
              2. resolve event by id OR slug -> 404 if missing
              3. reject non-published / non-free events (400)
              4. load tier, must belong to event + active (404/400)
              5. effective price must be 0 (400) — see §6 legacy tolerance
              6. deterministic order id -> paid order exists? 409 Conflict
              7. inventory assertAvailable(event, tier, 1) (400 if sold out)
              8. save Order(status: paid, all totals 0, paymentId = order id)
                 (+ converge on winner if a double-tap won the save race)
              9. issueEntitlements -> save -> return { order, entitlements }
            <- 201 { order, entitlements }         [same shape as payment verify]
       <- 201 passthrough
  -> router.push(/confirmation/:orderId)
409 duplicate -> inline "already on the list" + link to /tickets
401           -> login redirect (BFF client handler)
~~~

Key files:

| Layer | File |
|---|---|
| UI state machine | `apps/guest-portal/src/features/booking/components/CheckoutFlowClient.tsx` (`confirmRsvp`, `isFreeBooking`, `canConfirmRsvp`) |
| Checkout data | `apps/guest-portal/src/app/checkout/[id]/page.tsx` (event + venue + tiers reads), `features/booking/booking-mapping.ts` (`toBookingEventFixture(event, venue, tiers)`) |
| BFF proxy | `apps/guest-portal/src/app/api/rsvp/route.ts` (same-origin + CSRF, session-cookie forward, fresh `Idempotency-Key`) |
| Route | `apps/api-gateway/src/routes/v2/rsvp/rsvp-routes.ts` (thin; `runIdempotent`, `commandName: rsvp.create`) |
| Service | `packages/core/src/application/checkout/checkout-service.ts` (`createRsvp`, `rsvpOrderId`) |
| Contracts | `packages/contracts/src/contracts/checkout.ts` (`rsvpRequestSchema`, `rsvpResponseSchema`) |

### 2.2 Deterministic identity (double-tap safety)

- Order id: `RSVP-<sha256(eventId:userId)[0:32]>`, computed from the
  **resolved** event id so id- and slug-addressed calls converge. A sequential
  second RSVP is a 409 `ConflictError`; a concurrent double-tap converges on
  the winner via the `VersionConflictError` path (same pattern as
  `confirmPayment`'s webhook/redirect race).
- Entitlement ids: `ENT-<sha256(orderId:tierId:index)[0:32]>` (one per ticket
  *unit*; a couple ticket is one entitlement with `scanCountAllowed: 2`).
- No `CartReservation` row is created; no `PromoRedemption`; no ledger/
  leaderboard settlement (a ₹0 order contributes nothing).

## 3. Paid flow — backend ready, UI preview-only

The full paid pipeline exists and is tested, but the guest portal does not
call it yet — priced checkouts still end at `/confirmation/preview-:id`
without charging:

~~~text
POST /checkout/quote              pure pricing (subtotal -> discount ->
                                  5% platform + 2.5% payment fees on the
                                  DISCOUNTED subtotal -> 18% GST on fees only;
                                  integer paise throughout)
POST /checkout/holds               + Idempotency-Key, ~10 min TTL (HOLD-:key)
POST /payments/attempts            Razorpay intent + keyId
POST /payments/:id/verify          HMAC verify -> confirmPayment (redirect path)
POST /webhooks/payments/razorpay   HMAC verify -> confirmPayment (webhook path;
                                  dual-path idempotent, first writer wins)
GET /orders, /orders/:id, /orders/:id/status   (buyer-only, 404 never 403)
~~~

Auth is enforced on quote/holds/attempts/verify (401 for anonymous/system
actors); the webhook stays HMAC + system-actor. Wiring the portal's priced
path to this pipeline is the remaining checkout work — the RSVP slice was
built to not block it (shared `{ order, entitlements }` response shape).

## 4. Reads: confirmation + wallet

- **Confirmation** (`/confirmation/:id`): fixture ids render fixtures
  (unchanged preview); otherwise the server page reads `GET /api/v2/orders/:id`
  (buyer-scoped, cookie-authenticated — strangers get 404) plus the public
  event/venue, and maps to the same `ConfirmationView`. BFF helper
  `GET /api/orders/:id` exists for client use.
- **Wallet** (`/tickets`, authenticated): BFF `GET /api/wallet/tickets` →
  `GET /api/v2/wallet/tickets` (caller-scoped entitlements) →
  `toTicketWalletData` groups by order+tier into cards (`ticketCount` = bundle
  size) and resolves each card's event display via public reads. Tabs:
  **upcoming** = `valid` + event not ended; **history** = `redeemed`/`void` or
  ended. Statuses map `valid→active`, `redeemed→used`, `void→cancelled`.
  Unresolvable events are skipped; failures/empty render the empty state —
  never fixtures. Logged-out visitors keep the ticket showcase.
- **Single ticket** (`GET /tickets/:id`, `GET /wallet`, `GET /wallet/orders`)
  follow the same ownership rules. Transfer/claim routes are deliberately
  absent (the `Entitlement` model has no transfer state).

## 5. Data map

| Record | Collection | Id | Notes |
|---|---|---|---|
| Order (RSVP: `paid`, totals 0, `paymentId` = order id, no intent) | `v2_orders` | `RSVP-<sha>` | Contact is placeholder (`RSVP Guest`); pricing frozen at 0 |
| Order (paid) | `v2_orders` | `ORD-<providerPaymentId>` | Frozen pricing breakdown, dual-path idempotency |
| Ticket | `v2_entitlements` | `ENT-<sha>` | `userId` = buyer; QR payload deliberately NOT stored |
| Hold (paid only) | `v2_cart_reservations` | `HOLD-<idempotencyKey>` | TTL ~10 min; RSVP creates none |
| Tier catalog | `v2_event_catalog_tiers` | UUID | May predate `priceInPaise` — see §6 |

There is no `v2_rsvp_orders` collection (an old roadmap line only): RSVPs are
zero-total rows in `v2_orders`, so inventory (`quantity − sold − activeHolds`),
wallet, and scanner all account for them with no special cases.

## 6. Cross-cutting rules

- **Auth:** any ticket booking requires an authenticated account (service
  guard + route guards + firestore `buildActorContext`). Reads are
  owner-scoped with IDOR-safe 404s.
- **Idempotency:** `Idempotency-Key` on holds/attempts (required) and
  RSVP/verify (optional correctness bonus); `runIdempotent` replays stored
  responses, 409 on key reuse with a different body.
- **Inventory:** `effective = quantity − sold(paid orders) − activeHolds`;
  `InventoryService` is the only reader both paths use.
- **Legacy tier tolerance:** tiers written before `priceInPaise` existed price
  via `effectiveTierPricePaise` (`priceInPaise ?? doorPriceInPaise ?? 0`) in
  RSVP and the public tiers listing. Callers still gate free-vs-paid on
  `event.isFree`, never on this helper alone.
- **Public tiers:** `GET /api/v2/public/events/:idOrSlug/tiers` lists
  `active` tiers only as `{ id, eventId, name, description, priceInPaise,
  currency, availableQuantity }` (no bounds, no versions). Non-public events
  404 like the event-detail read.
- **Firestore without composite indexes (repo convention):**Forestall
  `FAILED_PRECONDITION` by keeping hot reads index-free — `orders.listByEvent`
  (unordered; sole caller sums everything), `holds.listActiveByEvent`
  (single-field filter, active/expiry filtered in code), and all order/
  entitlement `listByUser/listByEvent/listByOrganization` (single-field
  filter + `paginateUnordered`, newest-first sort in code; cross-page order
  is approximate). If a new `where+orderBy` read is added, either keep it
  index-free or provision the composite index in the Firebase console —
  otherwise it 500s at runtime on a fresh project.
- **Money:** integer paise everywhere; `assertReconciles` on every pricing
  calc; GST on fees only (tax position, pinned by tests).

## 7. Test map

| Suite | File | Covers |
|---|---|---|
| RSVP routes | `apps/api-gateway/src/routes/v2/rsvp/rsvp-routes.test.ts` (8) | fulfill ₹0 + entitlement, 409 repeat, per-account scope, paid-event/tier/draft 400s, 404s, last-ticket inventory |
| RSVP service | `packages/core/src/application/checkout/checkout-service.test.ts` (5) | legacy tier shape, paid-legacy rejection, auth, id/slug convergence, unpublished rejection |
| Public tiers | `apps/api-gateway/src/routes/v2/public/public-tiers.test.ts` (5) | price + availability, id/slug, paused hidden, empty list, 404 |
| Portal checkout | `apps/guest-portal/src/app/checkout/[id]/page.test.tsx` | 3-step preview, real-tier ids, fallback tier, RSVP post + nav, 409 state |
| Portal booking | `features/booking/booking-mapping.test.ts` | fallback tier, real-tier mapping + caps, sold-out cap 0 |
| Portal tickets | `apps/guest-portal/src/app/tickets/page.test.tsx`, `features/tickets/wallet-mapping.test.ts` | guest showcase, real wallet, empty/failure states, history tab, modal; grouping, history split, unresolvable skip |

## 8. Known gaps / follow-ups

1. Priced guest checkout still ends at the preview confirmation — wire it to
   §3 when real charges are approved (Razorpay keys in use are LIVE).
2. Ticket modal is a decorative preview; real short-lived scannable QR per
   the handoff rule is not built.
3. `/tickets` shows passes only; order history/totals (`/wallet/orders`) and
   guest-list RSVP counts are not surfaced.
4. RSVP contact is a placeholder and promo/referral codes are not accepted
   on RSVP.
5. Any future `where+orderBy` Firestore read needs either the index-free
   treatment (§6) or a provisioned composite index, or it 500s.
