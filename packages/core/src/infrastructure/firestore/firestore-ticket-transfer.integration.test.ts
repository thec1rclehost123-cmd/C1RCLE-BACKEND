import { createHash, randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';
import { freezeEntitlementForRefund } from '../../domain/models/entitlement.js';
import { createTicketTransfer } from '../../domain/models/ticket-transfer.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('ticket transfer transactions (Firestore emulator)', () => {
  it('requires explicit eligibility verification inside the atomic admission transaction', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-eligibility-${suffix}`;
    const now = new Date();
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'Student',
      userId: `USR-${suffix}`,
      currentHolderUserId: `USR-${suffix}`,
      holderName: 'Guest',
      eligibility: {
        audienceType: 'STUDENT',
        minAge: null,
        maxAge: null,
        attested: true,
        attestedAt: now.toISOString(),
      },
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const doc = db.collection('v2_entitlements').doc(entitlementId);
    try {
      await repo.save(ticket);
      const refused = await repo.claimAdmission(entitlementId, ticket.eventId, { now });
      expect(refused).toMatchObject({ admitted: false, denyReason: 'eligibility_required' });
      expect((await repo.getById(entitlementId))?.scanCount).toBe(0);

      const admitted = await repo.claimAdmission(entitlementId, ticket.eventId, {
        eligibilityVerified: true,
        now,
      });
      expect(admitted).toMatchObject({ admitted: true, scansUsed: 1 });
      expect((await repo.getById(entitlementId))?.scanCount).toBe(1);
    } finally {
      await doc.delete();
      await db.terminate();
    }
  }, 30_000);

  it('admits one pending transfer and rotates holder/version atomically on accept', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-transfer-${suffix}`;
    const rsvpEntitlementId = `ENT-rsvp-${suffix}`;
    const groupEntitlementId = `ENT-group-${suffix}`;
    const custodyEntitlementId = `ENT-custody-${suffix}`;
    const emailEntitlementId = `ENT-email-${suffix}`;
    const frozenEntitlementId = `ENT-frozen-${suffix}`;
    const firstTransferId = `TRF-${suffix}`;
    const secondTransferId = `TRF2-${suffix}`;
    const custodyTransferId = `TRF-custody-${suffix}`;
    const frozenTransferId = `TRF-frozen-${suffix}`;
    const senderUserId = `USR-sender-${suffix}`;
    const recipientUserId = `USR-recipient-${suffix}`;
    const now = new Date();
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'General',
      userId: senderUserId,
      currentHolderUserId: senderUserId,
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Sender',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const first = createTicketTransfer({
      id: firstTransferId,
      entitlementId,
      eventId: ticket.eventId,
      senderUserId,
      recipientUserId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    const second = createTicketTransfer({
      ...first,
      id: secondTransferId,
      recipientUserId: `USR-second-${suffix}`,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    const transferCollection = db.collection('v2_ticket_transfers');
    const entitlementCollection = db.collection('v2_entitlements');
    const outboxCollection = db.collection('v2_outbox');
    const createdEvents = [first, second].map((transfer) =>
      domainEvent({
        id: `EVT-transfer-created-${transfer.id}`,
        type: 'ticket.transfer.created',
        aggregateId: ticket.id,
        organizationId: ticket.organizationId,
        actorId: senderUserId,
        payload: {
          transferId: transfer.id,
          entitlementId: ticket.id,
          eventId: ticket.eventId,
          recipientBinding: 'account' as const,
          expiresAt: transfer.expiresAt,
        },
        occurredAt: now.getTime(),
      }),
    );

    try {
      await repo.save(ticket);
      await repo.save({
        ...ticket,
        id: rsvpEntitlementId,
        orderId: `RSVP-${suffix}`,
        unitKind: 'free_rsvp',
      });
      await repo.save({
        ...ticket,
        id: groupEntitlementId,
        scanCountAllowed: 2,
      });
      expect(await repo.countActivePaidUnitsByUserAndEvent(senderUserId, ticket.eventId)).toBe(3);
      const attempts = await Promise.allSettled([
        repo.createTicketTransfer(first, senderUserId, createdEvents[0]),
        repo.createTicketTransfer(second, senderUserId, createdEvents[1]),
      ]);
      expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const pending = await repo.getById(entitlementId);
      const transferId = pending?.pendingTransferId;
      expect(transferId).toBeTruthy();
      if (!transferId) throw new Error('expected one transfer to win');
      const transfer = await repo.getTicketTransfer(transferId);
      if (!transfer) throw new Error('expected stored transfer record');
      expect(transfer?.status).toBe('pending');
      const createdEvent = createdEvents.find((event) => event.payload.transferId === transferId);
      if (!createdEvent) throw new Error('expected the winning transfer event');
      expect((await outboxCollection.doc(createdEvent.id).get()).data()).toMatchObject({
        id: createdEvent.id,
        type: 'ticket.transfer.created',
        status: 'pending',
        payload: createdEvent,
      });
      expect(createdEvent.payload).not.toHaveProperty('recipientEmailHash');
      const winningRecipientUserId = transfer.recipientUserId;
      if (!winningRecipientUserId) throw new Error('expected account-bound legacy transfer');

      const resolvedEvent = domainEvent({
        id: `EVT-transfer-resolved-${transferId}`,
        type: 'ticket.transfer.resolved',
        aggregateId: ticket.id,
        organizationId: ticket.organizationId,
        actorId: winningRecipientUserId,
        payload: {
          transferId,
          entitlementId: ticket.id,
          eventId: ticket.eventId,
          status: 'accepted' as const,
          credentialVersion: 2,
        },
        occurredAt: now.getTime() + 1000,
      });
      const accepted = await repo.resolveTicketTransfer({
        transferId,
        actorUserId: winningRecipientUserId,
        action: 'accept',
        holderName: 'Recipient',
        now: new Date(now.getTime() + 1000),
        outboxEvent: resolvedEvent,
      });
      expect((await outboxCollection.doc(resolvedEvent.id).get()).data()).toMatchObject({
        id: resolvedEvent.id,
        type: 'ticket.transfer.resolved',
        status: 'pending',
        payload: resolvedEvent,
      });
      expect(accepted.entitlement).toMatchObject({
        userId: ticket.userId,
        currentHolderUserId: winningRecipientUserId,
        credentialVersion: 2,
        pendingTransferId: null,
      });
      const stale = await repo.claimAdmission(entitlementId, ticket.eventId, {
        expectedCredentialVersion: 1,
      });
      expect(stale).toMatchObject({ admitted: false, denyReason: 'invalid_signature' });

      const invitedEmailHash = createHash('sha256').update('claim@example.test').digest('hex');
      await repo.save({
        ...ticket,
        id: emailEntitlementId,
        currentHolderUserId: winningRecipientUserId,
      });
      const emailTransfer = createTicketTransfer({
        id: `TRF-email-${suffix}`,
        entitlementId: emailEntitlementId,
        eventId: ticket.eventId,
        senderUserId: winningRecipientUserId,
        recipientEmailHash: invitedEmailHash,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        now,
      });
      await repo.createTicketTransfer(emailTransfer, winningRecipientUserId);
      await expect(
        repo.resolveTicketTransfer({
          transferId: emailTransfer.id,
          actorUserId: `USR-wrong-${suffix}`,
          recipientEmailHash: createHash('sha256').update('wrong@example.test').digest('hex'),
          action: 'accept',
          now: new Date(now.getTime() + 2_000),
        }),
      ).rejects.toThrow(/not found/);
      const emailClaim = await repo.resolveTicketTransfer({
        transferId: emailTransfer.id,
        actorUserId: `USR-claim-${suffix}`,
        recipientEmailHash: invitedEmailHash,
        action: 'accept',
        holderName: 'Claimed recipient',
        now: new Date(now.getTime() + 3_000),
      });
      expect(emailClaim.entitlement).toMatchObject({
        currentHolderUserId: `USR-claim-${suffix}`,
        credentialVersion: 2,
      });
      const emailStale = await repo.claimAdmission(emailEntitlementId, ticket.eventId, {
        expectedCredentialVersion: 1,
      });
      expect(emailStale).toMatchObject({ admitted: false, denyReason: 'invalid_signature' });
      const current = await repo.claimAdmission(entitlementId, ticket.eventId, {
        expectedCredentialVersion: 2,
      });
      expect(current).toMatchObject({ admitted: true, scansUsed: 1 });

      await repo.save({
        ...ticket,
        id: custodyEntitlementId,
        currentHolderUserId: null,
        holderName: '',
      });
      const custodyTransfer = createTicketTransfer({
        id: custodyTransferId,
        entitlementId: custodyEntitlementId,
        eventId: ticket.eventId,
        senderUserId,
        recipientUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        now,
      });
      await repo.createTicketTransfer(custodyTransfer, senderUserId);
      const custodyAccepted = await repo.resolveTicketTransfer({
        transferId: custodyTransferId,
        actorUserId: recipientUserId,
        action: 'accept',
        holderName: 'Group Guest',
        now: new Date(now.getTime() + 2000),
      });
      expect(custodyAccepted.entitlement).toMatchObject({
        userId: senderUserId,
        currentHolderUserId: recipientUserId,
        credentialVersion: 2,
        holderName: 'Group Guest',
      });

      await repo.save({ ...ticket, id: frozenEntitlementId });
      const frozenTransfer = createTicketTransfer({
        id: frozenTransferId,
        entitlementId: frozenEntitlementId,
        eventId: ticket.eventId,
        senderUserId,
        recipientUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        now,
      });
      await repo.createTicketTransfer(frozenTransfer, senderUserId);
      const freezeEvent = domainEvent({
        id: `EVT-transfer-frozen-${suffix}`,
        type: 'ticket.transfer.resolved',
        aggregateId: frozenEntitlementId,
        organizationId: ticket.organizationId,
        actorId: `USR-admin-${suffix}`,
        payload: {
          transferId: frozenTransferId,
          entitlementId: frozenEntitlementId,
          eventId: ticket.eventId,
          status: 'frozen' as const,
          credentialVersion: 1,
        },
        occurredAt: now.getTime() + 4_000,
      });
      const frozen = await repo.resolveTicketTransfer({
        transferId: frozenTransferId,
        actorUserId: `USR-admin-${suffix}`,
        action: 'freeze',
        now: new Date(now.getTime() + 4_000),
        outboxEvent: freezeEvent,
      });
      expect(frozen.transfer.status).toBe('frozen');
      expect(frozen.entitlement).toMatchObject({
        currentHolderUserId: senderUserId,
        credentialVersion: 1,
        pendingTransferId: frozenTransferId,
      });
      const blockedRetry = createTicketTransfer({
        id: `TRF-frozen-retry-${suffix}`,
        entitlementId: frozenEntitlementId,
        eventId: ticket.eventId,
        senderUserId,
        recipientUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        now,
      });
      await expect(repo.createTicketTransfer(blockedRetry, senderUserId)).rejects.toThrow(
        /cannot be transferred now/,
      );
      expect((await outboxCollection.doc(freezeEvent.id).get()).data()).toMatchObject({
        type: 'ticket.transfer.resolved',
        status: 'pending',
        payload: freezeEvent,
      });
      const releaseEvent = domainEvent({
        id: `EVT-transfer-freeze-released-${suffix}`,
        type: 'ticket.transfer.freeze_released',
        aggregateId: frozenEntitlementId,
        organizationId: ticket.organizationId,
        actorId: `USR-admin-${suffix}`,
        payload: {
          transferId: frozenTransferId,
          entitlementId: frozenEntitlementId,
          eventId: ticket.eventId,
          credentialVersion: 1,
        },
        occurredAt: now.getTime() + 5_000,
      });
      const released = await repo.releaseFrozenTicketTransfer({
        transferId: frozenTransferId,
        now: new Date(now.getTime() + 5_000),
        outboxEvent: releaseEvent,
      });
      expect(released.transfer.status).toBe('frozen');
      expect(released.entitlement).toMatchObject({
        currentHolderUserId: senderUserId,
        credentialVersion: 1,
        pendingTransferId: null,
      });
      expect((await outboxCollection.doc(releaseEvent.id).get()).data()).toMatchObject({
        type: 'ticket.transfer.freeze_released',
        status: 'pending',
        payload: releaseEvent,
      });
      const recoveredRetry = createTicketTransfer({
        id: `TRF-frozen-recovered-${suffix}`,
        entitlementId: frozenEntitlementId,
        eventId: ticket.eventId,
        senderUserId,
        recipientUserId,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        now,
      });
      await expect(repo.createTicketTransfer(recoveredRetry, senderUserId)).resolves.toMatchObject({
        id: recoveredRetry.id,
        status: 'pending',
      });
      await expect(
        repo.releaseFrozenTicketTransfer({ transferId: frozenTransferId, now }),
      ).rejects.toThrow(/no longer be released/);
    } finally {
      await Promise.all([
        entitlementCollection.doc(entitlementId).delete(),
        entitlementCollection.doc(rsvpEntitlementId).delete(),
        entitlementCollection.doc(groupEntitlementId).delete(),
        entitlementCollection.doc(custodyEntitlementId).delete(),
        entitlementCollection.doc(emailEntitlementId).delete(),
        entitlementCollection.doc(frozenEntitlementId).delete(),
        transferCollection.doc(firstTransferId).delete(),
        transferCollection.doc(secondTransferId).delete(),
        transferCollection.doc(custodyTransferId).delete(),
        transferCollection.doc(`TRF-email-${suffix}`).delete(),
        transferCollection.doc(frozenTransferId).delete(),
        transferCollection.doc(`TRF-frozen-recovered-${suffix}`).delete(),
        ...createdEvents.map((event) => outboxCollection.doc(event.id).delete()),
        outboxCollection.doc(`EVT-transfer-resolved-${firstTransferId}`).delete(),
        outboxCollection.doc(`EVT-transfer-resolved-${secondTransferId}`).delete(),
        outboxCollection.doc(`EVT-transfer-frozen-${suffix}`).delete(),
        outboxCollection.doc(`EVT-transfer-freeze-released-${suffix}`).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);

  it('expires one stale transfer atomically and clears the entitlement lock', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-expire-${suffix}`;
    const transferId = `TRF-expire-${suffix}`;
    const senderUserId = `USR-sender-${suffix}`;
    const now = new Date('2026-10-28T12:00:00.000Z');
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'General',
      userId: senderUserId,
      currentHolderUserId: senderUserId,
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Sender',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const transfer = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: ticket.eventId,
      senderUserId,
      recipientEmailHash: 'b'.repeat(64),
      expiresAt: '2026-10-28T11:00:00.000Z',
      now: new Date('2026-10-28T10:00:00.000Z'),
    });
    const event = domainEvent({
      id: `EVT-expired-${transferId}`,
      type: 'ticket.transfer.resolved',
      aggregateId: entitlementId,
      organizationId: ticket.organizationId,
      actorId: senderUserId,
      payload: {
        transferId,
        entitlementId,
        eventId: ticket.eventId,
        status: 'expired' as const,
        credentialVersion: 1,
      },
      occurredAt: now.getTime(),
    });
    const entitlements = db.collection('v2_entitlements');
    const transfers = db.collection('v2_ticket_transfers');
    const outbox = db.collection('v2_outbox');

    try {
      await repo.save(ticket);
      await repo.createTicketTransfer(transfer, senderUserId);
      await expect(repo.listExpiredTicketTransfers(now, 10)).resolves.toMatchObject([
        { id: transferId, status: 'pending', expiresAt: transfer.expiresAt },
      ]);
      const outcomes = await Promise.allSettled([
        repo.resolveTicketTransfer({
          transferId,
          actorUserId: senderUserId,
          action: 'expire',
          now,
          outboxEvent: event,
        }),
        repo.resolveTicketTransfer({
          transferId,
          actorUserId: senderUserId,
          action: 'expire',
          now,
          outboxEvent: event,
        }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await repo.getById(entitlementId)).toMatchObject({ pendingTransferId: null });
      expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'expired' });
      expect((await outbox.doc(event.id).get()).exists).toBe(true);
    } finally {
      await Promise.all([
        entitlements.doc(entitlementId).delete(),
        transfers.doc(transferId).delete(),
        outbox.doc(event.id).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);

  it('serializes transfer acceptance against scanner admission', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-transfer-scan-${suffix}`;
    const transferId = `TRF-transfer-scan-${suffix}`;
    const senderUserId = `USR-transfer-scan-${suffix}`;
    const recipientUserId = `USR-recipient-scan-${suffix}`;
    const now = new Date();
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'General',
      userId: senderUserId,
      currentHolderUserId: senderUserId,
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Sender',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const transfer = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: ticket.eventId,
      senderUserId,
      recipientUserId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    const resolvedEvent = domainEvent({
      id: `EVT-accepted-${transferId}`,
      type: 'ticket.transfer.resolved',
      aggregateId: entitlementId,
      organizationId: ticket.organizationId,
      actorId: recipientUserId,
      payload: {
        transferId,
        entitlementId,
        eventId: ticket.eventId,
        status: 'accepted' as const,
        credentialVersion: 2,
      },
      occurredAt: now.getTime(),
    });
    const entitlements = db.collection('v2_entitlements');
    const transfers = db.collection('v2_ticket_transfers');
    const outbox = db.collection('v2_outbox');

    try {
      await repo.save(ticket);
      await repo.createTicketTransfer(transfer, senderUserId);
      const [transferOutcome, admission] = await Promise.all([
        repo
          .resolveTicketTransfer({
            transferId,
            actorUserId: recipientUserId,
            action: 'accept',
            holderName: 'Recipient',
            now,
            outboxEvent: resolvedEvent,
          })
          .then(
            () => true,
            () => false,
          ),
        repo
          .claimAdmission(entitlementId, ticket.eventId, {
            expectedCredentialVersion: 1,
            now,
          })
          .then((claim) => claim.admitted),
      ]);
      expect(Number(transferOutcome) + Number(admission)).toBe(1);
      const current = await repo.getById(entitlementId);
      expect(current).not.toBeNull();
      if (transferOutcome) {
        expect(current).toMatchObject({
          currentHolderUserId: recipientUserId,
          credentialVersion: 2,
          pendingTransferId: null,
          scanCount: 0,
        });
        expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'accepted' });
      } else {
        expect(current).toMatchObject({
          currentHolderUserId: senderUserId,
          credentialVersion: 1,
          pendingTransferId: transferId,
          scanCount: 1,
        });
        expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'pending' });
      }
    } finally {
      await Promise.all([
        entitlements.doc(entitlementId).delete(),
        transfers.doc(transferId).delete(),
        outbox.doc(resolvedEvent.id).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);

  it('serializes transfer acceptance against refund freeze', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-transfer-refund-${suffix}`;
    const transferId = `TRF-transfer-refund-${suffix}`;
    const senderUserId = `USR-transfer-refund-sender-${suffix}`;
    const recipientUserId = `USR-transfer-refund-recipient-${suffix}`;
    const refundRequestId = `RFD-transfer-refund-${suffix}`;
    const now = new Date();
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'General',
      userId: senderUserId,
      currentHolderUserId: senderUserId,
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Sender',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const transfer = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: ticket.eventId,
      senderUserId,
      recipientUserId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    const resolvedEvent = domainEvent({
      id: `EVT-transfer-refund-resolved-${transferId}`,
      type: 'ticket.transfer.resolved',
      aggregateId: entitlementId,
      organizationId: ticket.organizationId,
      actorId: recipientUserId,
      payload: {
        transferId,
        entitlementId,
        eventId: ticket.eventId,
        status: 'accepted' as const,
        credentialVersion: 2,
      },
      occurredAt: now.getTime(),
    });
    const entitlements = db.collection('v2_entitlements');
    const transfers = db.collection('v2_ticket_transfers');
    const outbox = db.collection('v2_outbox');

    try {
      await repo.save(ticket);
      await repo.createTicketTransfer(transfer, senderUserId);
      const pendingEntitlement = await repo.getById(entitlementId);
      if (!pendingEntitlement) throw new Error('expected stored pending entitlement');
      const frozen = freezeEntitlementForRefund(pendingEntitlement, refundRequestId, now);
      const [freezeWon, transferWon] = await Promise.all([
        repo.save(frozen).then(
          () => true,
          () => false,
        ),
        repo
          .resolveTicketTransfer({
            transferId,
            actorUserId: recipientUserId,
            action: 'accept',
            holderName: 'Recipient',
            now,
            outboxEvent: resolvedEvent,
          })
          .then(
            () => true,
            () => false,
          ),
      ]);

      expect(Number(freezeWon) + Number(transferWon)).toBe(1);
      const current = await repo.getById(entitlementId);
      expect(current).not.toBeNull();
      if (freezeWon) {
        expect(current).toMatchObject({
          currentHolderUserId: senderUserId,
          credentialVersion: 1,
          pendingTransferId: transferId,
          refundLock: { refundRequestId },
        });
        expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'pending' });
      } else {
        expect(current).toMatchObject({
          currentHolderUserId: recipientUserId,
          credentialVersion: 2,
          pendingTransferId: null,
          refundLock: null,
        });
        expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'accepted' });
      }
    } finally {
      await Promise.all([
        entitlements.doc(entitlementId).delete(),
        transfers.doc(transferId).delete(),
        outbox.doc(resolvedEvent.id).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);

  it('keeps a ticket admission valid while its pending transfer is cancelled', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repo = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const entitlementId = `ENT-transfer-cancel-scan-${suffix}`;
    const transferId = `TRF-transfer-cancel-scan-${suffix}`;
    const senderUserId = `USR-transfer-cancel-scan-sender-${suffix}`;
    const recipientUserId = `USR-transfer-cancel-scan-recipient-${suffix}`;
    const now = new Date();
    const ticket: Entitlement = {
      id: entitlementId,
      orderId: `ORD-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      tierName: 'General',
      userId: senderUserId,
      currentHolderUserId: senderUserId,
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Sender',
      status: 'valid',
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const transfer = createTicketTransfer({
      id: transferId,
      entitlementId,
      eventId: ticket.eventId,
      senderUserId,
      recipientUserId,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      now,
    });
    const resolvedEvent = domainEvent({
      id: `EVT-transfer-cancelled-${transferId}`,
      type: 'ticket.transfer.resolved',
      aggregateId: entitlementId,
      organizationId: ticket.organizationId,
      actorId: senderUserId,
      payload: {
        transferId,
        entitlementId,
        eventId: ticket.eventId,
        status: 'cancelled' as const,
        credentialVersion: 1,
      },
      occurredAt: now.getTime(),
    });
    const entitlements = db.collection('v2_entitlements');
    const transfers = db.collection('v2_ticket_transfers');
    const outbox = db.collection('v2_outbox');

    try {
      await repo.save(ticket);
      await repo.createTicketTransfer(transfer, senderUserId);
      const [cancelled, admission] = await Promise.all([
        repo.resolveTicketTransfer({
          transferId,
          actorUserId: senderUserId,
          action: 'cancel',
          now,
          outboxEvent: resolvedEvent,
        }),
        repo.claimAdmission(entitlementId, ticket.eventId, {
          expectedCredentialVersion: 1,
          now,
        }),
      ]);

      expect(admission.admitted).toBe(true);
      expect(cancelled.transfer.status).toBe('cancelled');
      expect(await repo.getById(entitlementId)).toMatchObject({
        currentHolderUserId: senderUserId,
        credentialVersion: 1,
        pendingTransferId: null,
        status: 'redeemed',
        scanCount: 1,
      });
      expect(await repo.getTicketTransfer(transferId)).toMatchObject({ status: 'cancelled' });
      expect((await outbox.doc(resolvedEvent.id).get()).exists).toBe(true);
    } finally {
      await Promise.all([
        entitlements.doc(entitlementId).delete(),
        transfers.doc(transferId).delete(),
        outbox.doc(resolvedEvent.id).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);
});
