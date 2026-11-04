import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { domainEvent } from '../../domain/events.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { cancelEvent, createEvent, transitionEvent } from '../../domain/models/event.js';
import { createRefundRequest, rejectRefundRequest } from '../../domain/models/refund-request.js';
import { MemoryAdminAuditRepository } from '../../infrastructure/memory/memory-audit-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryRefundRequestRepository } from '../../infrastructure/memory/memory-refund-request-repository.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
  MemoryPlatformSettingsRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { noopLogger } from '../../telemetry/logger.js';

import {
  EventCancellationService,
  eventCancellationRefundRequestId,
} from './event-cancellation-service.js';

import type { Order } from '../../domain/models/order.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');

function paidOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    userId: 'guest_1',
    contact: { name: 'Guest', email: 'guest@example.test', phone: '' },
    status: 'paid',
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'General',
        quantity: 2,
        unitPricePaise: 50_000,
        subtotalPaise: 100_000,
      },
    ],
    currency: 'INR',
    subtotalPaise: 100_000,
    discountPaise: 0,
    discountFundingOwner: null,
    discountedSubtotalPaise: 100_000,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: 100_000,
    appliedPromoCode: null,
    attribution: null,
    paymentIntentId: 'provider_order_1',
    paymentId: 'provider_payment_1',
    paidAt: NOW.toISOString(),
    reservationExpiresAt: NOW.toISOString(),
    failureReason: null,
    eventCancellation: null,
    refundedPaise: 0,
    appliedRefundRequestIds: [],
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function setup() {
  const events = new MemoryEventRepository();
  const orders = new MemoryOrderRepository();
  const entitlements = new MemoryEntitlementRepository();
  const refundRequests = new MemoryRefundRequestRepository();
  const outbox = new MemoryOutboxStore();
  const adminAudit = new MemoryAdminAuditRepository();
  const repositories = {
    events,
    orders,
    entitlements,
    refundRequests,
    cartReservations: new MemoryCartReservationRepository(),
    platformSettings: new MemoryPlatformSettingsRepository(),
  } as unknown as ServiceDeps['repositories'];
  const deps = {
    config: createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
    }),
    repositories,
    outbox,
    adminAudit,
    logger: noopLogger,
  } as unknown as ServiceDeps;
  let event = createEvent({
    id: 'event_1',
    organizationId: 'org_1',
    venueId: 'venue_1',
    title: 'Night',
    startAt: '2026-11-01T18:00:00.000Z',
    now: NOW,
  });
  for (const status of ['review', 'scheduled', 'published'] as const) {
    event = transitionEvent(event, status, NOW);
  }
  event = cancelEvent(event, 'Venue closed', NOW);
  events.events.set(event.id, event);
  const service = new EventCancellationService(deps);
  const cancellation = domainEvent({
    id: 'evt_cancel_1',
    type: 'event.cancelled',
    aggregateId: event.id,
    organizationId: event.organizationId,
    actorId: 'partner_1',
    payload: {
      title: event.title,
      reason: event.cancellationReason ?? '',
      eventVersion: event.version,
    },
    occurredAt: NOW.getTime(),
  });
  return {
    service,
    cancellation,
    event,
    orders,
    entitlements,
    refundRequests,
    outbox,
    adminAudit,
  };
}

describe('EventCancellationService', () => {
  it('creates one deterministic approval-gated refund and freezes exactly the paid tickets', async () => {
    const context = setup();
    const order = paidOrder();
    context.orders.orders.set(order.id, order);
    for (const entitlement of issueEntitlements({ order, now: NOW })) {
      context.entitlements.entitlements.set(entitlement.id, entitlement);
    }

    await context.service.handle(context.cancellation);
    await context.service.handle(context.cancellation);

    const storedOrder = await context.orders.getById(order.id);
    expect(storedOrder).toMatchObject({
      status: 'refund_requested',
      eventCancellation: {
        eventTitle: 'Night',
        reason: 'Venue closed',
        eventVersion: context.event.version,
      },
    });
    const requests = [...context.refundRequests.requests.values()];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: eventCancellationRefundRequestId(order.eventId, order.id),
      amountPaise: 100_000,
      status: 'pending',
      scope: 'ticket_lines',
      requestedBy: 'partner_1',
    });
    expect(requests[0]?.targetEntitlementIds).toHaveLength(2);
    expect([...context.entitlements.entitlements.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'valid',
          refundLock: { refundRequestId: requests[0]?.id, frozenAt: NOW.toISOString() },
        }),
      ]),
    );
    expect(
      context.outbox.all().filter((row) => row.type === 'event.cancellation.order_affected'),
    ).toHaveLength(1);
    expect(await context.adminAudit.listForTarget(order.id, 10)).toEqual([
      expect.objectContaining({ action: 'event.cancellation.order_affected', targetId: order.id }),
    ]);
  });

  it('voids free RSVP admission without inventing a money refund', async () => {
    const context = setup();
    const order = paidOrder({
      id: 'rsvp_1',
      paymentId: 'rsvp_1',
      lines: [
        {
          tierId: 'tier_free',
          tierName: 'RSVP',
          quantity: 1,
          unitPricePaise: 0,
          subtotalPaise: 0,
        },
      ],
      subtotalPaise: 0,
      discountedSubtotalPaise: 0,
      grandTotalPaise: 0,
    });
    context.orders.orders.set(order.id, order);
    for (const entitlement of issueEntitlements({ order, now: NOW })) {
      context.entitlements.entitlements.set(entitlement.id, entitlement);
    }

    await context.service.handle(context.cancellation);

    expect(await context.orders.getById(order.id)).toMatchObject({
      status: 'paid',
      eventCancellation: { reason: 'Venue closed' },
    });
    expect([...context.refundRequests.requests.values()]).toHaveLength(0);
    expect([...context.entitlements.entitlements.values()]).toEqual([
      expect.objectContaining({ status: 'void', refundLock: null }),
    ]);
  });

  it('repairs an order lock left before its deterministic refund request was saved', async () => {
    const context = setup();
    const order = paidOrder({
      status: 'refund_requested',
      eventCancellation: {
        eventVersion: context.event.version,
        eventTitle: context.event.title,
        reason: 'Venue closed',
        cancelledAt: NOW.toISOString(),
      },
      version: 2,
    });
    context.orders.orders.set(order.id, order);
    for (const entitlement of issueEntitlements({
      order: { ...order, status: 'paid' },
      now: NOW,
    })) {
      context.entitlements.entitlements.set(entitlement.id, entitlement);
    }

    await context.service.handle(context.cancellation);

    expect([...context.refundRequests.requests.values()]).toEqual([
      expect.objectContaining({
        id: eventCancellationRefundRequestId(order.eventId, order.id),
        status: 'pending',
      }),
    ]);
    expect([...context.entitlements.entitlements.values()]).toEqual(
      expect.arrayContaining([expect.objectContaining({ refundLock: expect.any(Object) })]),
    );
  });

  it('does not reopen tickets after a cancellation refund is definitively rejected', async () => {
    const context = setup();
    const order = paidOrder({ status: 'paid' });
    context.orders.orders.set(order.id, order);
    const request = createRefundRequest({
      id: eventCancellationRefundRequestId(order.eventId, order.id),
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise: order.grandTotalPaise,
      requestedBy: 'partner_1',
      reason: 'Event cancelled: Venue closed',
      hasRedeemedEntitlement: false,
      now: NOW,
    });
    context.refundRequests.requests.set(
      request.id,
      rejectRefundRequest(request, 'admin_1', 'Provider refund not approved', NOW),
    );
    for (const entitlement of issueEntitlements({ order, now: NOW })) {
      context.entitlements.entitlements.set(entitlement.id, entitlement);
    }

    await context.service.handle(context.cancellation);

    expect([...context.entitlements.entitlements.values()]).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'void', refundLock: null })]),
    );
  });

  it('keeps separately refund-locked tickets frozen after cancellation refund failure', async () => {
    const context = setup();
    const order = paidOrder();
    context.orders.orders.set(order.id, order);
    const entitlements = issueEntitlements({ order, now: NOW });
    const unrelatedRefundId = 'REF-other';
    const firstEntitlement = entitlements[0];
    const secondEntitlement = entitlements[1];
    if (!firstEntitlement || !secondEntitlement) throw new Error('Expected two entitlements');
    context.refundRequests.requests.set(
      unrelatedRefundId,
      createRefundRequest({
        id: unrelatedRefundId,
        orderId: order.id,
        organizationId: order.organizationId,
        amountPaise: 10_000,
        requestedBy: 'guest_1',
        reason: 'Guest request',
        hasRedeemedEntitlement: false,
        scope: 'ticket_lines',
        ticketLines: [{ tierId: 'tier_1', quantity: 1 }],
        targetEntitlementIds: [firstEntitlement.id],
        now: NOW,
      }),
    );
    const { freezeEntitlementForRefund } = await import('../../domain/models/entitlement.js');
    for (const entitlement of entitlements) {
      const stored =
        entitlement.id === firstEntitlement.id
          ? freezeEntitlementForRefund(entitlement, unrelatedRefundId, NOW)
          : entitlement;
      context.entitlements.entitlements.set(stored.id, stored);
    }
    const cancellationRefund = createRefundRequest({
      id: eventCancellationRefundRequestId(order.eventId, order.id),
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise: order.grandTotalPaise,
      requestedBy: 'partner_1',
      reason: 'Event cancelled: Venue closed',
      hasRedeemedEntitlement: false,
      now: NOW,
    });
    context.refundRequests.requests.set(
      cancellationRefund.id,
      rejectRefundRequest(cancellationRefund, 'admin_1', 'Provider refund failed', NOW),
    );

    await context.service.handle(context.cancellation);

    expect(await context.entitlements.getById(firstEntitlement.id)).toMatchObject({
      status: 'valid',
      refundLock: { refundRequestId: unrelatedRefundId },
    });
    const other = await context.entitlements.getById(secondEntitlement.id);
    expect(other?.status).toBe('void');
  });
});
