import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { NotFoundError, ServiceUnavailableError } from '../../domain/errors.js';
import { createNotification, eventMaterialChangeSubjectId } from '../../domain/models/social.js';
import { createTicketTransfer } from '../../domain/models/ticket-transfer.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import { MemoryEntitlementRepository } from '../../infrastructure/memory/memory-repositories.js';
import { MemorySocialNotificationRepository } from '../../infrastructure/memory/memory-social-repositories.js';

import { TicketService } from './ticket-service.js';

import type { Entitlement } from '../../domain/models/entitlement.js';
import type { ActorContext, ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const ticket: Entitlement = {
  id: 'ENT-service-transfer',
  orderId: 'ORD-service-transfer',
  eventId: 'EVT-service-transfer',
  organizationId: 'ORG-service-transfer',
  tierId: 'TIER-service-transfer',
  tierName: 'General',
  userId: 'USR-sender',
  currentHolderUserId: 'USR-sender',
  credentialVersion: 1,
  pendingTransferId: null,
  holderName: 'Sender',
  status: 'valid',
  scanCountAllowed: 1,
  scanCount: 0,
  scannedAt: [],
  refundLock: null,
  version: 1,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function actor(userId: string): ActorContext {
  return { userId, organizationId: '', role: 'member', capabilities: [] };
}

function service(
  enabled: boolean,
  transferPrerequisites: {
    manifestsDisabled?: boolean;
    drainComplete?: boolean;
    coverReserved?: boolean;
    verifiedRecipient?: boolean;
  } = {},
  purchaserId = ticket.userId,
) {
  const entitlements = new MemoryEntitlementRepository();
  const notifications = new MemorySocialNotificationRepository();
  const outbox = new MemoryOutboxStore();
  const deps = {
    config: createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
      ids: () => 'TRF-service-1',
      features: {
        m5TicketTransfers: enabled,
        ...(transferPrerequisites.manifestsDisabled ? { m5OfflineTicketManifests: false } : {}),
        ...(transferPrerequisites.drainComplete ? { m5OfflineManifestDrainComplete: true } : {}),
      },
    }),
    outbox,
    repositories: {
      entitlements,
      eventCoverAccounts: {
        getByEntitlement: async () =>
          transferPrerequisites.coverReserved
            ? ({ status: 'active', reservedPaise: 100 } as never)
            : null,
      },
      events: {
        getById: async () => ({ status: 'published', startAt: '2026-12-01T00:00:00.000Z' }),
      },
      orders: {
        getById: async (id: string) => ({
          id,
          eventId: ticket.eventId,
          userId: purchaserId,
          status: 'paid',
        }),
      },
      socialNotifications: notifications,
      users: {
        getById: async (userId: string) =>
          userId === 'USR-recipient'
            ? { id: userId, email: 'recipient@example.test', emailVerified: true }
            : userId === 'USR-unverified'
              ? { id: userId, email: 'unverified@example.test', emailVerified: false }
              : null,
        getByEmail: async (email: string) =>
          transferPrerequisites.verifiedRecipient
            ? {
                id: 'USR-recipient',
                email,
                emailVerified: true,
                name: 'Recipient',
                image: null,
                role: 'guest',
                createdAt: NOW.getTime(),
                updatedAt: NOW.getTime(),
              }
            : null,
      },
      guestProfiles: { getByUserId: async () => ({ displayName: 'Recipient Name' }) },
    },
  } as unknown as ServiceDeps;
  return { entitlements, notifications, outbox, service: new TicketService(deps) };
}

function materialChangeNotice(userId: string, entitlement: Entitlement = ticket) {
  const eventVersion = 2;
  const subjectId = eventMaterialChangeSubjectId(
    entitlement.eventId,
    eventVersion,
    entitlement.orderId,
    entitlement.id,
  );
  return createNotification({
    userId,
    type: 'event.material_change',
    title: 'Event details changed',
    body: 'Review the current event details.',
    link: '/tickets',
    subjectId,
    eventChange: {
      eventVersion,
      entitlementId: entitlement.id,
      canAccept: true,
      canRequestRefund: true,
    },
    now: NOW,
  });
}

describe('TicketService transfer controls', () => {
  it('keeps transfer endpoints disabled unless the deployment explicitly enables the flag', async () => {
    const { entitlements, service: tickets } = service(false);
    await entitlements.save(ticket);

    await expect(
      tickets.requestTransfer(ticket.id, 'recipient@example.test', actor('USR-sender')),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('keeps transfers unavailable until offline manifests are disabled and drained', async () => {
    const { entitlements, service: tickets } = service(true, { manifestsDisabled: true });
    await entitlements.save(ticket);

    await expect(
      tickets.requestTransfer(ticket.id, 'recipient@example.test', actor('USR-sender')),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('blocks transfer while a pending Guest confirmation holds cover funds', async () => {
    const { entitlements, service: tickets } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
      coverReserved: true,
    });
    await entitlements.save(ticket);

    await expect(
      tickets.requestTransfer(ticket.id, 'recipient@example.test', actor('USR-sender')),
    ).rejects.toThrow(/event cover is reserved or frozen/);
  });

  it('creates an email-bound invite without revealing whether its recipient has an account', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save(ticket);

    const pending = await tickets.requestTransfer(
      ticket.id,
      '  Recipient@Example.Test ',
      actor('USR-sender'),
    );
    expect(pending).toMatchObject({ recipientUserId: null, status: 'pending' });
    expect(pending.recipientEmailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outbox.all()).toMatchObject([
      {
        type: 'ticket.transfer.created',
        status: 'pending',
        payload: {
          type: 'ticket.transfer.created',
          payload: { transferId: pending.id, recipientBinding: 'verified_email' },
        },
      },
    ]);
    expect(JSON.stringify(outbox.all())).not.toContain('recipient@example.test');
  });

  it('lets a purchaser invite an explicitly unassigned group unit for verified-email claim', async () => {
    const { entitlements, service: tickets } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save({ ...ticket, currentHolderUserId: null, holderName: '' });

    const pending = await tickets.requestTransfer(
      ticket.id,
      'recipient@example.test',
      actor('USR-sender'),
    );
    expect(await entitlements.getById(ticket.id)).toMatchObject({
      currentHolderUserId: null,
      pendingTransferId: pending.id,
      credentialVersion: 1,
    });

    const accepted = await tickets.resolveTransfer(pending.id, 'accept', actor('USR-recipient'));
    expect(accepted.entitlement).toMatchObject({
      userId: 'USR-sender',
      currentHolderUserId: 'USR-recipient',
      credentialVersion: 2,
      holderName: 'Recipient Name',
    });
  });

  it('binds a known verified account for private outbox delivery without exposing the match', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
      verifiedRecipient: true,
    });
    await entitlements.save(ticket);

    const pending = await tickets.requestTransfer(
      ticket.id,
      'recipient@example.test',
      actor('USR-sender'),
    );

    expect(pending).toMatchObject({ recipientUserId: 'USR-recipient', status: 'pending' });
    expect(outbox.all()).toMatchObject([
      {
        type: 'ticket.transfer.created',
        payload: {
          type: 'ticket.transfer.created',
          payload: { transferId: pending.id, recipientBinding: 'account' },
        },
      },
    ]);
    expect(JSON.stringify(outbox.all())).not.toContain('recipient@example.test');
  });

  it('queues a sender-authorized, idempotent resend event without storing the request key', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
      verifiedRecipient: true,
    });
    await entitlements.save(ticket);
    const pending = await tickets.requestTransfer(
      ticket.id,
      'recipient@example.test',
      actor('USR-sender'),
    );
    const resendActor = actor('USR-sender');

    await expect(
      tickets.resendTransferInvitation(pending.id, 'resend-key-001', resendActor),
    ).resolves.toEqual({ requested: true });
    await tickets.resendTransferInvitation(pending.id, 'resend-key-001', resendActor);

    const resendEvents = outbox
      .all()
      .filter((event) => event.type === 'ticket.transfer.invitation_resent');
    expect(resendEvents).toHaveLength(1);
    expect(resendEvents[0]?.payload).toMatchObject({
      payload: {
        transferId: pending.id,
        deliveryRequestId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(resendEvents)).not.toContain('resend-key-001');
    await expect(
      tickets.resendTransferInvitation(pending.id, 'resend-key-002', actor('USR-other')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('expires stale invitations while listing history and releases the ticket lock', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save(ticket);
    const stale = createTicketTransfer({
      id: 'TRF-expired',
      entitlementId: ticket.id,
      eventId: ticket.eventId,
      senderUserId: 'USR-sender',
      recipientEmailHash: 'a'.repeat(64),
      expiresAt: '2026-10-28T11:00:00.000Z',
      now: new Date('2026-10-28T10:00:00.000Z'),
    });
    await entitlements.createTicketTransfer(stale, 'USR-sender');

    await expect(tickets.listTransfers(ticket.id, actor('USR-sender'))).resolves.toMatchObject([
      { id: 'TRF-expired', status: 'expired' },
    ]);
    await expect(tickets.getById(ticket.id, actor('USR-sender'))).resolves.toMatchObject({
      pendingTransferId: null,
    });
    expect(outbox.all()).toMatchObject([
      {
        type: 'ticket.transfer.resolved',
        payload: { type: 'ticket.transfer.resolved', payload: { status: 'expired' } },
      },
    ]);
  });

  it('worker cleanup expires stale invitations and releases their ticket locks', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save(ticket);
    const stale = createTicketTransfer({
      id: 'TRF-worker-expired',
      entitlementId: ticket.id,
      eventId: ticket.eventId,
      senderUserId: 'USR-sender',
      recipientEmailHash: 'b'.repeat(64),
      expiresAt: '2026-10-28T11:00:00.000Z',
      now: new Date('2026-10-28T10:00:00.000Z'),
    });
    await entitlements.createTicketTransfer(stale, 'USR-sender');

    await expect(tickets.cleanupExpiredTransfers(NOW, 10)).resolves.toBe(1);
    await expect(entitlements.getById(ticket.id)).resolves.toMatchObject({
      pendingTransferId: null,
    });
    expect(outbox.all()).toMatchObject([
      {
        type: 'ticket.transfer.resolved',
        payload: { type: 'ticket.transfer.resolved', payload: { status: 'expired' } },
      },
    ]);
    expect(JSON.stringify(outbox.all())).not.toContain('b'.repeat(64));
  });

  it('does not allow an RSVP entitlement to consume another account free-claim allowance', async () => {
    const { entitlements, service: tickets } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save({
      ...ticket,
      orderId: 'RSVP-event-1',
      unitKind: 'free_rsvp',
    });

    await expect(
      tickets.requestTransfer(ticket.id, 'recipient@example.test', actor('USR-sender')),
    ).rejects.toThrow(/Free RSVPs cannot be transferred/);
  });

  it('binds acceptance to the recipient account and returns the ticket only to that holder', async () => {
    const {
      entitlements,
      outbox,
      service: tickets,
    } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save(ticket);
    const pending = await tickets.requestTransfer(
      ticket.id,
      'recipient@example.test',
      actor('USR-sender'),
    );

    await expect(
      tickets.resolveTransfer(pending.id, 'accept', actor('USR-sender')),
    ).rejects.toThrow(/not found/);
    await expect(
      tickets.resolveTransfer(pending.id, 'accept', actor('USR-unverified')),
    ).rejects.toThrow(/not found/);
    const accepted = await tickets.resolveTransfer(pending.id, 'accept', actor('USR-recipient'));
    expect(accepted.entitlement).toMatchObject({
      userId: 'USR-sender',
      currentHolderUserId: 'USR-recipient',
      credentialVersion: 2,
      holderName: 'Recipient Name',
    });
    expect(outbox.all().map((record) => record.type)).toContain('ticket.transfer.resolved');
    await expect(tickets.getById(ticket.id, actor('USR-sender'))).rejects.toThrow(/not found/);
    await expect(tickets.getById(ticket.id, actor('USR-recipient'))).resolves.toMatchObject({
      currentHolderUserId: 'USR-recipient',
    });
  });

  it('lets only the verified invited recipient decline without changing the holder', async () => {
    const { entitlements, service: tickets } = service(true, {
      manifestsDisabled: true,
      drainComplete: true,
    });
    await entitlements.save(ticket);
    const pending = await tickets.requestTransfer(
      ticket.id,
      'recipient@example.test',
      actor('USR-sender'),
    );

    await expect(
      tickets.resolveTransfer(pending.id, 'decline', actor('USR-sender')),
    ).rejects.toThrow(/not found/);
    const declined = await tickets.resolveTransfer(pending.id, 'decline', actor('USR-recipient'));
    expect(declined.transfer).toMatchObject({ status: 'declined', resolvedAt: NOW.toISOString() });
    expect(declined.entitlement).toBeUndefined();
    await expect(tickets.getById(ticket.id, actor('USR-sender'))).resolves.toMatchObject({
      currentHolderUserId: 'USR-sender',
      credentialVersion: 1,
      pendingTransferId: null,
    });
    await expect(tickets.getById(ticket.id, actor('USR-recipient'))).rejects.toThrow(/not found/);
    await expect(
      tickets.resolveTransfer(pending.id, 'decline', actor('USR-recipient')),
    ).resolves.toMatchObject({ transfer: { status: 'declined' } });
  });
});

describe('TicketService material event-change responses', () => {
  it('records an idempotent acceptance without changing the admission entitlement', async () => {
    const { entitlements, notifications, service: tickets } = service(false);
    await entitlements.save(ticket);
    await notifications.create(materialChangeNotice('USR-sender'));

    const first = await tickets.respondToMaterialEventChange(
      ticket.id,
      2,
      'accepted',
      actor('USR-sender'),
    );
    const replay = await tickets.respondToMaterialEventChange(
      ticket.id,
      2,
      'accepted',
      actor('USR-sender'),
    );

    expect(first).toMatchObject({ response: 'accepted', replayed: false, refundCreated: false });
    expect(replay).toMatchObject({ response: 'accepted', replayed: true, refundCreated: false });
    expect(await entitlements.getById(ticket.id)).toMatchObject({ status: 'valid', scanCount: 0 });
    await expect(
      tickets.respondToMaterialEventChange(ticket.id, 2, 'refund_requested', actor('USR-sender')),
    ).rejects.toThrow(/different response is already recorded/);
  });

  it('allows only the current holder to accept and only the purchaser to request refund review', async () => {
    const {
      entitlements,
      notifications,
      outbox,
      service: tickets,
    } = service(false, {}, 'USR-buyer');
    const transferred = { ...ticket, userId: 'USR-buyer', currentHolderUserId: 'USR-holder' };
    await entitlements.save(transferred);
    await notifications.create(materialChangeNotice('USR-holder', transferred));
    await notifications.create(materialChangeNotice('USR-buyer', transferred));

    await expect(
      tickets.respondToMaterialEventChange(ticket.id, 2, 'accepted', actor('USR-holder')),
    ).resolves.toMatchObject({ response: 'accepted' });
    await expect(
      tickets.respondToMaterialEventChange(ticket.id, 2, 'refund_requested', actor('USR-holder')),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      tickets.respondToMaterialEventChange(ticket.id, 2, 'refund_requested', actor('USR-buyer')),
    ).resolves.toMatchObject({ response: 'refund_requested', refundCreated: false });
    expect(outbox.all().map((record) => record.type)).toContain(
      'event.material_change.refund_requested',
    );
    await expect(
      tickets.respondToMaterialEventChange(ticket.id, 2, 'accepted', actor('USR-buyer')),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
