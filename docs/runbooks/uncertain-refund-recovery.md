# Uncertain refund recovery

This procedure records provider evidence and uses the existing authorized refund
execution path to finish internal effects. It does not initiate another refund.
It applies to `executing` requests, including those with no saved provider refund ID.

## Preconditions

- Obtain approval for the environment and any connected provider/data action.
  Local test evidence does not authorize a real recovery. Use `c1rcle-v2` and
  Razorpay Test Mode for connected acceptance; never Live credentials.
- Use a valid platform admin session authorized for `FINANCIAL_REFUND`. Organization
  membership alone grants no authority. Existing approval thresholds still apply.
- Read the request and order through the supported admin API. Record request ID,
  order/payment ID, amount, currency, execution receipt/key, status, and ticket locks.
  Do not copy tokens, customer details or raw provider payloads into reports.

## Establish the provider fact

1. If the request has a saved refund ID, use that ID. It cannot be replaced.
2. If its response was lost and no ID is saved, find the candidate in the approved
   Razorpay Test dashboard or payment-refunds read API, matching the original
   `executionIdempotencyKey` to the refund's `receipt`. Record the evidence reference
   and investigation reason. A refund ID supplied by an operator is only a hint.
3. Submit the supported command using the usual authenticated admin client and a
   fresh idempotency key for this investigation intent:

   `POST /api/v2/admin/refunds/{refundRequestId}/reconcile`

   ```json
   {
     "providerRefundId": "rfnd_PROVIDER_RECORD",
     "reason": "Approved investigation reference and reason"
   }
   ```

   The server fetches `GET /payments/{paymentId}/refunds/{refundId}` using configured
   provider credentials. It compares ID, payment, amount, currency and receipt with
   the persisted request/order. Operators cannot supply status, amount or receipt.
   Conflicting saved terminal/provider webhook facts are refused. Requested and
   verified-observation audit records include actor, target, reason and request metadata.
   Audit failure prevents recording a recovered fact. Observation audit records describe
   fetched evidence, not completion of accounting. Optimistic Firestore versions reject
   competing stale recovery writes.
4. Read the current request after the response. Reconciliation records the provider
   fact but retains the execution/order/ticket locks. It does not yet apply journals
   or ticket changes. Replaying the same idempotency key replays the original response;
   use a new intent key for a later status refresh, followed by an authoritative GET.

## Complete internal effects

- **processed:** invoke the existing `POST /api/v2/admin/refunds/{id}/execute` command.
  Because the provider ID is persisted, execution resumes internal convergence without
  another provider refund POST. Verify request settlement, order refunded amount,
  selected/full ticket voiding, provider record and journal consistency.
- **pending:** keep locks. Wait for authoritative provider completion/webhook and repeat
  the read-only reconciliation with a fresh intent key. Pending is not refunded.
- **failed:** invoke existing execute to finalize failure and release locks. Verify the
  request is failed, the order restored with unchanged refunded amount, and tickets
  remain valid. A failed record is not permission to issue a different refund blindly.
- If persistence or internal convergence fails, read state and retry the same supported
  commands. Never manually alter Firestore or provider IDs. A recorded ID fences further
  provider refund POSTs. Known financial effects retain their existing idempotency rules.

## No ID or insufficient/conflicting evidence

If no refund ID exists anywhere, lookup returns 404, reads time out, receipts are
missing/mismatched, multiple records appear to represent the same attempt, or provider
and saved facts disagree: **leave the request executing and keep all locks**. Escalate
through the approved provider-support process. Absence of a search result, an elapsed
waiting period or a payment's aggregate refunded total is not proof that this specific
attempt was rejected. This implementation has no manual status override or force-unlock.
If support cannot establish a correlatable record, obtain a separate approved recovery
decision; do not fabricate a provider fact to close the case.

The older creation adapter supplies the execution key as `receipt`, not the
`X-Refund-Idempotency` header. Razorpay documents these as different fields. Consequently,
this procedure must not replay the provider refund POST, even with the old receipt. A
future provider-idempotent creation/retry change requires its own exact-payload and
historical-attempt safety proof. No such retry capability is enabled here.

## Evidence boundary

Local focused tests use synthetic provider HTTP responses. The narrow loopback Emulator
check proves recovered-fact persistence and stale-write protection, not real provider
state, email delivery, deployed IAM/rules or launch readiness. Connected acceptance and
full partial/full refund/reversal accounting remain later approved packets.

Provider references: [specific payment refund](https://github.com/razorpay/razorpay-python/blob/master/documents/refund.md),
[idempotent refund requests](https://github.com/razorpay/markdown-docs/blob/master/api/refunds/normal-refunds-idempotent.md).
