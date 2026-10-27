import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { domainEvent } from '../../domain/events.js';
import { PermanentEmailDeliveryError } from '../../domain/ports/email-sender.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { noopLogger } from '../../telemetry/logger.js';

import { createTransactionalEmailConsumer } from './transactional-email-consumer.js';

import type { ServiceDeps } from '../context.js';

describe('transactional email consumer', () => {
  it('persists and sends one escaped receipt despite duplicate outbox delivery', async () => {
    const sent: { to: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const order = {
      id: 'order_1',
      eventId: 'event_1',
      organizationId: 'org_1',
      userId: 'guest_1',
      contact: { name: 'Guest', email: 'guest@real.test', phone: 'never-render' },
      status: 'paid',
      lines: [
        {
          tierId: 'tier_1',
          tierName: '<VIP>',
          quantity: 1,
          unitPricePaise: 10_000,
          subtotalPaise: 10_000,
        },
      ],
      currency: 'INR',
      subtotalPaise: 10_000,
      discountPaise: 0,
      discountFundingOwner: null,
      discountedSubtotalPaise: 10_000,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      grandTotalPaise: 10_000,
      appliedPromoCode: null,
      attribution: null,
      paymentIntentId: 'provider-order',
      paymentId: 'provider-payment',
      paidAt: new Date().toISOString(),
      reservationExpiresAt: new Date().toISOString(),
      failureReason: null,
      refundedPaise: 0,
      appliedRefundRequestIds: [],
      bookingReference: 'C1-REF',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      logger: noopLogger,
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'resend-message-1' };
        },
      },
      repositories: {
        orders: { getById: async () => order },
        events: {
          getById: async () => ({
            title: '<Launch>',
            startAt: '2026-11-01T18:00:00.000Z',
            venueId: null,
          }),
        },
        venues: { getById: async () => null },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const event = domainEvent({
      id: 'order-fulfilled-event',
      type: 'order.fulfilled',
      aggregateId: order.id,
      organizationId: order.organizationId,
      actorId: order.userId,
      payload: { orderId: order.id, eventId: order.eventId },
      occurredAt: Date.now(),
    });

    await handler(event);
    await handler(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.idempotencyKey).toBe('booking-receipt:order_1:fulfilled');
    expect(sent[0]?.html).toContain('&lt;VIP&gt;');
    expect(sent[0]?.html).toContain('&lt;Launch&gt;');
    expect(sent[0]?.html).not.toContain('never-render');
    const deliveries = [...emailDeliveries.records.values()];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      status: 'sent',
      retryCount: 1,
      providerMessageId: 'resend-message-1',
    });
    expect(deliveries[0]?.recipientHash).not.toContain('guest@real.test');
  });

  it('does not send to placeholder guest addresses', async () => {
    let attempts = 0;
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async () => {
          attempts += 1;
          return { providerMessageId: 'x' };
        },
      },
      repositories: {
        orders: {
          getById: async () => ({
            id: 'order',
            status: 'paid',
            grandTotalPaise: 100,
            contact: { email: 'guest@example.com' },
          }),
        },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    await handler(
      domainEvent({
        id: 'event',
        type: 'order.fulfilled',
        aggregateId: 'order',
        organizationId: 'org',
        actorId: 'user',
        payload: { orderId: 'order', eventId: 'event_1' },
        occurredAt: Date.now(),
      }),
    );
    expect(attempts).toBe(0);
  });

  it('retries a failed send with the same logical idempotency key and records attempts', async () => {
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const keys: string[] = [];
    let first = true;
    const order = {
      id: 'order_2',
      eventId: 'event_2',
      status: 'paid',
      grandTotalPaise: 100,
      contact: { name: 'Guest', email: 'guest@real.test', phone: '' },
      lines: [],
      bookingReference: 'C1-2',
      subtotalPaise: 100,
      discountPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      gstPaise: 0,
      refundedPaise: 0,
      paymentId: null,
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => new Date('2026-10-20T00:00:00Z') },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: { idempotencyKey: string }) => {
          keys.push(message.idempotencyKey);
          if (first) {
            first = false;
            throw new Error('sensitive provider detail');
          }
          return { providerMessageId: 'accepted-2' };
        },
      },
      repositories: {
        orders: { getById: async () => order },
        events: { getById: async () => null },
        venues: { getById: async () => null },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const event = domainEvent({
      id: 'order-2-event',
      type: 'order.fulfilled',
      aggregateId: order.id,
      organizationId: 'org',
      actorId: 'guest',
      payload: { orderId: order.id, eventId: order.eventId },
      occurredAt: Date.now(),
    });

    await expect(handler(event)).rejects.toThrow('Transactional email delivery failed');
    expect([...emailDeliveries.records.values()][0]).toMatchObject({
      status: 'failed',
      retryCount: 1,
      lastError: 'Transactional email provider failure',
      providerMessageId: null,
    });
    await handler(event);

    expect(keys).toEqual([
      'booking-receipt:order_2:fulfilled',
      'booking-receipt:order_2:fulfilled',
    ]);
    expect([...emailDeliveries.records.values()][0]).toMatchObject({
      status: 'sent',
      retryCount: 2,
      providerMessageId: 'accepted-2',
    });
  });

  it('sends payout status to the organization owner without including bank details', async () => {
    let message: { to: string; html: string; idempotencyKey: string } | undefined;
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (value: typeof message & {}) => {
          message = value;
          return { providerMessageId: 'payout-message' };
        },
      },
      userDirectory: { getEmailById: async () => 'owner@partner.test' },
      repositories: { organizations: { getById: async () => ({ ownerId: 'owner_1' }) } },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    await handler(
      domainEvent({
        id: 'payout-status-1',
        type: 'finance.payout.status_changed',
        aggregateId: 'payout_1',
        organizationId: 'org_1',
        actorId: 'owner_1',
        payload: {
          payoutId: 'payout_1',
          organizationId: 'org_1',
          status: 'requested',
          version: 1,
          amountPaise: 250_000,
        },
        occurredAt: Date.now(),
      }),
    );
    expect(message?.to).toBe('owner@partner.test');
    expect(message?.idempotencyKey).toBe('payout:payout_1:1');
    expect(message?.html).toContain('₹2,500');
    expect(message?.html).not.toMatch(/account|ifsc|bank number/i);
  });

  it('renders refund amount and remaining valid tickets from settled backend state', async () => {
    let html = '';
    const order = {
      id: 'order_r',
      eventId: 'event_r',
      status: 'paid',
      contact: { email: 'guest@real.test' },
      bookingReference: 'C1-R',
    };
    const refund = {
      id: 'refund_r',
      orderId: 'order_r',
      status: 'settled',
      amountPaise: 50_000,
      targetEntitlementIds: ['ticket_1'],
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: { html: string }) => {
          html = message.html;
          return { providerMessageId: 'refund-message' };
        },
      },
      repositories: {
        orders: { getById: async () => order },
        refundRequests: { getById: async () => refund },
        entitlements: {
          getByOrderId: async () => [{ status: 'void' }, { status: 'valid', refundLock: null }],
        },
        events: { getById: async () => null },
        venues: { getById: async () => null },
      },
    } as unknown as ServiceDeps;
    await createTransactionalEmailConsumer(deps)(
      domainEvent({
        id: 'refund-settled-event',
        type: 'finance.refund.settled',
        aggregateId: refund.id,
        organizationId: 'org',
        actorId: 'admin',
        payload: {
          refundRequestId: refund.id,
          orderId: order.id,
          amountPaise: refund.amountPaise,
          providerRefundId: 'provider-refund',
        },
        occurredAt: Date.now(),
      }),
    );
    expect(html).toContain('₹500');
    expect(html).toContain('Affected tickets: 1');
    expect(html).toContain('Remaining valid tickets: 1');
    expect(html).not.toContain('provider-refund');
  });

  it('renders cancellation updates with stable per-event-version delivery identity', async () => {
    let key = '';
    let html = '';
    const order = {
      id: 'order_c',
      eventId: 'event_c',
      status: 'refund_requested',
      contact: { email: 'guest@real.test' },
      bookingReference: 'C1-C',
      eventCancellation: { eventTitle: 'Old title' },
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: { html: string; idempotencyKey: string }) => {
          html = message.html;
          key = message.idempotencyKey;
          return { providerMessageId: 'cancel-message' };
        },
      },
      repositories: {
        orders: { getById: async () => order },
        events: {
          getById: async () => ({
            id: 'event_c',
            title: '<Cancelled>',
            version: 7,
            status: 'cancelled',
            startAt: '2026-11-01T18:00:00.000Z',
            venueId: null,
          }),
        },
        venues: { getById: async () => null },
      },
    } as unknown as ServiceDeps;
    await createTransactionalEmailConsumer(deps)(
      domainEvent({
        id: 'order-affected',
        type: 'event.cancellation.order_affected',
        aggregateId: order.id,
        organizationId: 'org',
        actorId: 'partner',
        payload: {
          eventId: 'event_c',
          orderId: order.id,
          refundRequestId: 'refund_c',
          reason: '<Weather>',
        },
        occurredAt: Date.now(),
      }),
    );
    expect(key).toBe('event-change:event_c:7:order_c');
    expect(html).toContain('&lt;Cancelled&gt;');
    expect(html).toContain('&lt;Weather&gt;');
    expect(html).toContain('existing review process');
  });

  it('emails payment support-required cases and emits material-change work in bounded pages', async () => {
    const outbox = new MemoryOutboxStore();
    let sentKey = '';
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      outbox,
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: { idempotencyKey: string }) => {
          sentKey = message.idempotencyKey;
          return { providerMessageId: 'support-message' };
        },
      },
      repositories: {
        cartReservations: {
          getById: async () => ({ attendee: { name: 'Guest', email: 'guest@real.test' } }),
        },
        orders: {
          listByEvent: async () => ({
            items: [
              { id: 'paid_1', status: 'paid', organizationId: 'org_1' },
              { id: 'pending_1', status: 'pending', organizationId: 'org_1' },
            ],
            total: 2,
            nextCursor: null,
          }),
        },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    await handler(
      domainEvent({
        id: 'payment-support-1',
        type: 'payment.support_required',
        aggregateId: 'pay_1',
        organizationId: 'org_1',
        actorId: 'system:internal',
        payload: { paymentId: 'pay_1', holdId: 'hold_1', organizationId: 'org_1', stateVersion: 3 },
        occurredAt: Date.now(),
      }),
    );
    expect(sentKey).toBe('payment-support:pay_1:3');

    await handler(
      domainEvent({
        id: 'event-update',
        type: 'event.updated',
        aggregateId: 'event_1',
        organizationId: 'org_1',
        actorId: 'partner_1',
        payload: {
          materialChange: {
            eventVersion: 8,
            previousTitle: 'Before',
            title: 'After',
            previousStartAt: '2026-11-01T18:00:00.000Z',
            startAt: '2026-11-02T18:00:00.000Z',
          },
        },
        occurredAt: Date.now(),
      }),
    );
    const affected = outbox
      .all()
      .filter((row) => row.type === 'event.material_change.order_affected');
    expect(affected).toHaveLength(1);
    expect(affected[0]?.aggregateId).toBe('paid_1');
  });

  it('records permanent provider rejection without retrying a message known to be invalid', async () => {
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    let attempts = 0;
    const order = {
      id: 'order_bad',
      status: 'paid',
      grandTotalPaise: 100,
      contact: { email: 'guest@real.test' },
      lines: [],
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async () => {
          attempts += 1;
          throw new PermanentEmailDeliveryError();
        },
      },
      repositories: {
        orders: { getById: async () => order },
        events: { getById: async () => null },
        venues: { getById: async () => null },
      },
    } as unknown as ServiceDeps;
    await createTransactionalEmailConsumer(deps)(
      domainEvent({
        id: 'permanent-rejection',
        type: 'order.fulfilled',
        aggregateId: order.id,
        organizationId: 'org',
        actorId: 'guest',
        payload: { orderId: order.id, eventId: 'event' },
        occurredAt: Date.now(),
      }),
    );
    expect(attempts).toBe(1);
    expect([...emailDeliveries.records.values()][0]).toMatchObject({
      status: 'failed',
      retryCount: 1,
      providerMessageId: null,
    });
  });
});
