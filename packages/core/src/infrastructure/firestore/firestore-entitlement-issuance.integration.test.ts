import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { newVersionedEntity } from '../../domain/identity.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M5 atomic ticket issuance outbox', () => {
  it('persists the entitlement and one deterministic issuance event together under retries', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEntitlementRepository(db);
    const suffix = randomUUID();
    const now = new Date();
    const entitlement = {
      ...newVersionedEntity(now),
      id: `ENT-issued-${suffix}`,
      orderId: `ORD-issued-${suffix}`,
      eventId: `EVT-issued-${suffix}`,
      organizationId: `ORG-issued-${suffix}`,
      tierId: `TIER-issued-${suffix}`,
      tierName: 'Issued ticket',
      userId: `USR-issued-${suffix}`,
      currentHolderUserId: `USR-issued-${suffix}`,
      unitKind: 'paid' as const,
      credentialVersion: 1,
      holderName: 'Test Guest',
      status: 'valid' as const,
      scanCountAllowed: 1,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
    };
    const event = domainEvent({
      id: deterministicDomainEventId('ticket.issued', entitlement.id),
      type: 'ticket.issued',
      aggregateId: entitlement.id,
      organizationId: entitlement.organizationId,
      actorId: entitlement.userId,
      occurredAt: now.getTime(),
      payload: {
        entitlementId: entitlement.id,
        orderId: entitlement.orderId,
        eventId: entitlement.eventId,
        purchaserUserId: entitlement.userId,
        holderUserId: entitlement.currentHolderUserId,
      },
    });
    const entitlementRef = db.collection('v2_entitlements').doc(entitlement.id);
    const outboxRef = db.collection('v2_outbox').doc(event.id);
    try {
      await Promise.all([
        repository.save(entitlement, null, event),
        repository.save(entitlement, null, event),
      ]);
      expect((await entitlementRef.get()).data()).toMatchObject({
        id: entitlement.id,
        credentialVersion: 1,
      });
      const outboxSnapshot = await db
        .collection('v2_outbox')
        .where('aggregateId', '==', entitlement.id)
        .get();
      expect(outboxSnapshot.docs).toHaveLength(1);
      expect(outboxSnapshot.docs[0]?.get('type')).toBe('ticket.issued');
      expect(outboxSnapshot.docs[0]?.get('payload')).toMatchObject({
        id: event.id,
        payload: { entitlementId: entitlement.id, holderUserId: entitlement.userId },
      });
    } finally {
      const batch = db.batch();
      batch.delete(entitlementRef);
      batch.delete(outboxRef);
      await batch.commit();
      await db.terminate();
    }
  });
});
