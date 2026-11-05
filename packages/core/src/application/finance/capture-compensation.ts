import { createHash } from 'node:crypto';

import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { quoteOriginalRefund } from '../../domain/models/purchase-refund-snapshot.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import type { ServiceDeps } from '../context.js';

/**
 * Internal checkout recovery only. Creates the same durable, approval-gated
 * refund request used by Admin execution; it never calls the provider or
 * grants approvals. A captured purchase that could not grant admission is
 * retained for reconciliation while its entire original payment is owed back.
 */
export async function requestCaptureCompensation(
  deps: Pick<ServiceDeps, 'repositories' | 'config'>,
  orderId: string,
) {
  const repos = deps.repositories;
  const order = await repos.orders.getById(orderId);
  if (!order) throw new NotFoundError('Order', orderId);
  if (!order.compensationRequired || order.fulfillmentState !== 'pending' || !order.paymentId)
    throw new InvalidOperationError(
      'Capture compensation requires a blocked, unfulfilled purchase',
    );
  const id = `REF-COMP-${createHash('sha256').update(order.id).digest('hex').slice(0, 32)}`;
  const existing = await repos.refundRequests.getById(id);
  if (existing) {
    if (
      existing.orderId !== order.id ||
      existing.organizationId !== order.organizationId ||
      existing.refundCause !== 'fulfillment_failure'
    )
      throw new ConflictError('Capture compensation request identity does not match');
    return { request: existing, order };
  }
  if (order.status !== 'paid' || order.refundedPaise !== 0)
    throw new InvalidOperationError(
      'Capture compensation requires the original unpaid-refund balance',
    );
  const [tickets, payment, event, journals, settings] = await Promise.all([
    repos.entitlements.getByOrderId(order.id),
    repos.providerPayments.findByPaymentId(order.paymentId),
    repos.events.getById(order.eventId),
    repos.financialJournals.findBySource('online_payment_capture', order.id),
    repos.platformSettings.get(),
  ]);
  if (tickets.length !== 0)
    throw new ConflictError('Issued admissions require exact-ticket refund review');
  if (
    !payment ||
    payment.providerOrderId !== order.paymentIntentId ||
    (payment.orderId !== null && payment.orderId !== order.id) ||
    payment.currency !== order.currency ||
    payment.capturedPaise !== order.grandTotalPaise ||
    Object.keys(payment.refunds).length !== 0
  )
    throw new ConflictError('Capture compensation requires matching original provider capture');
  if (
    !event ||
    !['collection', 'allocation'].every((kind) =>
      journals.some(
        (journal) =>
          journal.idempotencyKey === `m2:ticket-sale:${order.id}:${kind}` &&
          journal.source.paymentId === order.paymentId &&
          journal.organizationId === order.organizationId,
      ),
    )
  )
    throw new ConflictError(
      'Capture compensation requires canonical event and original sale accounting',
    );
  const quoted = quoteOriginalRefund(
    order,
    order.refundSnapshot?.tickets.map((ticket) => ticket.entitlementId) ?? [],
    'fulfillment_failure',
  );
  if (quoted.amountPaise !== order.grandTotalPaise)
    throw new ConflictError('Capture compensation must return the full original paid amount');
  const now = deps.config.clock.now();
  const request = createRefundRequest({
    id,
    orderId: order.id,
    organizationId: order.organizationId,
    // Attribution is an opaque entity ID, not an ActorContext authority token.
    requestedBy: 'system_checkout_compensation',
    reason: `Captured purchase could not grant admission: ${order.compensationRequired.reason}`,
    intakeFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          orderId: order.id,
          paymentId: order.paymentId,
          amount: quoted.amountPaise,
          reason: order.compensationRequired.reason,
          policy: quoted.purchasePolicyVersion,
        }),
      )
      .digest('hex'),
    amountPaise: quoted.amountPaise,
    refundComponents: quoted.components,
    refundCause: quoted.cause,
    purchasePolicyVersion: quoted.purchasePolicyVersion,
    sourceEventVersion: event.version,
    scope: 'amount_only',
    targetEntitlementIds: [],
    ticketLines: [],
    hasRedeemedEntitlement: false,
    thresholds: {
      singleApproverCeilingPaise: settings.refundSingleApproverThresholdPaise,
      dualApproverCeilingPaise: settings.refundDualApproverThresholdPaise,
    },
    now,
  });
  return repos.orders.beginRefundRequest({
    request,
    expectedOrderVersion: order.version,
    expectedEventVersion: event.version,
    expectedEntitlementVersions: [],
    now,
  });
}
