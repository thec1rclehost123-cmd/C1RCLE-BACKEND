import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { domainEvent } from '../../domain/events.js';
import { PermanentEmailDeliveryError } from '../../domain/ports/email-sender.js';
import { MemoryEmailDeliveryRepository } from '../../infrastructure/memory/memory-email-delivery-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { noopLogger } from '../../telemetry/logger.js';

import { createTransactionalEmailConsumer } from './transactional-email-consumer.js';

import type { ServiceDeps } from '../context.js';

describe('transactional email consumer', () => {
  it('delivers a pending invitation only to its persisted verified recipient account', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    const recipientEmail = 'recipient@real.test';
    const recipientEmailHash = createHash('sha256').update(recipientEmail).digest('hex');
    const transfer = {
      id: 'TRF-invite-notice',
      entitlementId: 'ENT-invite-notice',
      eventId: 'EVT-invite-notice',
      senderUserId: 'USR-sender',
      recipientUserId: 'USR-recipient',
      recipientEmailHash,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      acceptedAt: null,
      resolvedAt: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const deps = {
      config: { clock: { now: () => now } },
      emailDeliveries,
      emailSender: {
        name: 'resend',
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'transfer-invite-message' };
        },
      },
      repositories: {
        entitlements: {
          getTicketTransfer: async () => transfer,
          getById: async () => ({
            id: transfer.entitlementId,
            eventId: transfer.eventId,
            userId: transfer.senderUserId,
            currentHolderUserId: transfer.senderUserId,
            status: 'valid',
            pendingTransferId: transfer.id,
          }),
        },
        users: {
          getById: async () => ({
            id: transfer.recipientUserId,
            email: recipientEmail,
            emailVerified: true,
          }),
        },
        events: { getById: async () => ({ title: 'Invitation Event' }) },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'transfer-created-invite-notice',
      type: 'ticket.transfer.created',
      aggregateId: transfer.entitlementId,
      organizationId: 'ORG-invite-notice',
      actorId: transfer.senderUserId,
      payload: {
        transferId: transfer.id,
        entitlementId: transfer.entitlementId,
        eventId: transfer.eventId,
        recipientBinding: 'account',
        expiresAt: transfer.expiresAt,
      },
      occurredAt: now.getTime(),
    });
    const handler = createTransactionalEmailConsumer(deps);

    await handler(event);
    await handler(event);

    const resendEvent = domainEvent({
      id: 'transfer-created-invite-resend',
      type: 'ticket.transfer.invitation_resent',
      aggregateId: transfer.entitlementId,
      organizationId: 'ORG-invite-notice',
      actorId: transfer.senderUserId,
      payload: { transferId: transfer.id, deliveryRequestId: 'b'.repeat(64) },
      occurredAt: now.getTime(),
    });
    await handler(resendEvent);
    await handler(resendEvent);

    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe(recipientEmail);
    expect(sent[0]?.subject).toBe('A C1RCLE ticket is waiting for you');
    expect(sent[0]?.html).toContain('https://thec1rcle.com/ticket-transfer/TRF-invite-notice');
    expect(sent[0]?.html).not.toContain(recipientEmail);
    expect(sent[0]?.idempotencyKey).toBe('ticket-transfer-invitation:TRF-invite-notice');
    expect(sent[1]?.idempotencyKey).toBe(
      `ticket-transfer-invitation:TRF-invite-notice:${'b'.repeat(64)}`,
    );
    expect([...emailDeliveries.records.values()]).toHaveLength(2);
    expect([...emailDeliveries.records.values()]).toMatchObject(
      Array.from({ length: 2 }, () => ({ kind: 'ticket_transfer_invitation', status: 'sent' })),
    );
    expect(JSON.stringify(event.payload)).not.toContain(recipientEmail);
  });

  it('does not resolve or email an address-bound invitation without a verified account ID', async () => {
    const sent: unknown[] = [];
    const userLookup = vi.fn();
    const now = new Date('2026-10-28T12:00:00.000Z');
    const deps = {
      config: { clock: { now: () => now } },
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        name: 'resend',
        sendTransactionalEmail: async (message: unknown) => {
          sent.push(message);
          return { providerMessageId: 'should-not-send' };
        },
      },
      repositories: {
        entitlements: {
          getTicketTransfer: async () => ({
            id: 'TRF-email-only',
            status: 'pending',
            recipientUserId: null,
            recipientEmailHash: 'a'.repeat(64),
            expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          }),
        },
        users: { getById: userLookup },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'transfer-email-only-event',
      type: 'ticket.transfer.created',
      aggregateId: 'ENT-email-only',
      organizationId: 'ORG-email-only',
      actorId: 'USR-sender',
      payload: {
        transferId: 'TRF-email-only',
        entitlementId: 'ENT-email-only',
        eventId: 'EVT-email-only',
        recipientBinding: 'verified_email',
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
      occurredAt: now.getTime(),
    });

    await createTransactionalEmailConsumer(deps)(event);

    expect(userLookup).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('notifies only the verified waitlist account for its current bounded offer', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const now = new Date();
    const event = domainEvent({
      id: 'waitlist-offer-event',
      type: 'waitlist.offered',
      aggregateId: 'wait_entry_1',
      organizationId: 'org_1',
      actorId: 'admin_1',
      occurredAt: now.getTime(),
      payload: {
        entryId: 'wait_entry_1',
        eventId: 'event_1',
        tierId: 'tier_1',
        reservationId: 'hold_1',
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      },
    });
    const deps = {
      config: { clock: { now: () => now } },
      emailDeliveries,
      emailSender: {
        name: 'resend',
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'waitlist-offer-message' };
        },
      },
      repositories: {
        waitlist: {
          getById: async () => ({
            id: 'wait_entry_1',
            userId: 'guest_1',
            eventId: 'event_1',
            tierId: 'tier_1',
            status: 'offered',
            offerReservationId: 'hold_1',
            offerExpiresAt: event.payload.expiresAt,
          }),
        },
        users: {
          getById: async () => ({
            id: 'guest_1',
            email: 'guest@real.test',
            emailVerified: true,
          }),
        },
        events: { getById: async () => ({ id: 'event_1', title: '<Sky Night>' }) },
      },
    } as unknown as ServiceDeps;
    const consumer = createTransactionalEmailConsumer(deps);

    await consumer(event);
    await consumer(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('guest@real.test');
    expect(sent[0]?.html).toContain('&lt;Sky Night&gt;');
    expect(sent[0]?.html).toContain('will not charge you automatically');
    expect(sent[0]?.idempotencyKey).toBe('waitlist-offer:wait_entry_1:hold_1');
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'waitlist_offer', status: 'sent' },
    ]);
  });

  it('includes a safe old-to-new venue detail in a material event-change email', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'event-change-email' };
        },
      },
      repositories: {
        orders: {
          getById: async () => ({
            id: 'order_event_change',
            eventId: 'event_venue_change',
            organizationId: 'org_event_change',
            status: 'paid',
            contact: { email: 'guest@real.test' },
            bookingReference: 'BOOK-CHANGE',
          }),
        },
        entitlements: {
          getById: async () => ({
            id: 'entitlement_event_change',
            orderId: 'order_event_change',
            eventId: 'event_venue_change',
            currentHolderUserId: 'holder_event_change',
            status: 'valid',
          }),
        },
        users: {
          getById: async () => ({
            id: 'holder_event_change',
            email: 'holder@real.test',
            emailVerified: true,
          }),
        },
        events: {
          getById: async () => ({
            id: 'event_venue_change',
            title: 'Night Changed',
            startAt: '2026-11-02T18:00:00.000Z',
            venueId: 'venue_after',
          }),
        },
        venues: {
          getById: async (id: string) => ({
            public: { name: id === 'venue_before' ? 'Old Hall' : '<New Hall>' },
          }),
        },
      },
    } as unknown as ServiceDeps;

    await createTransactionalEmailConsumer(deps)(
      domainEvent({
        id: 'event-material-change-email',
        type: 'event.material_change.order_affected',
        aggregateId: 'order_event_change',
        organizationId: 'org_event_change',
        actorId: 'host_change',
        payload: {
          eventId: 'event_venue_change',
          orderId: 'order_event_change',
          entitlementId: 'entitlement_event_change',
          eventVersion: 9,
          previousTitle: 'Night Changed',
          title: 'Night Changed',
          previousStartAt: '2026-11-01T18:00:00.000Z',
          startAt: '2026-11-02T18:00:00.000Z',
          previousVenueId: 'venue_before',
          venueId: 'venue_after',
        },
        occurredAt: Date.now(),
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('holder@real.test');
    expect(sent[0]?.html).toContain('Old Hall');
    expect(sent[0]?.html).toContain('&lt;New Hall&gt;');
    expect(sent[0]?.idempotencyKey).toMatch(
      /^event-change:event_venue_change:9:order_event_change:[0-9a-f]{64}$/,
    );
  });

  it('confirms a purchaser refund-review request without implying approval', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'refund-review-message' };
        },
      },
      repositories: {
        orders: {
          getById: async () => ({
            id: 'ORD-refund-review',
            userId: 'purchaser_review',
            eventId: 'EVT-refund-review',
            status: 'refund_requested',
            bookingReference: 'BOOK-REVIEW',
          }),
        },
        entitlements: {
          getById: async () => ({
            id: 'ENT-refund-review',
            orderId: 'ORD-refund-review',
            eventId: 'EVT-refund-review',
            status: 'valid',
          }),
        },
        users: {
          getById: async () => ({
            id: 'purchaser_review',
            email: 'purchaser-review@real.test',
            emailVerified: true,
          }),
        },
        events: { getById: async () => ({ title: 'Rescheduled Event' }) },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'refund-review-email',
      type: 'event.material_change.refund_requested',
      aggregateId: 'ENT-refund-review',
      organizationId: 'ORG-refund-review',
      actorId: 'purchaser_review',
      payload: {
        eventId: 'EVT-refund-review',
        orderId: 'ORD-refund-review',
        entitlementId: 'ENT-refund-review',
        eventVersion: 3,
      },
      occurredAt: Date.now(),
    });
    const handler = createTransactionalEmailConsumer(deps);

    await handler(event);
    await handler(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('purchaser-review@real.test');
    expect(sent[0]?.html).toContain('recorded');
    expect(sent[0]?.html).toContain('No refund has been approved');
    expect(sent[0]?.idempotencyKey).toBe('refund-review-requested:ENT-refund-review:3');
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'refund_review_requested', status: 'sent' },
    ]);
  });

  it('notifies only the verified current holder after an accepted transfer and deduplicates retries', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'transfer-holder-message' };
        },
      },
      repositories: {
        entitlements: {
          getById: async () => ({
            id: 'ENT-transfer-notice',
            eventId: 'EVT-transfer-notice',
            userId: 'purchaser_user',
            currentHolderUserId: 'verified_holder',
            credentialVersion: 4,
            status: 'valid',
          }),
        },
        users: {
          getById: async (id: string) =>
            id === 'verified_holder'
              ? { id, email: 'holder@real.test', emailVerified: true }
              : null,
        },
        events: { getById: async () => ({ title: '<Private Event>' }) },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'transfer-accepted-notice',
      type: 'ticket.transfer.resolved',
      aggregateId: 'ENT-transfer-notice',
      organizationId: 'ORG-transfer-notice',
      actorId: 'verified_holder',
      payload: {
        transferId: 'TRF-notice',
        entitlementId: 'ENT-transfer-notice',
        eventId: 'EVT-transfer-notice',
        status: 'accepted',
        credentialVersion: 4,
      },
      occurredAt: Date.now(),
    });
    const handler = createTransactionalEmailConsumer(deps);

    await handler(event);
    await handler(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('holder@real.test');
    expect(sent[0]?.idempotencyKey).toBe('ticket-transfer-accepted:TRF-notice:4');
    expect(sent[0]?.html).toContain('&lt;Private Event&gt;');
    expect(sent[0]?.html).not.toContain('TRF-notice');
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'ticket_transfer_accepted', status: 'sent' },
    ]);
  });

  it('notifies the verified sender when a pending transfer expires', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const transfer = {
      id: 'TRF-expiry-notice',
      entitlementId: 'ENT-expiry-notice',
      eventId: 'EVT-expiry-notice',
      senderUserId: 'sender_user',
      recipientUserId: 'recipient_user',
      status: 'expired',
      expiresAt: '2026-10-28T11:00:00.000Z',
      acceptedAt: null,
      resolvedAt: '2026-10-28T12:00:00.000Z',
      version: 2,
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => new Date('2026-10-28T12:00:00.000Z') },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'transfer-expiry-message' };
        },
      },
      repositories: {
        entitlements: {
          getTicketTransfer: async () => transfer,
        },
        users: {
          getById: async (id: string) =>
            id === 'sender_user' ? { id, email: 'sender@real.test', emailVerified: true } : null,
        },
        events: { getById: async () => ({ title: 'Expiry Event' }) },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'transfer-expiry-notice',
      type: 'ticket.transfer.resolved',
      aggregateId: transfer.entitlementId,
      organizationId: 'ORG-expiry-notice',
      actorId: 'system',
      payload: {
        transferId: transfer.id,
        entitlementId: transfer.entitlementId,
        eventId: transfer.eventId,
        status: 'expired',
        credentialVersion: 1,
      },
      occurredAt: Date.parse(transfer.resolvedAt),
    });
    const handler = createTransactionalEmailConsumer(deps);

    await handler(event);
    await handler(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('sender@real.test');
    expect(sent[0]?.subject).toBe('Your C1RCLE ticket invitation expired');
    expect(sent[0]?.html).toContain('Expiry Event');
    expect(sent[0]?.idempotencyKey).toBe(
      'ticket-transfer-expired:TRF-expiry-notice:2026-10-28T12:00:00.000Z',
    );
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'ticket_transfer_expired', status: 'sent' },
    ]);
  });

  it('confirms a successful ticket upgrade to the verified current holder', async () => {
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'upgrade-message' };
        },
      },
      repositories: {
        entitlements: {
          getById: async () => ({
            id: 'ENT-upgrade-new',
            eventId: 'EVT-upgrade-notice',
            userId: 'guest_upgrade',
            currentHolderUserId: 'guest_upgrade',
            status: 'valid',
            upgradeFromEntitlementId: 'ENT-upgrade-old',
            credentialVersion: 1,
          }),
        },
        users: {
          getById: async () => ({
            id: 'guest_upgrade',
            email: 'upgrade-holder@real.test',
            emailVerified: true,
          }),
        },
        events: { getById: async () => ({ title: 'Upgrade Event' }) },
      },
    } as unknown as ServiceDeps;
    const event = domainEvent({
      id: 'ticket-upgrade-notice',
      type: 'ticket.issued',
      aggregateId: 'ENT-upgrade-new',
      organizationId: 'ORG-upgrade-notice',
      actorId: 'guest_upgrade',
      payload: {
        entitlementId: 'ENT-upgrade-new',
        orderId: 'ORD-upgrade-notice',
        eventId: 'EVT-upgrade-notice',
        purchaserUserId: 'guest_upgrade',
        holderUserId: 'guest_upgrade',
        upgradeFromEntitlementId: 'ENT-upgrade-old',
      },
      occurredAt: Date.now(),
    });
    const handler = createTransactionalEmailConsumer(deps);

    await handler(event);
    await handler(event);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('upgrade-holder@real.test');
    expect(sent[0]?.subject).toBe('Your C1RCLE ticket upgrade is confirmed');
    expect(sent[0]?.html).toContain('Upgrade Event');
    expect(sent[0]?.idempotencyKey).toBe(
      'ticket-upgrade-confirmed:ENT-upgrade-new:ENT-upgrade-old',
    );
    expect([...emailDeliveries.records.values()]).toMatchObject([
      { kind: 'ticket_upgrade_confirmed', status: 'sent' },
    ]);
  });

  it('skips stale ownership events and unverified holder email addresses', async () => {
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    let verified = false;
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async () => ({ providerMessageId: 'should-not-send' }),
      },
      repositories: {
        entitlements: {
          getById: async () => ({
            id: 'ENT-stale-notice',
            eventId: 'EVT-stale-notice',
            userId: 'purchaser_user',
            currentHolderUserId: 'current_holder',
            credentialVersion: 5,
            status: 'valid',
          }),
        },
        users: {
          getById: async (id: string) => ({
            id,
            email: 'holder@real.test',
            emailVerified: verified,
          }),
        },
        events: { getById: async () => ({ title: 'Private Event' }) },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);

    await handler(
      domainEvent({
        id: 'stale-transfer-notice',
        type: 'ticket.transfer.resolved',
        aggregateId: 'ENT-stale-notice',
        organizationId: 'ORG-stale-notice',
        actorId: 'old_holder',
        payload: {
          transferId: 'TRF-stale',
          entitlementId: 'ENT-stale-notice',
          eventId: 'EVT-stale-notice',
          status: 'accepted',
          credentialVersion: 4,
        },
        occurredAt: Date.now(),
      }),
    );
    verified = false;
    await handler(
      domainEvent({
        id: 'unverified-holder-notice',
        type: 'ticket.issued',
        aggregateId: 'ENT-stale-notice',
        organizationId: 'ORG-stale-notice',
        actorId: 'purchaser_user',
        payload: {
          entitlementId: 'ENT-stale-notice',
          orderId: 'ORD-stale-notice',
          eventId: 'EVT-stale-notice',
          purchaserUserId: 'purchaser_user',
          holderUserId: 'current_holder',
        },
        occurredAt: Date.now(),
      }),
    );
    verified = true;
    const loggingHandler = createTransactionalEmailConsumer({
      ...deps,
      emailSender: {
        name: 'logging',
        sendTransactionalEmail: async () => ({ providerMessageId: 'suppressed' }),
      },
    } as unknown as ServiceDeps);
    await loggingHandler(
      domainEvent({
        id: 'logging-provider-notice',
        type: 'ticket.issued',
        aggregateId: 'ENT-stale-notice',
        organizationId: 'ORG-stale-notice',
        actorId: 'purchaser_user',
        payload: {
          entitlementId: 'ENT-stale-notice',
          orderId: 'ORD-stale-notice',
          eventId: 'EVT-stale-notice',
          purchaserUserId: 'purchaser_user',
          holderUserId: 'current_holder',
        },
        occurredAt: Date.now(),
      }),
    );

    expect([...emailDeliveries.records.values()]).toHaveLength(0);
  });

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

  it('sends idempotent, escaped onboarding status email to the applicant on file', async () => {
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const sent: { to: string; subject: string; html: string; idempotencyKey: string }[] = [];
    let status: 'submitted' | 'approved' | 'rejected' = 'submitted';
    const application = {
      id: 'request_1',
      userId: 'user_1',
      status,
      profile: { legalName: '<Blue Room>' },
    };
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: `message-${sent.length}` };
        },
      },
      userDirectory: { getEmailById: async () => 'applicant@partner.test' },
      repositories: {
        onboarding: { getById: async () => ({ ...application, status }) },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const events = [
      {
        type: 'promoter.onboarding.submitted' as const,
        payload: { requestId: application.id },
      },
      {
        type: 'promoter.onboarding.approved' as const,
        payload: { requestId: application.id, promoterId: 'promoter_1' },
      },
      {
        type: 'promoter.onboarding.rejected' as const,
        payload: { requestId: application.id },
      },
    ];

    for (const [index, item] of events.entries()) {
      status = item.type.endsWith('submitted')
        ? 'submitted'
        : item.type.endsWith('approved')
          ? 'approved'
          : 'rejected';
      const event = domainEvent({
        id: `onboarding-event-${index}`,
        type: item.type,
        aggregateId: application.id,
        organizationId: 'user_1',
        actorId: 'actor_1',
        payload: item.payload,
        occurredAt: Date.now(),
      });
      await handler(event);
      await handler(event);
    }

    expect(sent).toHaveLength(3);
    expect(sent[0]?.to).toBe('applicant@partner.test');
    expect(sent.map((message) => message.idempotencyKey)).toEqual([
      'promoter-onboarding:request_1:submitted',
      'promoter-onboarding:request_1:approved',
      'promoter-onboarding:request_1:rejected',
    ]);
    expect(sent[0]?.html).toContain('&lt;Blue Room&gt;');
    expect(sent[0]?.html).not.toContain('<Blue Room>');
    expect([...emailDeliveries.records.values()]).toHaveLength(3);
    expect(
      [...emailDeliveries.records.values()].every((row) => !row.recipientHash.includes('@')),
    ).toBe(true);
  });

  it('sends Promoter suspension email only to the stored owner of a Promoter organization', async () => {
    const sent: { to: string; html: string }[] = [];
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'suspension-message' };
        },
      },
      userDirectory: { getEmailById: async (userId: string) => `${userId}@partner.test` },
      repositories: {
        organizations: {
          getById: async () => ({
            ownerId: 'promoter_owner',
            members: [{ capabilities: ['promoter'] }],
          }),
        },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const event = (id: string, status: 'suspended' | 'active') =>
      domainEvent({
        id,
        type: 'promoter.assignments.status_changed',
        aggregateId: 'promoter_org',
        organizationId: 'promoter_org',
        actorId: 'admin_1',
        payload: { promoterId: 'promoter_org', status, affectedAssignments: 2 },
        occurredAt: Date.now(),
      });

    await handler(event('active-event', 'active'));
    await handler(event('suspended-event', 'suspended'));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('promoter_owner@partner.test');
    expect(sent[0]?.html).toContain('2 event assignments were paused');
  });

  it('sends an idempotent expiry email to the Promoter organization owner', async () => {
    const sent: { to: string; html: string; idempotencyKey: string }[] = [];
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
      }),
      emailDeliveries: new MemoryEmailDeliveryRepository(),
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: 'expiry-message' };
        },
      },
      userDirectory: { getEmailById: async () => 'promoter-owner@partner.test' },
      repositories: {
        organizations: {
          getById: async () => ({
            ownerId: 'promoter_owner',
            members: [{ capabilities: ['promoter'] }],
          }),
        },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const expired = domainEvent({
      id: 'assignment-expired-event',
      type: 'promoter.assignment.expired',
      aggregateId: 'assignment_3',
      organizationId: 'host_1',
      actorId: 'system',
      payload: {
        assignmentId: 'assignment_3',
        eventId: 'event_3',
        promoterId: 'promoter_1',
        eventTitle: '<Sky Night>',
        expiresAt: '2026-11-01T00:00:00.000Z',
      },
      occurredAt: Date.now(),
    });

    await handler(expired);
    await handler(expired);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('promoter-owner@partner.test');
    expect(sent[0]?.idempotencyKey).toBe(
      'promoter-assignment-expired:assignment_3:2026-11-01T00:00:00.000Z',
    );
    expect(sent[0]?.html).toContain('&lt;Sky Night&gt;');
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
        entitlements: {
          getByOrderId: async () => [
            {
              id: 'entitlement_paid_1',
              orderId: 'paid_1',
              eventId: 'event_1',
              currentHolderUserId: 'holder_1',
              status: 'valid',
            },
          ],
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
    expect(affected).toHaveLength(2);
    expect(affected[0]?.aggregateId).toBe('paid_1');
    expect(affected).toMatchObject([
      { payload: { payload: { entitlementId: 'entitlement_paid_1' } } },
      { payload: { payload: { entitlementId: null } } },
    ]);
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

  it('delivers idempotent assignment, cover-correction and add-on redemption notices', async () => {
    const sent: { to: string; subject: string; idempotencyKey: string }[] = [];
    const emailDeliveries = new MemoryEmailDeliveryRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    const deps = {
      config: createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'tests' },
        clock: { now: () => now },
      }),
      emailDeliveries,
      emailSender: {
        sendTransactionalEmail: async (message: (typeof sent)[number]) => {
          sent.push(message);
          return { providerMessageId: `provider-${sent.length}` };
        },
      },
      userDirectory: {
        getEmailById: async (userId: string) =>
          userId === 'promoter_owner' ? 'promoter-owner@real.test' : null,
      },
      repositories: {
        organizations: {
          getById: async (id: string) =>
            id === 'promoter_org' ? { id, ownerId: 'promoter_owner', members: [] } : null,
        },
        eventCoverAccounts: {
          getByEntitlement: async () => ({
            id: 'cover_account_1',
            entitlementId: 'entitlement_1',
            eventId: 'event_1',
            orderId: 'order_1',
            guestUserId: 'guest_1',
            status: 'active',
          }),
        },
        users: {
          getById: async () => ({
            id: 'guest_1',
            email: 'guest-owner@real.test',
            emailVerified: true,
          }),
        },
        events: { getById: async () => ({ id: 'event_1', title: 'Sky Night' }) },
        entitlements: {
          getById: async () => ({
            id: 'entitlement_1',
            eventId: 'event_1',
            status: 'valid',
            currentHolderUserId: 'guest_1',
            ticketAddons: [{ id: 'addon_entitlement_1', addonId: 'addon_1', status: 'active' }],
          }),
        },
        catalog: {
          getTicketAddonById: async () => ({ id: 'addon_1', name: 'Parking pass' }),
        },
      },
    } as unknown as ServiceDeps;
    const handler = createTransactionalEmailConsumer(deps);
    const assignmentEvent = domainEvent({
      id: 'assignment-email',
      type: 'promoter.assignment.invited',
      aggregateId: 'assignment_1',
      organizationId: 'event_org',
      actorId: 'host_1',
      payload: {
        assignmentId: 'assignment_1',
        eventId: 'event_1',
        promoterId: 'promoter_org',
        eventTitle: 'Sky Night',
      },
      occurredAt: now.getTime(),
    });
    const coverEvent = domainEvent({
      id: 'cover-redeemed-email',
      type: 'event-cover.redeemed',
      aggregateId: 'cover_account_1',
      organizationId: 'event_org',
      actorId: 'venue_1',
      payload: {
        accountId: 'cover_account_1',
        entitlementId: 'entitlement_1',
        eventId: 'event_1',
        operationId: 'operation_1',
        venueOrganizationId: 'venue_org',
        amountPaise: 5000,
      },
      occurredAt: now.getTime(),
    });
    const addonEvent = domainEvent({
      id: 'addon-redeemed-email',
      type: 'ticket.addon.redeemed',
      aggregateId: 'entitlement_1',
      organizationId: 'event_org',
      actorId: 'venue_1',
      payload: {
        entitlementId: 'entitlement_1',
        addonEntitlementId: 'addon_entitlement_1',
        addonId: 'addon_1',
        eventId: 'event_1',
      },
      occurredAt: now.getTime(),
    });

    await handler(assignmentEvent);
    await handler(assignmentEvent);
    await handler(coverEvent);
    await handler(coverEvent);
    await handler(addonEvent);
    await handler(addonEvent);

    expect(sent).toHaveLength(3);
    expect(sent.map((item) => item.to)).toEqual([
      'promoter-owner@real.test',
      'guest-owner@real.test',
      'guest-owner@real.test',
    ]);
    expect(sent.map((item) => item.idempotencyKey)).toEqual([
      'promoter-assignment-email:assignment_1:promoter.assignment.invited',
      'event-cover-email:event-cover.redeemed:cover_account_1:operation_1',
      'ticket-addon-redeemed:addon_entitlement_1',
    ]);
    expect([...emailDeliveries.records.values()]).toHaveLength(3);
  });
});
