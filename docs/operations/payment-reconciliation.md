# Payment reconciliation

For every payment, the backend keeps what **Razorpay** reports about it, separately from the
settlement ledger, so finance can compare the two per order.

## What is recorded
Collection `v2_provider_payments`, one document per Razorpay payment id:

| Field | Source event |
|---|---|
| captured amount, currency, Razorpay's **fee** and **tax on the fee** | `payment.captured` |
| refunds (by Razorpay refund id) | `refund.processed` |
| disputes (by dispute id) and their status | `payment.dispute.created / action_required / under_review / won / lost / closed` |
| our order id (once the capture is fulfilled) | set by the webhook after fulfilment |

Events can arrive in any order and more than once. Updates are keyed by Razorpay's own ids, so a
replay changes nothing, and a late "dispute opened" cannot undo a final outcome.

## What it does NOT do
It changes **no balance** and writes **nothing to the partner ledger**. Who bears a refund, a
chargeback or Razorpay's fee is a finance decision that is still open; recording the provider's
facts does not decide it. Partner-facing responses are unchanged.

## Reconciling an order
`providerPayments.reconcileOrder(orderId)` compares the order with the provider's record and
reports, per order: missing provider record, amount mismatch, currency mismatch, a refund the
provider made that the order does not show, and any open dispute. It also returns the provider's
net for the payment: captured, less its fee and tax, refunds and disputes it took back.
Over HTTP (any platform admin, read-only): `GET /admin/finance/reconciliation/:orderId`.

## Razorpay setup
In the Razorpay dashboard's webhook, tick these events (in addition to `payment.captured`):
`refund.processed` and the `payment.dispute.*` events. Everything else stays unticked; unknown
events are acknowledged and ignored.

## Not built yet
A refund *executor* (the admin refund flow stops at "approved" on purpose), a bulk/list
reconciliation report, and any ledger entries for refunds, chargebacks or provider fees.
The last needs the finance decision above first.
