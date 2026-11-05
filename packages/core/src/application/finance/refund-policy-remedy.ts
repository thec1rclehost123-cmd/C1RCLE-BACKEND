import { createHash } from 'node:crypto';

import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { quoteOriginalRefund } from '../../domain/models/purchase-refund-snapshot.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import type {
  RefundCause,
  RefundComponents,
} from '../../domain/models/purchase-refund-snapshot.js';
import type { ServiceDeps } from '../context.js';

/** Supplement a settled Guest admission refund with original fees owed after
 * an authoritative policy promotion. No provider call, ticket effect or new
 * approval rule: this only enters the canonical atomic refund workflow. */
export async function requestOriginalPolicyRemedy(
  deps: Pick<ServiceDeps, 'repositories' | 'config'>,
  input: {
    originalRequestId: string;
    requestedBy: string;
    cause: RefundCause;
    eventVersion: number;
  },
) {
  const repos = deps.repositories;
  const original = await repos.refundRequests.getById(input.originalRequestId);
  if (!original) throw new NotFoundError('Refund request', input.originalRequestId);
  if (
    original.status !== 'settled' ||
    original.refundCause !== 'guest_request' ||
    !original.refundComponents ||
    original.targetEntitlementIds.length === 0 ||
    !['organizer_cancel', 'material_change'].includes(input.cause)
  )
    throw new InvalidOperationError(
      'A policy remedy requires a settled original Guest ticket refund and qualifying change',
    );
  const order = await repos.orders.getById(original.orderId);
  if (!order) throw new NotFoundError('Order', original.orderId);
  const id = `REF-REMEDY-${createHash('sha256').update(original.id).digest('hex').slice(0, 32)}`;
  const existing = await repos.refundRequests.getById(id);
  if (existing) {
    if (existing.orderId !== order.id || existing.remedyForRefundRequestId !== original.id)
      throw new ConflictError('Policy remedy request identity does not match');
    return { request: existing, order };
  }
  if (order.status !== 'paid')
    throw new ConflictError('Another refund must finish before requesting the policy remedy');
  const [tickets, requests, settings] = await Promise.all([
    repos.entitlements.getByOrderId(order.id),
    repos.refundRequests.listByOrder(order.id),
    repos.platformSettings.get(),
  ]);
  if (
    requests.some((request) =>
      ['pending', 'approved', 'executing', 'failed'].includes(request.status),
    )
  )
    throw new ConflictError('Another refund must finish before requesting the policy remedy');
  if (
    original.targetEntitlementIds.some(
      (id) => !tickets.some((ticket) => ticket.id === id && ticket.status === 'void'),
    )
  )
    throw new ConflictError(
      'Original admission refund must finish invalidating its selected tickets',
    );
  const full = quoteOriginalRefund(order, original.targetEntitlementIds, input.cause);
  const components: RefundComponents = {
    admissionPaise: 0,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    feeTaxPaise: 0,
    otherPaidPaise: 0,
  };
  for (const key of Object.keys(components) as (keyof RefundComponents)[]) {
    const remaining = full.components[key] - original.refundComponents[key];
    if (!Number.isSafeInteger(remaining) || remaining < 0)
      throw new ConflictError('Original refund components do not support this policy remedy');
    components[key] = remaining;
  }
  const amountPaise =
    components.admissionPaise +
    components.platformFeePaise +
    components.paymentFeePaise +
    components.feeTaxPaise +
    components.otherPaidPaise;
  if (amountPaise <= 0 || order.refundedPaise + amountPaise > order.grandTotalPaise)
    throw new InvalidOperationError('No supported remaining policy remedy is available');
  const now = deps.config.clock.now();
  const request = createRefundRequest({
    id,
    orderId: order.id,
    organizationId: order.organizationId,
    requestedBy: input.requestedBy,
    reason: `Original fees owed after qualifying event change; source refund ${original.id}`,
    remedyForRefundRequestId: original.id,
    intakeFingerprint: createHash('sha256')
      .update(
        JSON.stringify({ original: original.id, order: order.id, components, cause: input.cause }),
      )
      .digest('hex'),
    amountPaise,
    refundCause: input.cause,
    refundComponents: components,
    purchasePolicyVersion: full.purchasePolicyVersion,
    sourceEventVersion: input.eventVersion,
    scope: 'amount_only',
    ticketLines: [],
    targetEntitlementIds: [],
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
    expectedEventVersion: input.eventVersion,
    expectedEntitlementVersions: tickets.map(({ id, version }) => ({ id, version })),
    now,
  });
}
