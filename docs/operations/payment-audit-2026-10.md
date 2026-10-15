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
| 9 | High | **A late payment could take a seat a new buyer had just reserved.** A payment landing after its hold expired was re-checked with the old non-atomic check, so a late payer and a new buyer racing for the last seat could both get it. Reproduced deterministically on the Firestore emulator (late payer honoured *and* new buyer kept). | The lapsed hold is re-activated through the same ordered-position protocol as a fresh one, then re-checked; if the seats are gone the hold is released and the payment refunded (once, idempotently). New repository method `reactivate`. |
| 10 | Medium | **One buyer could exceed their per-user ticket cap** by firing requests in parallel (8 parallel requests against a cap of 2 produced 8 holds). | Verified after the write, counting the buyer's other holds ordered at or before this one. |
| 11 | Medium | **Hold latency grew with every order sold.** Counting sold seats paged through whole orders of every status. Measured on the emulator (no network latency): 1,000 orders 0.26 s, 3,000 0.9 s, 6,000 3.0 s per count, and a hold counts twice. | One streamed read of only each order's status and lines (`listSeatClaims`): 6,000 orders now 0.2 s (about 14x faster), identical results. A running counter was deliberately not added: one that drifts would bring overselling back. Revisit if events routinely exceed ~20,000 orders. |
| 6 | Test | An existing test "corrupted" a webhook signature by setting its first character to `f`, which leaves it valid one time in sixteen. | Always changes the character. |

Existing route fixtures sold tickets for **draft** events, i.e. they depended on bug 1; they now publish
their event first (`test-utils/publish-event.ts`).

## Open (not fixed here)

1. **GST on the guest's fees is a hardcoded 18% (`pricing.ts`).** It contradicts the rule that tax
   assumptions must come from approved, dated rules. The tax-rule store exists (PR #127) but pricing does not
   read it. Changing it alters every price, so it needs the CA's decision first.
2. **Hold length (10 minutes) is a business decision, not a defect.** Late payments are now handled safely
   (revived and re-checked, or refunded), so a longer hold would only trade seat availability for fewer
   refunds. `DEFAULT_HOLD_TTL_MS` is the one place to change it.
3. **Refunds never settle** (admin refunds stop at "approved"); see `refund-and-chargeback-decisions.md`.

## How the seat guarantee is tested
`firestore-inventory.integration.test.ts` and `firestore-late-capture.integration.test.ts` run the real
Firestore adapters against the emulator. They are skipped unless `FIRESTORE_EMULATOR_HOST` is set, and CI
runs every test in `src/infrastructure/firestore` in the `Firestore emulator tests` job. Note: the late-payment
race is only exposed reliably by widening the gap between the capacity decision and the order write (a random
race did not hit it in 8 tries), so that test injects the delay deliberately.
`npx firebase-tools emulators:exec --only firestore --project demo-c1rcle "<test command>"`.

## Frontend (guest checkout, PR #72)
- Fixed: a buyer refunded for a late payment is shown the refund message instead of "payment received".
- Fixed: the "processing" message no longer promises the buyer "will not be charged again", which the UI
  cannot guarantee; it now says what to do if tickets do not appear.
- Not a bug but worth knowing: promo codes cannot be entered in the UI yet, and the buyer's name/email/phone
  are sent to Razorpay only as prefill until backend #118 / frontend #70 are deployed.
