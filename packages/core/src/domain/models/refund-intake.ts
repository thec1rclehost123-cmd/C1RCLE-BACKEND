import { ConflictError, InvalidOperationError } from '../errors.js';

import { freezeEntitlementForRefund } from './entitlement.js';
import { lockOrderForRefund, refundableBalance } from './order.js';

import type { Entitlement } from './entitlement.js';
import type { Event } from './event.js';
import type { Order } from './order.js';
import type { AdminRefundRequest } from './refund-request.js';

export interface RefundIntakeInput {
  request: AdminRefundRequest;
  expectedOrderVersion: number;
  expectedEventVersion?: number;
  /** Every ticket used to evaluate approval requirements, not only refund targets. */
  expectedEntitlementVersions: { id: string; version: number }[];
  now: Date;
}

function intent(request: AdminRefundRequest): string {
  return JSON.stringify({
    actor: request.requestedBy,
    order: request.orderId,
    organization: request.organizationId,
    fingerprint: request.intakeFingerprint,
    remedyFor: request.remedyForRefundRequestId ?? null,
    amount: request.amountPaise,
    scope: request.scope,
    reason: request.reason,
    targets: [...request.targetEntitlementIds].sort(),
    lines: request.ticketLines
      .map(({ tierId, quantity }) => [tierId, quantity])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cause: request.refundCause ?? null,
    policy: request.purchasePolicyVersion ?? null,
    components: Object.entries(request.refundComponents ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  });
}

/** Pure validation/derivation shared by native and memory atomic storage. */
export function prepareRefundIntake(
  input: RefundIntakeInput,
  order: Order | null,
  tickets: Entitlement[],
  existing: AdminRefundRequest | null,
  event?: Event | null,
): { request: AdminRefundRequest; order: Order; entitlements: Entitlement[]; replay: boolean } {
  const request = input.request;
  if (!order || order.id !== request.orderId || order.organizationId !== request.organizationId) {
    throw new ConflictError('Refund intake does not match its order');
  }
  if (existing) {
    if (
      !request.intakeFingerprint ||
      !existing.intakeFingerprint ||
      intent(existing) !== intent(request)
    ) {
      throw new ConflictError('Refund intake id was already used for different intent');
    }
    return { request: existing, order, entitlements: [], replay: true };
  }
  if (
    (request.purchasePolicyVersion && input.expectedEventVersion === undefined) ||
    (input.expectedEventVersion !== undefined &&
      (!event || event.id !== order.eventId || event.version !== input.expectedEventVersion))
  ) {
    throw new ConflictError('Refund event changed; re-evaluate the authoritative refund cause');
  }
  if (
    !request.intakeFingerprint ||
    request.version !== 1 ||
    request.approvals.length !== 0 ||
    !['pending', 'approved'].includes(request.status) ||
    order.status !== 'paid' ||
    order.version !== input.expectedOrderVersion
  ) {
    throw new ConflictError('Refund order changed; re-evaluate intake and approval requirements');
  }
  if (
    !Number.isSafeInteger(request.amountPaise) ||
    request.amountPaise <= 0 ||
    request.amountPaise > refundableBalance(order)
  ) {
    throw new InvalidOperationError('Refund amount exceeds the remaining paid balance');
  }
  if (
    request.refundCause === 'fulfillment_failure' &&
    (!order.compensationRequired ||
      order.fulfillmentState !== 'pending' ||
      tickets.length !== 0 ||
      order.refundedPaise !== 0 ||
      request.amountPaise !== order.grandTotalPaise ||
      request.scope !== 'amount_only' ||
      request.targetEntitlementIds.length !== 0)
  )
    throw new ConflictError(
      'Capture compensation requires the full unfulfilled purchase without issued admissions',
    );
  const expected = new Map(
    input.expectedEntitlementVersions.map((ticket) => [ticket.id, ticket.version]),
  );
  if (
    expected.size !== input.expectedEntitlementVersions.length ||
    expected.size !== tickets.length ||
    tickets.some(
      (ticket) =>
        ticket.orderId !== order.id ||
        ticket.eventId !== order.eventId ||
        ticket.organizationId !== order.organizationId ||
        expected.get(ticket.id) !== ticket.version,
    )
  ) {
    throw new ConflictError(
      'Refund ticket state changed; re-evaluate intake and approval requirements',
    );
  }
  if (
    tickets.some(
      (ticket) =>
        ticket.status === 'redeemed' ||
        ticket.scanCount > 0 ||
        ticket.ticketAddons?.some((addon) => addon.status === 'redeemed'),
    ) &&
    request.approversRequired < 1
  ) {
    throw new ConflictError('Used admission requires a fresh refund approval evaluation');
  }
  const targets = new Set(request.targetEntitlementIds);
  if (
    targets.size !== request.targetEntitlementIds.length ||
    (request.scope === 'amount_only' && (targets.size !== 0 || request.ticketLines.length !== 0)) ||
    (request.scope === 'ticket_lines' && (targets.size === 0 || request.ticketLines.length === 0))
  ) {
    throw new InvalidOperationError('Invalid exact refund ticket selection');
  }
  const selected = tickets.filter((ticket) => targets.has(ticket.id));
  if (
    selected.length !== targets.size ||
    selected.some(
      (ticket) =>
        ticket.status === 'void' || ticket.refundLock != null || Boolean(ticket.pendingTransferId),
    )
  ) {
    throw new ConflictError(
      'Selected refund tickets are missing, void, transferring or already locked',
    );
  }
  if (request.scope === 'ticket_lines') {
    const quantities = new Map<string, number>();
    for (const ticket of selected)
      quantities.set(ticket.tierId, (quantities.get(ticket.tierId) ?? 0) + 1);
    for (const line of request.ticketLines) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)
        throw new InvalidOperationError('Invalid refund ticket quantity');
      quantities.set(line.tierId, (quantities.get(line.tierId) ?? 0) - line.quantity);
    }
    if ([...quantities.values()].some((quantity) => quantity !== 0))
      throw new ConflictError('Refund ticket quantities do not match exact selection');
  }
  return {
    request,
    order: lockOrderForRefund(order, input.now),
    entitlements: selected.map((ticket) =>
      freezeEntitlementForRefund(ticket, request.id, input.now),
    ),
    replay: false,
  };
}
