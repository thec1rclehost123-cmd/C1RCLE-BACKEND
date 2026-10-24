# Payments release gate

Real ticket money must not be distributed to partners until three things are on file in writing:

1. **Funds flow** — who sells the ticket, who receives the money, who earns the platform fee, and
   who is entitled to the remainder; confirmed by an Indian payments lawyer and by Razorpay
   (including whether Razorpay Route supports the model). Collecting everything into
   THEC1RCLE's own account and paying partners later raises a payment-aggregation question under
   RBI's 2025 Payment Aggregator Directions that has **not** been answered.
2. **Tax treatment** — ticket GST, GST on the convenience fee, TDS (s.194-O) and GST TCS (s.52),
   decided by a CA against the real business model.
3. **Provider approval** — Razorpay's written approval of the actual configuration.

## What the gate does

`PAYOUTS_ENABLED` (gateway env). Unset means **on outside production, off in production**.
When off, these return `503 Payouts are not enabled on this deployment.` before any service runs:

| Action | Route |
|---|---|
| Partner requests a payout | `POST /organizations/:organizationId/payouts` |
| Admin batch run | `POST /admin/payouts/batch-run` |
| Admin releases a frozen payout | `POST /admin/proposals/:proposalId/release-payout` |

**Stays available when off:** freezing a payout (a safety action), every read, and all of checkout
and fulfilment. `render.yaml` sets it to `false`.

## Turning it on
Only after items 1-3 above are documented and signed off. Record who approved and when, then set
`PAYOUTS_ENABLED=true` and deploy. The gate is a switch, not the compliance work itself.
