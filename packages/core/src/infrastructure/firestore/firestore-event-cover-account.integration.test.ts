import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { newVersionedEntity } from '../../domain/identity.js';
import { createEventCoverAccount } from '../../domain/models/event-cover.js';
import { createTicketTransfer } from '../../domain/models/ticket-transfer.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';
import { FirestoreEventCoverAccountRepository } from './firestore-event-cover-account-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M5 event cover account Firestore transactions', () => {
  it('lists event accounts with bounded pagination for Admin reconciliation', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const eventId = `EVT-cover-list-${suffix}`;
    const accounts = [1, 2].map((index) =>
      createEventCoverAccount({
        entitlementId: `ENT-cover-list-${index}-${suffix}`,
        orderId: `ORD-cover-list-${index}-${suffix}`,
        eventId,
        guestUserId: `USR-cover-list-${index}-${suffix}`,
        hostOrganizationId: `ORG-host-${suffix}`,
        venueOrganizationId: `ORG-venue-${suffix}`,
        amountPaise: 25_000,
        providerCaptureConfirmed: true,
        merchantApproved: true,
        policyVersion: 'fixture-cover-v1',
        refundPolicy: 'saved_policy_review',
        activationApproved: true,
      }),
    );
    try {
      await Promise.all(accounts.map((account) => repository.createIssuedAccount(account)));
      const first = await repository.listByEvent(eventId, { limit: 1, cursor: null });
      expect(first.total).toBe(2);
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await repository.listByEvent(eventId, {
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.total).toBe(2);
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    } finally {
      await Promise.all(accounts.map((account) => deleteCoverRecords(db, account.id)));
      await db.terminate();
    }
  });

  it('creates an immutable issuance and allows only one concurrent spend of the balance', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-${suffix}`,
      orderId: `ORD-cover-${suffix}`,
      eventId: `EVT-cover-${suffix}`,
      guestUserId: `USR-cover-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 150_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const operationA = `POS-a-${suffix}`;
    const operationB = `POS-b-${suffix}`;
    const now = new Date();
    const makeRequest = (operationId: string, receiptReference: string) => ({
      amountPaise: 100_000,
      operationId,
      guestConfirmed: true,
      online: true,
      actorUserId: `USR-operator-${suffix}`,
      terminalId: `TERM-${suffix}`,
      receiptReference,
      now,
    });
    try {
      await repository.createIssuedAccount(account);
      await repository.createIssuedAccount(account);
      const outcomes = await Promise.allSettled([
        repository.reserve(account.id, makeRequest(operationA, `RECEIPT-a-${suffix}`)),
        repository.reserve(account.id, makeRequest(operationB, `RECEIPT-b-${suffix}`)),
      ]);
      const reservations = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      expect(reservations).toHaveLength(1);
      const winner = reservations[0];
      if (!winner || winner.status !== 'fulfilled') throw new Error('Expected one reservation');
      const operationId = winner.value.entry.operationId;
      const captured = await repository.capture(account.id, operationId, now);
      const replayed = await repository.capture(account.id, operationId, now);
      expect(captured).toMatchObject({
        replayed: false,
        account: { remainingPaise: 50_000, reservedPaise: 0, redeemedPaise: 100_000 },
        entry: { type: 'capture', amountPaise: 100_000 },
      });
      expect(replayed).toMatchObject({ replayed: true, entry: { id: captured.entry.id } });
      expect(await repository.listEntries(account.id)).toHaveLength(3);
      expect(await repository.getByEntitlement(account.entitlementId)).toMatchObject({
        remainingPaise: 50_000,
        redeemedPaise: 100_000,
      });
      expect(await outboxTypes(db, account.id)).toEqual([
        'event-cover.issued',
        'event-cover.redeemed',
        'event-cover.reserved',
      ]);
    } finally {
      await deleteCoverRecords(db, account.id);
      await db.terminate();
    }
  });

  it('serializes concurrent retries of one Admin redemption reversal', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-reverse-cover-${suffix}`,
      orderId: `ORD-reverse-cover-${suffix}`,
      eventId: `EVT-reverse-cover-${suffix}`,
      guestUserId: `USR-reverse-cover-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'saved_policy_review',
      activationApproved: true,
    });
    const operationId = `POS-reverse-${suffix}`;
    const now = new Date();
    try {
      await repository.createIssuedAccount(account);
      await repository.reserve(account.id, {
        amountPaise: 12_000,
        operationId,
        guestConfirmed: true,
        online: true,
        actorUserId: `USR-operator-${suffix}`,
        terminalId: `TERM-${suffix}`,
        receiptReference: `RECEIPT-${suffix}`,
        now,
      });
      await repository.capture(account.id, operationId, now);
      const outcomes = await Promise.all([
        repository.reverseCapture(
          account.entitlementId,
          operationId,
          `ADM-${suffix}`,
          'Concurrent duplicate capture reviewed',
          now,
        ),
        repository.reverseCapture(
          account.entitlementId,
          operationId,
          `ADM-${suffix}`,
          'Concurrent duplicate capture reviewed',
          now,
        ),
      ]);

      expect(outcomes.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(await repository.getByEntitlement(account.entitlementId)).toMatchObject({
        remainingPaise: 50_000,
        redeemedPaise: 0,
      });
      const entries = await repository.listEntries(account.id);
      expect(entries.filter((entry) => entry.type === 'reversal')).toMatchObject([
        { reason: 'Concurrent duplicate capture reviewed' },
      ]);
      expect(await outboxTypes(db, account.id)).toEqual([
        'event-cover.issued',
        'event-cover.redeemed',
        'event-cover.reserved',
        'event-cover.reversed',
      ]);
    } finally {
      await deleteCoverRecords(db, account.id);
      await db.terminate();
    }
  });

  it('consumes a confirmed guest challenge once under concurrent Venue retries', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-confirmed-cover-${suffix}`,
      orderId: `ORD-confirmed-cover-${suffix}`,
      eventId: `EVT-confirmed-cover-${suffix}`,
      guestUserId: `USR-confirmed-cover-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const now = new Date();
    const challenge = {
      ...newVersionedEntity(now),
      id: `COV-CHALLENGE-${suffix}`,
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: account.guestUserId!,
      initiatedByUserId: `USR-operator-${suffix}`,
      terminalId: `TERM-${suffix}`,
      amountPaise: 30_000,
      grossSpendPaise: 35_000,
      categories: ['food'],
      containsAlcohol: false,
      receiptReference: `POS-receipt-${suffix}`,
      status: 'pending' as const,
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    try {
      await repository.createIssuedAccount(account);
      await db.collection('v2_entitlements').doc(challenge.entitlementId).set({
        userId: challenge.guestUserId,
        currentHolderUserId: challenge.guestUserId,
        status: 'valid',
        pendingTransferId: null,
      });
      await repository.createRedemptionChallenge(challenge);
      await repository.confirmRedemptionChallenge(challenge.id, challenge.guestUserId, now);
      const results = await Promise.all([
        repository.consumeConfirmedRedemption(challenge.id, challenge.initiatedByUserId, now),
        repository.consumeConfirmedRedemption(challenge.id, challenge.initiatedByUserId, now),
      ]);
      expect(results.map((result) => result.account.remainingPaise)).toEqual([20_000, 20_000]);
      expect(await repository.listEntries(account.id)).toHaveLength(3);
      expect(await repository.getRedemptionChallenge(challenge.id)).toMatchObject({
        status: 'consumed',
      });
      expect(await outboxTypes(db, account.id)).toEqual([
        'event-cover.issued',
        'event-cover.redeemed',
        'event-cover.reserved',
      ]);
    } finally {
      const batch = db.batch();
      batch.delete(db.collection('v2_event_cover_redemption_challenges').doc(challenge.id));
      batch.delete(db.collection('v2_entitlements').doc(challenge.entitlementId));
      await deleteCoverRecords(db, account.id, batch);
      await db.terminate();
    }
  });

  it('voids the exact preauthorization once when an unconfirmed challenge expires', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-expiry-${suffix}`,
      orderId: `ORD-cover-expiry-${suffix}`,
      eventId: `EVT-cover-expiry-${suffix}`,
      guestUserId: `USR-cover-expiry-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const now = new Date();
    const challenge = {
      ...newVersionedEntity(now),
      id: `COV-CHALLENGE-EXPIRE-${suffix}`,
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: account.guestUserId!,
      initiatedByUserId: `USR-operator-${suffix}`,
      terminalId: `TERM-${suffix}`,
      amountPaise: 20_000,
      grossSpendPaise: 25_000,
      categories: ['food'],
      containsAlcohol: false,
      receiptReference: `POS-expired-${suffix}`,
      status: 'pending' as const,
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    try {
      await repository.createIssuedAccount(account);
      await db.collection('v2_entitlements').doc(challenge.entitlementId).set({
        userId: challenge.guestUserId,
        currentHolderUserId: challenge.guestUserId,
        status: 'valid',
        pendingTransferId: null,
      });
      await repository.createRedemptionChallenge(challenge);
      await expect(repository.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
        remainingPaise: 50_000,
        reservedPaise: 20_000,
      });
      const sweepTime = new Date(now.getTime() + 3 * 60_000);
      await expect(repository.cleanupExpiredRedemptionChallenges(sweepTime, 100)).resolves.toBe(1);
      await expect(repository.cleanupExpiredRedemptionChallenges(sweepTime, 100)).resolves.toBe(0);
      const expired = await repository.getRedemptionChallenge(challenge.id);
      expect(expired).toMatchObject({ status: 'expired' });
      await expect(repository.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
        remainingPaise: 50_000,
        reservedPaise: 0,
      });
      expect((await repository.listEntries(account.id)).map((entry) => entry.type).sort()).toEqual([
        'issuance',
        'reserve',
        'void',
      ]);
      expect(await outboxTypes(db, account.id)).toEqual([
        'event-cover.issued',
        'event-cover.reserved',
        'event-cover.voided',
      ]);
    } finally {
      const batch = db.batch();
      batch.delete(db.collection('v2_event_cover_redemption_challenges').doc(challenge.id));
      batch.delete(db.collection('v2_entitlements').doc(challenge.entitlementId));
      await deleteCoverRecords(db, account.id, batch);
      await db.terminate();
    }
  });

  it('serializes refund freezing against a concurrent Venue redemption reserve', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-refund-${suffix}`,
      orderId: `ORD-cover-refund-${suffix}`,
      eventId: `EVT-cover-refund-${suffix}`,
      guestUserId: `USR-cover-refund-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 75_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const now = new Date();
    try {
      await repository.createIssuedAccount(account);
      const results = await Promise.allSettled([
        repository.freezeForRefund([account.entitlementId], `REFUND-${suffix}`, now),
        repository.reserve(account.id, {
          amountPaise: 30_000,
          operationId: `POS-after-refund-${suffix}`,
          guestConfirmed: true,
          online: true,
          actorUserId: `USR-operator-${suffix}`,
          terminalId: `TERM-${suffix}`,
          receiptReference: `RECEIPT-${suffix}`,
          now,
        }),
      ]);
      const freezeSucceeded = results[0]?.status === 'fulfilled';
      const reserveSucceeded = results[1]?.status === 'fulfilled';
      expect(Number(freezeSucceeded) + Number(reserveSucceeded)).toBe(1);
      if (freezeSucceeded) {
        await repository.refundUnused(account.id, {
          operationId: `REFUND-${suffix}`,
          refundRequestId: `REFUND-${suffix}`,
          actorUserId: `USR-finance-${suffix}`,
          now,
        });
      }
      expect(await repository.getByEntitlement(account.entitlementId)).toMatchObject(
        freezeSucceeded
          ? {
              status: 'refunded',
              remainingPaise: 0,
              reservedPaise: 0,
              redeemedPaise: 0,
              refundedPaise: 75_000,
            }
          : { status: 'active', remainingPaise: 75_000, reservedPaise: 30_000, refundedPaise: 0 },
      );
      expect(await repository.listEntries(account.id)).toHaveLength(2);
      expect(await outboxTypes(db, account.id)).toEqual(
        freezeSucceeded
          ? ['event-cover.issued', 'event-cover.refunded']
          : ['event-cover.issued', 'event-cover.reserved'],
      );
    } finally {
      await deleteCoverRecords(db, account.id);
      await db.terminate();
    }
  });

  it('preauthorization prevents a refund freeze while Guest confirmation is pending', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverAccountRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-consume-refund-${suffix}`,
      orderId: `ORD-cover-consume-refund-${suffix}`,
      eventId: `EVT-cover-consume-refund-${suffix}`,
      guestUserId: `USR-cover-consume-refund-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 75_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const now = new Date();
    const challenge = {
      ...newVersionedEntity(now),
      id: `COV-CHALLENGE-CONSUME-REFUND-${suffix}`,
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: account.guestUserId!,
      initiatedByUserId: `USR-operator-${suffix}`,
      terminalId: `TERM-${suffix}`,
      amountPaise: 30_000,
      grossSpendPaise: 30_000,
      categories: ['food'],
      containsAlcohol: false,
      receiptReference: `POS-consume-refund-${suffix}`,
      status: 'pending' as const,
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    const refundRequestId = `REFUND-CONSUME-${suffix}`;
    try {
      await repository.createIssuedAccount(account);
      await db.collection('v2_entitlements').doc(challenge.entitlementId).set({
        userId: challenge.guestUserId,
        currentHolderUserId: challenge.guestUserId,
        status: 'valid',
        pendingTransferId: null,
      });
      await repository.createRedemptionChallenge(challenge);
      await repository.confirmRedemptionChallenge(challenge.id, challenge.guestUserId, now);
      const outcomes = await Promise.allSettled([
        repository.freezeForRefund([account.entitlementId], refundRequestId, now),
        repository.consumeConfirmedRedemption(challenge.id, challenge.initiatedByUserId, now),
      ]);
      const refundFreezeSucceeded = outcomes[0]?.status === 'fulfilled';
      const consumeSucceeded = outcomes[1]?.status === 'fulfilled';
      expect(refundFreezeSucceeded).toBe(false);
      expect(consumeSucceeded).toBe(true);
      expect(await repository.getByEntitlement(account.entitlementId)).toMatchObject({
        status: 'active',
        remainingPaise: 45_000,
        reservedPaise: 0,
        redeemedPaise: 30_000,
        refundedPaise: 0,
      });
      expect(await repository.getRedemptionChallenge(challenge.id)).toMatchObject({
        status: 'consumed',
      });
      expect(await outboxTypes(db, account.id)).toEqual([
        'event-cover.issued',
        'event-cover.redeemed',
        'event-cover.reserved',
      ]);
    } finally {
      const batch = db.batch();
      batch.delete(db.collection('v2_event_cover_redemption_challenges').doc(challenge.id));
      batch.delete(db.collection('v2_entitlements').doc(challenge.entitlementId));
      await deleteCoverRecords(db, account.id, batch);
      await db.terminate();
    }
  });

  it('serializes ticket transfer against event-cover preauthorization', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const covers = new FirestoreEventCoverAccountRepository(db);
    const entitlements = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-transfer-${suffix}`,
      orderId: `ORD-cover-transfer-${suffix}`,
      eventId: `EVT-cover-transfer-${suffix}`,
      guestUserId: `USR-cover-transfer-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const now = new Date();
    const challenge = {
      ...newVersionedEntity(now),
      id: `COV-CHALLENGE-TRANSFER-${suffix}`,
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: account.guestUserId!,
      initiatedByUserId: `USR-operator-${suffix}`,
      terminalId: `TERM-${suffix}`,
      amountPaise: 10_000,
      grossSpendPaise: 12_000,
      categories: ['food'],
      containsAlcohol: false,
      receiptReference: `POS-transfer-${suffix}`,
      status: 'pending' as const,
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    const transfer = createTicketTransfer({
      id: `TRF-cover-${suffix}`,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      senderUserId: challenge.guestUserId,
      recipientEmailHash: 'a'.repeat(64),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      now,
    });
    try {
      const entitlement = {
        id: account.entitlementId,
        orderId: account.orderId,
        eventId: account.eventId,
        organizationId: account.hostOrganizationId,
        tierId: `TIER-${suffix}`,
        tierName: 'General',
        userId: challenge.guestUserId,
        currentHolderUserId: challenge.guestUserId,
        credentialVersion: 1,
        pendingTransferId: null,
        holderName: 'Guest',
        status: 'valid',
        scanCountAllowed: 1,
        scanCount: 0,
        scannedAt: [],
        refundLock: null,
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await db.collection('v2_entitlements').doc(account.entitlementId).set(entitlement);
      await covers.createIssuedAccount(account);
      const outcomes = await Promise.allSettled([
        covers.createRedemptionChallenge(challenge),
        entitlements.createTicketTransfer(transfer, challenge.guestUserId),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const persistedEntitlement = await db
        .collection('v2_entitlements')
        .doc(account.entitlementId)
        .get();
      const persistedAccount = await covers.getByEntitlement(account.entitlementId);
      const transferWon = persistedEntitlement.get('pendingTransferId') === transfer.id;
      expect(persistedAccount?.reservedPaise).toBe(transferWon ? 0 : challenge.amountPaise);
      const persistedChallenge = await covers.getRedemptionChallenge(challenge.id);
      expect(Boolean(persistedChallenge)).toBe(!transferWon);
    } finally {
      const batch = db.batch();
      batch.delete(db.collection('v2_event_cover_redemption_challenges').doc(challenge.id));
      batch.delete(db.collection('v2_ticket_transfers').doc(transfer.id));
      batch.delete(db.collection('v2_entitlements').doc(account.entitlementId));
      await deleteCoverRecords(db, account.id, batch);
      await db.terminate();
    }
  });

  it('moves the linked cover balance to the new holder in the ticket acceptance transaction', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const covers = new FirestoreEventCoverAccountRepository(db);
    const entitlements = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const account = createEventCoverAccount({
      entitlementId: `ENT-cover-owner-${suffix}`,
      orderId: `ORD-cover-owner-${suffix}`,
      eventId: `EVT-cover-owner-${suffix}`,
      guestUserId: `USR-cover-owner-old-${suffix}`,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      amountPaise: 50_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
    });
    const oldHolder = account.guestUserId!;
    const nextHolder = `USR-cover-owner-new-${suffix}`;
    const transfer = createTicketTransfer({
      id: `TRF-cover-owner-${suffix}`,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      senderUserId: oldHolder,
      recipientUserId: nextHolder,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    try {
      await db
        .collection('v2_entitlements')
        .doc(account.entitlementId)
        .set({
          id: account.entitlementId,
          orderId: account.orderId,
          eventId: account.eventId,
          organizationId: account.hostOrganizationId,
          tierId: `TIER-${suffix}`,
          tierName: 'General',
          userId: oldHolder,
          currentHolderUserId: oldHolder,
          credentialVersion: 1,
          pendingTransferId: null,
          holderName: 'Old holder',
          status: 'valid',
          scanCountAllowed: 1,
          scanCount: 0,
          scannedAt: [],
          refundLock: null,
          version: 1,
          createdAt: transfer.createdAt,
          updatedAt: transfer.createdAt,
        });
      await covers.createIssuedAccount(account);
      await entitlements.createTicketTransfer(transfer, oldHolder);
      await entitlements.resolveTicketTransfer({
        transferId: transfer.id,
        actorUserId: nextHolder,
        action: 'accept',
        holderName: 'New holder',
        now: new Date(),
      });

      await expect(covers.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
        guestUserId: nextHolder,
        remainingPaise: account.remainingPaise,
        redeemedPaise: account.redeemedPaise,
      });
    } finally {
      const batch = db.batch();
      batch.delete(db.collection('v2_entitlements').doc(account.entitlementId));
      batch.delete(db.collection('v2_ticket_transfers').doc(transfer.id));
      await deleteCoverRecords(db, account.id, batch);
      await db.terminate();
    }
  });
});

async function outboxTypes(db: Firestore, aggregateId: string) {
  const snapshot = await db.collection('v2_outbox').where('aggregateId', '==', aggregateId).get();
  return snapshot.docs.map((document) => document.get('type') as string).sort();
}

async function deleteCoverRecords(db: Firestore, accountId: string, existingBatch = db.batch()) {
  const [entries, outbox] = await Promise.all([
    db.collection('v2_event_cover_entries').where('accountId', '==', accountId).get(),
    db.collection('v2_outbox').where('aggregateId', '==', accountId).get(),
  ]);
  entries.docs.forEach((document) => existingBatch.delete(document.ref));
  outbox.docs.forEach((document) => existingBatch.delete(document.ref));
  existingBatch.delete(db.collection('v2_event_cover_accounts').doc(accountId));
  await existingBatch.commit();
}
