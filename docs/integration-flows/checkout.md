# Checkout integration flow

**Status:** target integration flow; current Guest Portal checkout is fixture-only.
**Frontend:** apps/guest-portal checkout and confirmation routes.
**Backend contract:** /api/v2 checkout, orders, payment-intents, and tickets.

## Authority rules

The backend is authoritative for event publication, tier availability, price,
fees, inventory reservation, order status, payment verification, and ticket
issuance. The frontend never calculates or confirms those values as truth.

The current route source uses booking fixtures and explicitly labels the page
as a preview. It must not silently switch to fixtures after an API failure.

## Sequence

~~~text
Guest opens public event
  -> GET /api/v2/public/events/:idOrSlug
  -> POST /api/v2/checkout/quotes
  -> POST /api/v2/checkout/reservations + Idempotency-Key
  -> POST /api/v2/orders + Idempotency-Key
  -> POST /api/v2/orders/:orderId/payment-intents + Idempotency-Key
  -> provider UI uses client-safe options
  -> provider returns payment identifiers to frontend
  -> POST /api/v2/payments/:paymentId/confirm + Idempotency-Key
  -> backend verifies provider signature/webhook state
  -> GET /api/v2/orders/:orderId
  -> GET /api/v2/me/tickets
~~~

Webhook processing remains backend-only. The browser does not call the webhook
endpoint, verify signatures, or issue tickets.

## Frontend responsibilities

1. Load the public event and show backend-provided tier/price data.
2. Collect quantity, attendee details, and optional promo code.
3. Request a quote and display its expiry.
4. Create one reservation with a stable idempotency key per user intent.
5. Create or resume the order without duplicating it on double-click/reload.
6. Open the provider UI only with backend-provided client-safe options.
7. Send provider result identifiers to the backend confirmation endpoint.
8. Poll/refetch order state only through the API client when confirmation is
   pending; use bounded backoff and stop on terminal state.
9. On success, load the order/ticket projection and render confirmation.
10. On failure, preserve a safe recovery path without claiming payment success.

## Backend responsibilities

- Revalidate event publication, price, fees, tier, and inventory.
- Atomically hold inventory and expire reservations.
- Enforce authentication and ownership for order/payment operations.
- Require and persist idempotency keys for repeatable commands.
- Create provider payment intent/order with server-controlled amount.
- Verify provider signatures and webhook state.
- Transition order state exactly once and issue tickets only after payment truth.
- Return stable error codes, request IDs, and safe projections.
- Make recovery reads safe after browser refresh, timeout, or lost response.

## State machine

| UI state | Backend state | Frontend behavior |
| --- | --- | --- |
| quote loading | none | Disable submit; show loading |
| quote ready | quote valid | Show expiry and authoritative total |
| reservation pending | hold requested | Prevent duplicate submission |
| reservation expired | EXPIRED | Refresh quote; ask user to retry |
| order pending | PENDING_PAYMENT | Continue to payment or recovery |
| payment processing | PROCESSING | Show pending; bounded refetch |
| paid | PAID | Load order/tickets and show confirmation |
| payment failed | FAILED | Show retry/recovery; never issue pass |
| conflict/unavailable | conflict code | Refresh event/quote; preserve user input where safe |
| unknown/network | unknown | Show retry and request ID if available |

## Recovery rules

- Refresh on checkout must recover by order ID only when the order is owned by
  the current session.
- A provider success callback is not payment proof; confirmation is pending
  until backend state says PAID.
- If the browser loses the response after an idempotent command, retry with the
  same key or read the resource. Never create a new key automatically.
- If the session expires, preserve only non-sensitive form input and require
  re-authentication before private order reads.
- Confirmation and wallet pages must not use static params for private order
  data or public caches.

## Test matrix

- Quote changes when inventory or price changes.
- Reservation expiry and duplicate-click idempotency.
- Order creation after refresh/network timeout.
- Provider success followed by delayed webhook.
- Provider failure, cancellation, and signature mismatch.
- Duplicate payment confirmation.
- Cross-user order/ticket access.
- Ticket issuance exactly once.
- Backend 401, 403, 404, 409, 422, 429, and 503 mapping.
- Browser back/refresh at every sequence step.
- Real staging provider sandbox proof before production enablement.

## Done criteria

Checkout is integrated only when OpenAPI schemas, backend contract tests,
frontend decoder tests, staging sandbox payment proof, recovery proof, and
ticket-wallet proof all pass. A polished fixture checkout is not integration
evidence.
