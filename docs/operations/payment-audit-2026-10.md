# Payment audit: business logic, backend and frontend (October 2026)

Scope: the paid-ticket path end to end: quote, hold, payment attempt, Razorpay, verify and webhook,
fulfilment, settlement. Every finding below was reproduced with a test before anything was changed.
"Fixed" means fixed in the PR that carries this document; "Open" means not fixed, with the reason.

## Fixed

| # | Severity | Problem | Fix |
|---|---|---|---|
| 1 | High | **Tickets could be sold for any event, whatever its status.** Only RSVP checked that an event is published. A draft, paused, cancelled or finished event took payments through quote, hold and payment attempt. | Quote and payment-attempt now require a published event. |
| 2 | High | **Promo codes were never checked.** Existence was the only test, so an expired, not-yet-started or switched-off code applied, and `maxRedemptions` / `maxPerUser` never bound. Redemptions were also recorded under the promo *code*, so limits could not have counted them. | Active flag and date window enforced in pricing; total and per-user limits enforced at quote (counting records by promo id and by code, to cover history); redemptions now recorded under the promo id. |
| 3 | High | **A seat awaiting a refund was resold.** Inventory counted only `paid` orders, but an order under refund is `refund_requested` while its buyer still holds a valid ticket. Admin refunds stop at "approved", so that state can last indefinitely. | `refund_requested` counts as sold; only `refunded` returns the seat. |
| 4 | Medium | **An idempotency key could return another buyer's hold** (id, expiry, pricing) because the lookup ignored who sent it, and the hold id was derived from the bare key. | The buyer is part of the key (hashed); a buyer replays only their own hold. |
| 5 | Medium | **A buyer refunded for a late payment was told "payment received".** The auto-refund (reservation expired, seats gone) was an ordinary 400, indistinguishable from a transient failure. | A distinct `payment_refunded` error answered as 409 with `details.outcome = "refunded"`; the checkout UI shows the refund message. |
| 7 | High | **Overselling the last seats.** The availability check and the hold write were separate steps, so simultaneous buyers could all reserve the same last seat. Reproduced on a real Firestore (emulator): 12 simultaneous buyers all kept the one remaining seat; 20 buyers kept holds on a 5-seat tier. | Every hold takes the next position in a strict per-event order inside a Firestore transaction (`v2_hold_sequences/{eventId}`); after it commits, a hold keeps its seats only if what is sold plus the live holds ordered at or before it fits. Proven on the emulator with 12-, 20- and 60-buyer races (exactly capacity, never above, no seat wasted). |
| 8 | Low | Razorpay refuses orders under ₹1 (100 paise); a tiny paid total failed with an opaque provider error after a seat was already held. | Rejected at quote with a clear message. A free (₹0) total is unaffected. |
| 6 | Test | An existing test "corrupted" a webhook signature by setting its first character to `f`, which leaves it valid one time in sixteen. | Always changes the character. |

Existing route fixtures sold tickets for **draft** events, i.e. they depended on bug 1; they now publish
their event first (`test-utils/publish-event.ts`).

## Open (not fixed here)

1. **GST on the guest's fees is a hardcoded 18% (`pricing.ts`).** It contradicts the rule that tax
   assumptions must come from approved, dated rules. The tax-rule store exists (PR #127) but pricing does not
   read it. Changing it alters every price, so it needs the CA's decision first.
2. **Late-capture and per-user-cap races.** A payment landing after its hold expired is re-checked against
   capacity with the old non-atomic check, so two late payments for the very last seat can both pass; the
   per-user ticket cap (`maxPerUser`) has the same check-then-write shape. Both are narrow, and the fix is the
   same ordering idea applied to those paths.
3. **Inventory is counted by scanning every order for the event on every hold** (`getSoldCount`), so hold
   latency grows with sales. Fine for small events, slow for a popular one. A running sold-count per tier fixes it.
4. **The hold lasts 10 minutes and the Razorpay window can outlast it.** A payment that lands after expiry is
   honoured if seats remain, otherwise refunded (now clearly reported). Consider a longer hold for paid checkout.
5. **Refunds never settle** (admin refunds stop at "approved"); see `refund-and-chargeback-decisions.md`.

## How the seat guarantee is tested
`firestore-inventory.integration.test.ts` runs the real Firestore adapters against the emulator. It is skipped
unless `FIRESTORE_EMULATOR_HOST` is set, and CI runs it in the `Firestore emulator tests` job:
`npx firebase-tools emulators:exec --only firestore --project demo-c1rcle "<test command>"`.

## Frontend (guest checkout, PR #72)
- Fixed: a buyer refunded for a late payment is shown the refund message instead of "payment received".
- Fixed: the "processing" message no longer promises the buyer "will not be charged again", which the UI
  cannot guarantee; it now says what to do if tickets do not appear.
- Not a bug but worth knowing: promo codes cannot be entered in the UI yet, and the buyer's name/email/phone
  are sent to Razorpay only as prefill until backend #118 / frontend #70 are deployed.
