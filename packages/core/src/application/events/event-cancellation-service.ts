import { createHash } from 'node:crypto';

import { ConflictError } from '../../domain/errors.js';
import {
  deterministicDomainEventId,
  domainEvent,
  type DomainEvent,
  type DomainEventType,
  type EventPayloads,
} from '../../domain/events.js';
import { freezeEntitlementForRefund, voidEntitlement } from '../../domain/models/entitlement.js';
import { markOrderEventCancelled, refundableBalance } from '../../domain/models/order.js';
import { quoteOriginalRefund } from '../../domain/models/purchase-refund-snapshot.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import type { EntityId } from '../../domain/identity.js';
import type { Order } from '../../domain/models/order.js';
import type { ServiceDeps } from '../context.js';

const CANCELLATION_BATCH_SIZE = 50;

const ACTIVE_REFUND_STATUSES = new Set(['pending', 'approved', 'executing', 'failed']);

/** Deterministic request identity: retries and batch restarts converge here. */
export function eventCancellationRefundRequestId(eventId: EntityId, orderId: EntityId): EntityId {
  return `REF-${deterministicDomainEventId('event-cancellation-refund', eventId, orderId).slice(4)}`;
}

/**
 * Propagates an event cancellation through orders, admission rights and the
 * existing admin-approved refund workflow. One outbox delivery processes one
 * bounded page; a deterministic continuation row makes the scan resumable.
 */
export class EventCancellationService {
  constructor(private readonly deps: ServiceDeps) {}

  readonly handle = async (event: DomainEvent): Promise<void> => {
    if (event.type === 'event.cancelled') {
      const payload = event.payload as EventPayloads['event.cancelled'];
      await this.processBatch({
        eventId: event.aggregateId,
        reason: payload.reason,
        eventVersion: payload.eventVersion,
        cursor: null,
        actorId: event.actorId,
        organizationId: event.organizationId,
      });
      return;
    }
    if (event.type === 'event.cancellation.batch_requested') {
      const payload = event.payload as EventPayloads['event.cancellation.batch_requested'];
      await this.processBatch({
        ...payload,
        actorId: event.actorId,
        organizationId: event.organizationId,
      });
      return;
    }
    if (event.type === 'order.fulfilled') {
      const { orderId, eventId } = event.payload as EventPayloads['order.fulfilled'];
      const [order, cancelledEvent] = await Promise.all([
        this.deps.repositories.orders.getById(orderId),
        this.deps.repositories.events.getById(eventId),
      ]);
      if (!order || cancelledEvent?.status !== 'cancelled') return;
      await this.processOrder(
        order,
        cancelledEvent.cancellationReason ?? 'Event cancelled',
        cancelledEvent.version,
        cancelledEvent.title,
        event.actorId,
      );
      return;
    }
    if (event.type === 'finance.refund.finalized' || event.type === 'finance.refund.settled') {
      const { orderId } = event.payload as EventPayloads['finance.refund.finalized'];
      const order = await this.deps.repositories.orders.getById(orderId);
      if (!order) return;
      const cancelledEvent = await this.deps.repositories.events.getById(order.eventId);
      if (cancelledEvent?.status !== 'cancelled') return;
      await this.processOrder(
        order,
        cancelledEvent.cancellationReason ?? 'Event cancelled',
        cancelledEvent.version,
        cancelledEvent.title,
        event.actorId,
      );
    }
  };

  private async processBatch(input: {
    eventId: EntityId;
    reason: string;
    eventVersion: number;
    cursor: string | null;
    actorId: EntityId;
    organizationId: EntityId;
  }): Promise<void> {
    const event = await this.deps.repositories.events.getById(input.eventId);
    if (!event || event.status !== 'cancelled' || event.version !== input.eventVersion) return;
    const activeHolds = await this.deps.repositories.cartReservations.listActiveByEvent(
      input.eventId,
      this.deps.config.clock.now(),
    );
    for (const hold of activeHolds) {
      await this.deps.repositories.cartReservations.release(hold.id);
    }
    const page = await this.deps.repositories.orders.listByEvent(input.eventId, {
      cursor: input.cursor,
      limit: CANCELLATION_BATCH_SIZE,
    });
    for (const order of page.items) {
      await this.processOrder(order, input.reason, input.eventVersion, event.title, input.actorId);
    }
    if (page.nextCursor !== null) {
      await this.appendDeterministic(
        'event.cancellation.batch_requested',
        input.eventId,
        input.organizationId,
        input.actorId,
        {
          eventId: input.eventId,
          reason: input.reason,
          eventVersion: input.eventVersion,
          cursor: page.nextCursor,
        },
        input.eventId,
        String(input.eventVersion),
        page.nextCursor,
      );
    }
  }

  private async processOrder(
    initialOrder: Order,
    reason: string,
    eventVersion: number,
    eventTitle: string,
    actorId: EntityId,
  ): Promise<void> {
    const now = this.deps.config.clock.now();
    const refundId = eventCancellationRefundRequestId(initialOrder.eventId, initialOrder.id);
    const [existingCancellationRefund, orderRefunds, entitlements] = await Promise.all([
      this.deps.repositories.refundRequests.getById(refundId),
      this.deps.repositories.refundRequests.listByOrder(initialOrder.id),
      this.deps.repositories.entitlements.getByOrderId(initialOrder.id),
    ]);
    const otherActiveRefund = orderRefunds.some(
      (request) => request.id !== refundId && ACTIVE_REFUND_STATUSES.has(request.status),
    );
    const remainingPaise = refundableBalance(initialOrder);
    const canCreateRefund =
      (initialOrder.status === 'paid' ||
        (initialOrder.status === 'refund_requested' &&
          initialOrder.eventCancellation?.eventVersion === eventVersion)) &&
      initialOrder.paymentId !== null &&
      remainingPaise > 0 &&
      !initialOrder.compensationRequired &&
      !otherActiveRefund &&
      existingCancellationRefund === null;
    if (canCreateRefund && initialOrder.refundSnapshot) {
      const event = await this.deps.repositories.events.getById(initialOrder.eventId);
      if (!event || event.status !== 'cancelled' || event.version !== eventVersion)
        throw new ConflictError('Cancellation changed before original-purchase refund intake');
      const targets = entitlements
        .filter((ticket) => ticket.status !== 'void')
        .sort((left, right) => left.id.localeCompare(right.id));
      const quoted = quoteOriginalRefund(
        initialOrder,
        initialOrder.refundSnapshot.tickets.map((ticket) => ticket.entitlementId),
        'organizer_cancel',
      );
      // Retained fees on void admissions remain owed; inventory targets stay active-only.
      const settled = orderRefunds.filter((request) => request.status === 'settled');
      if (
        settled.some((request) => !request.refundComponents) ||
        settled.reduce((sum, request) => sum + request.amountPaise, 0) !==
          initialOrder.refundedPaise
      )
        throw new ConflictError('Cancellation requires reconciled original refund components');
      for (const request of settled) {
        for (const key of Object.keys(quoted.components) as (keyof typeof quoted.components)[])
          quoted.components[key] -= request.refundComponents?.[key] ?? 0;
      }
      const componentValues = [
        quoted.components.admissionPaise,
        quoted.components.platformFeePaise,
        quoted.components.paymentFeePaise,
        quoted.components.feeTaxPaise,
        quoted.components.otherPaidPaise,
      ];
      quoted.amountPaise = componentValues.reduce((sum, amount) => sum + amount, 0);
      if (
        componentValues.some((amount) => !Number.isSafeInteger(amount) || amount < 0) ||
        quoted.amountPaise !== remainingPaise
      )
        throw new ConflictError('Cancellation original refund components do not reconcile');
      const quantities = new Map<EntityId, number>();
      for (const ticket of targets)
        quantities.set(ticket.tierId, (quantities.get(ticket.tierId) ?? 0) + 1);
      const settings = await this.deps.repositories.platformSettings.get();
      const request = createRefundRequest({
        id: refundId,
        orderId: initialOrder.id,
        organizationId: initialOrder.organizationId,
        requestedBy: actorId,
        reason: `Event cancelled: ${reason}`,
        intakeFingerprint: createHash('sha256')
          .update(
            JSON.stringify({
              orderId: initialOrder.id,
              eventVersion,
              reason,
              cause: quoted.cause,
              targets: targets.map((ticket) => ticket.id),
              components: quoted.components,
            }),
          )
          .digest('hex'),
        amountPaise: quoted.amountPaise,
        refundCause: quoted.cause,
        refundComponents: quoted.components,
        purchasePolicyVersion: quoted.purchasePolicyVersion,
        sourceEventVersion: eventVersion,
        scope: targets.length ? 'ticket_lines' : 'amount_only',
        targetEntitlementIds: targets.map((ticket) => ticket.id),
        ticketLines: [...quantities].map(([tierId, quantity]) => ({ tierId, quantity })),
        hasRedeemedEntitlement: entitlements.some(
          (ticket) =>
            ticket.status === 'redeemed' ||
            ticket.scanCount > 0 ||
            ticket.ticketAddons?.some((addon) => addon.status === 'redeemed'),
        ),
        thresholds: {
          singleApproverCeilingPaise: settings.refundSingleApproverThresholdPaise,
          dualApproverCeilingPaise: settings.refundDualApproverThresholdPaise,
        },
        now,
      });
      const intake = await this.deps.repositories.orders.beginRefundRequest({
        request,
        expectedOrderVersion: initialOrder.version,
        expectedEventVersion: eventVersion,
        expectedEntitlementVersions: entitlements.map(({ id, version }) => ({ id, version })),
        now,
      });
      // Retry-safe metadata/audit delivery follows the canonical atomic intake.
      await this.processOrder(intake.order, reason, eventVersion, eventTitle, actorId);
      return;
    }
    const shouldRemainLocked =
      canCreateRefund ||
      (existingCancellationRefund !== null &&
        ['pending', 'approved', 'executing'].includes(existingCancellationRefund.status));

    const order = markOrderEventCancelled(
      initialOrder,
      { eventVersion, eventTitle, reason, lockForRefund: shouldRemainLocked },
      now,
    );
    if (order !== initialOrder) await this.deps.repositories.orders.save(order);

    if (initialOrder.status === 'pending' || initialOrder.status === 'awaiting_payment') {
      if (initialOrder.paymentIntentId) {
        const hold = await this.deps.repositories.cartReservations.getByProviderOrderId(
          initialOrder.paymentIntentId,
        );
        if (hold?.status === 'active')
          await this.deps.repositories.cartReservations.release(hold.id);
      }
    } else if (initialOrder.grandTotalPaise === 0 || initialOrder.status === 'refunded') {
      for (const entitlement of entitlements) {
        const voided = voidEntitlement(entitlement, now);
        if (voided !== entitlement) await this.deps.repositories.entitlements.save(voided);
      }
    } else if (canCreateRefund) {
      const targets = entitlements
        .filter((entitlement) => entitlement.status !== 'void')
        .sort((left, right) => left.id.localeCompare(right.id));
      const quantities = new Map<EntityId, number>();
      for (const entitlement of targets) {
        quantities.set(entitlement.tierId, (quantities.get(entitlement.tierId) ?? 0) + 1);
      }
      const settings = await this.deps.repositories.platformSettings.get();
      const request = createRefundRequest({
        id: refundId,
        orderId: order.id,
        organizationId: order.organizationId,
        amountPaise: remainingPaise,
        requestedBy: actorId,
        reason: `Event cancelled: ${reason}`,
        scope: targets.length > 0 ? 'ticket_lines' : 'amount_only',
        ticketLines: [...quantities.entries()].map(([tierId, quantity]) => ({ tierId, quantity })),
        targetEntitlementIds: targets.map((entitlement) => entitlement.id),
        hasRedeemedEntitlement: targets.some((entitlement) => entitlement.status === 'redeemed'),
        thresholds: {
          singleApproverCeilingPaise: settings.refundSingleApproverThresholdPaise,
          dualApproverCeilingPaise: settings.refundDualApproverThresholdPaise,
        },
        now,
      });
      await this.deps.repositories.refundRequests.save(request);
      for (const entitlement of targets) {
        const frozen = freezeEntitlementForRefund(entitlement, request.id, now);
        if (frozen !== entitlement) await this.deps.repositories.entitlements.save(frozen);
      }
    } else if (
      existingCancellationRefund &&
      ['pending', 'approved', 'executing'].includes(existingCancellationRefund.status)
    ) {
      for (const entitlementId of existingCancellationRefund.targetEntitlementIds) {
        const entitlement = await this.deps.repositories.entitlements.getById(entitlementId);
        if (!entitlement || entitlement.status === 'void') continue;
        const frozen = freezeEntitlementForRefund(entitlement, existingCancellationRefund.id, now);
        if (frozen !== entitlement) await this.deps.repositories.entitlements.save(frozen);
      }
    } else if (
      existingCancellationRefund &&
      ['rejected', 'failed'].includes(existingCancellationRefund.status)
    ) {
      // A definitive no-refund result releases the refund lock in RefundService.
      // The event itself is still cancelled, so those now-unlocked tickets
      // must not silently become usable again. Leave any separately locked
      // tickets untouched until their own provider outcome is resolved.
      for (const entitlement of entitlements) {
        if (entitlement.status === 'void' || entitlement.refundLock) continue;
        const voided = voidEntitlement(entitlement, now);
        if (voided !== entitlement) await this.deps.repositories.entitlements.save(voided);
      }
    }

    await this.appendDeterministic(
      'event.cancellation.order_affected',
      order.id,
      order.organizationId,
      actorId,
      {
        eventId: order.eventId,
        orderId: order.id,
        refundRequestId: existingCancellationRefund?.id ?? (canCreateRefund ? refundId : null),
        reason,
      },
      order.eventId,
      order.id,
      String(eventVersion),
    );
    const surviving = (await this.deps.repositories.entitlements.getByOrderId(order.id)).filter(
      (entitlement) => entitlement.status !== 'void',
    );
    const recipients = new Map<string, EntityId | null>();
    for (const entitlement of surviving) {
      const holderId = entitlement.currentHolderUserId ?? entitlement.userId;
      const key = holderId ?? `unassigned:${order.id}`;
      if (!recipients.has(key)) recipients.set(key, entitlement.id);
    }
    if (recipients.size === 0) recipients.set(`order:${order.id}`, null);
    for (const entitlementId of recipients.values()) {
      await this.appendDeterministic(
        'event.cancellation.email_requested',
        order.id,
        order.organizationId,
        actorId,
        { eventId: order.eventId, orderId: order.id, entitlementId, eventVersion, reason },
        order.eventId,
        order.id,
        String(eventVersion),
        entitlementId ?? 'order-contact',
      );
    }
    await this.deps.adminAudit.write({
      id: deterministicDomainEventId(
        'audit.event.cancellation.order_affected',
        order.eventId,
        order.id,
        String(eventVersion),
      ),
      adminId: actorId,
      actorId,
      organizationId: order.organizationId,
      action: 'event.cancellation.order_affected',
      targetType: 'order',
      targetId: order.id,
      before: {
        orderStatus: initialOrder.status,
        eventCancellation: initialOrder.eventCancellation ?? null,
      },
      after: {
        orderStatus: order.status,
        eventVersion,
        refundRequestId: existingCancellationRefund?.id ?? (canCreateRefund ? refundId : null),
      },
      reason,
      occurredAt: now.getTime(),
    });
  }

  private async appendDeterministic<TType extends DomainEventType>(
    type: TType,
    aggregateId: EntityId,
    organizationId: EntityId,
    actorId: EntityId,
    payload: EventPayloads[TType],
    ...identityParts: string[]
  ): Promise<void> {
    const occurredAt = this.deps.config.clock.now().getTime();
    await this.deps.outbox.append(
      domainEvent({
        id: deterministicDomainEventId(type, ...identityParts),
        type,
        aggregateId,
        organizationId,
        actorId,
        payload,
        occurredAt,
      }),
    );
  }
}
