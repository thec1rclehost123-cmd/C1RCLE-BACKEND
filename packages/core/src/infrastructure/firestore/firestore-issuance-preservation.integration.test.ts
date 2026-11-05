import { randomUUID } from 'node:crypto';

import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { ConflictError } from '../../domain/errors.js';
import { deterministicDomainEventId, domainEvent } from '../../domain/events.js';
import { newVersionedEntity } from '../../domain/identity.js';

import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

function fixture() {
  if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
    throw new Error('Issuance regressions require a loopback Firestore emulator');
  const db = new Firestore({ projectId: `demo-m4-issue-${randomUUID().slice(0, 8)}` });
  const now = new Date();
  const initial: Entitlement = {
    ...newVersionedEntity(now),
    id: `ENT-${randomUUID()}`,
    orderId: `ORD-${randomUUID()}`,
    eventId: `EVT-${randomUUID()}`,
    organizationId: 'ORG-local',
    tierId: 'TIER-local',
    tierName: 'General',
    userId: 'USR-purchaser',
    currentHolderUserId: 'USR-purchaser',
    credentialVersion: 1,
    unitKind: 'paid',
    holderName: 'Purchaser',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    refundLock: null,
  };
  const issued = domainEvent({
    id: deterministicDomainEventId('ticket.issued', initial.id),
    type: 'ticket.issued',
    aggregateId: initial.id,
    organizationId: initial.organizationId,
    actorId: initial.userId ?? 'system:test',
    occurredAt: now.getTime(),
    payload: {
      entitlementId: initial.id,
      orderId: initial.orderId,
      eventId: initial.eventId,
      purchaserUserId: initial.userId,
      holderUserId: initial.currentHolderUserId ?? null,
    },
  });
  return { db, initial, issued, repository: new FirestoreEntitlementRepository(db) };
}

const advanced: { name: string; changes: Partial<Entitlement> }[] = [
  { name: 'unassigned custody', changes: { currentHolderUserId: null, holderName: '' } },
  {
    name: 'accepted transfer',
    changes: {
      currentHolderUserId: 'USR-recipient',
      holderName: 'Recipient',
      credentialVersion: 2,
    },
  },
  {
    name: 'consumed admission',
    changes: { status: 'redeemed', scanCount: 1, scannedAt: ['2026-11-05T12:00:00.000Z'] },
  },
  { name: 'refunded ticket', changes: { status: 'void', credentialVersion: 2 } },
  {
    name: 'refund lock',
    changes: { refundLock: { refundRequestId: 'REF-local', frozenAt: '2026-11-05T12:00:00.000Z' } },
  },
];

describe.runIf(EMULATOR)('M4 delayed issuance preserves authoritative ticket state', () => {
  it.each(advanced)(
    'does not reset $name on simultaneous stale initial issuance retries',
    async ({ changes }) => {
      const f = fixture();
      try {
        await f.repository.save(f.initial, null, f.issued);
        const current = {
          ...f.initial,
          ...changes,
          version: 2,
          updatedAt: new Date().toISOString(),
        };
        await f.repository.save(current);
        const ref = f.db.collection('v2_entitlements').doc(f.initial.id);
        const before = (await ref.get()).data();
        await Promise.all([
          f.repository.save(f.initial, null, f.issued),
          f.repository.save(f.initial, null, f.issued),
        ]);
        expect((await ref.get()).data()).toEqual(before);
        expect(await f.repository.getById(f.initial.id)).toMatchObject(current);
        expect(
          (await f.db.collection('v2_outbox').where('aggregateId', '==', f.initial.id).get()).size,
        ).toBe(1);
      } finally {
        await f.db.recursiveDelete(f.db.collection('v2_entitlements'));
        await f.db.recursiveDelete(f.db.collection('v2_outbox'));
        await f.db.terminate();
      }
    },
  );

  it.each([
    { name: 'order', changes: { orderId: 'ORD-different' } },
    { name: 'event', changes: { eventId: 'EVT-different' } },
    { name: 'organization', changes: { organizationId: 'ORG-different' } },
    { name: 'tier', changes: { tierId: 'TIER-different' } },
    { name: 'purchaser', changes: { userId: 'USR-different' } },
    { name: 'unit kind', changes: { unitKind: 'free_rsvp' as const } },
    { name: 'admission capacity', changes: { scanCountAllowed: 2 } },
  ])(
    'rejects a reused entitlement id with different $name without appending its event',
    async ({ changes }) => {
      const f = fixture();
      try {
        await f.repository.save(f.initial, null, f.issued);
        const conflicting = { ...f.initial, ...changes };
        const event = {
          ...f.issued,
          id: `${f.issued.id}-different`,
          organizationId: conflicting.organizationId,
          payload: {
            ...f.issued.payload,
            orderId: conflicting.orderId,
            eventId: conflicting.eventId,
            purchaserUserId: conflicting.userId,
          },
        };
        await expect(f.repository.save(conflicting, null, event)).rejects.toBeInstanceOf(
          ConflictError,
        );
        expect(await f.repository.getById(f.initial.id)).toMatchObject(f.initial);
        expect((await f.db.collection('v2_outbox').doc(event.id).get()).exists).toBe(false);
      } finally {
        await f.db.recursiveDelete(f.db.collection('v2_entitlements'));
        await f.db.recursiveDelete(f.db.collection('v2_outbox'));
        await f.db.terminate();
      }
    },
  );

  it('repairs a missing issuance intent without resetting an already advanced legacy ticket', async () => {
    const f = fixture();
    try {
      await f.repository.save(f.initial);
      const current = {
        ...f.initial,
        version: 2,
        currentHolderUserId: 'USR-recipient',
        credentialVersion: 2,
      };
      await f.repository.save(current);
      await f.repository.save(f.initial, null, f.issued);
      expect(await f.repository.getById(f.initial.id)).toMatchObject(current);
      expect((await f.db.collection('v2_outbox').doc(f.issued.id).get()).exists).toBe(true);
    } finally {
      await f.db.recursiveDelete(f.db.collection('v2_entitlements'));
      await f.db.recursiveDelete(f.db.collection('v2_outbox'));
      await f.db.terminate();
    }
  });

  it.each(['stored', 'incoming'] as const)(
    'preserves advanced legacy paid tickets with missing %s unit kind and repairs issuance intent',
    async (legacySide) => {
      const f = fixture();
      try {
        await f.repository.save(f.initial);
        const current = {
          ...f.initial,
          version: 2,
          currentHolderUserId: 'USR-recipient',
          credentialVersion: 2,
          status: 'redeemed' as const,
          scanCount: 1,
          scannedAt: [f.initial.updatedAt],
        };
        await f.repository.save(current);
        const ref = f.db.collection('v2_entitlements').doc(f.initial.id);
        if (legacySide === 'stored') await ref.update({ unitKind: FieldValue.delete() });
        const before = (await ref.get()).data();
        const retry = { ...f.initial };
        if (legacySide === 'incoming') delete retry.unitKind;
        await f.repository.save(retry, null, f.issued);
        expect((await ref.get()).data()).toEqual(before);
        expect((await f.db.collection('v2_outbox').doc(f.issued.id).get()).exists).toBe(true);
      } finally {
        await f.db.recursiveDelete(f.db.collection('v2_entitlements'));
        await f.db.recursiveDelete(f.db.collection('v2_outbox'));
        await f.db.terminate();
      }
    },
  );

  it('rejects issuance metadata linked to another event before creating any ticket', async () => {
    const f = fixture();
    try {
      const event = { ...f.issued, payload: { ...f.issued.payload, eventId: 'EVT-different' } };
      await expect(f.repository.save(f.initial, null, event)).rejects.toBeInstanceOf(ConflictError);
      expect(await f.repository.getById(f.initial.id)).toBeNull();
      expect((await f.db.collection('v2_outbox').doc(event.id).get()).exists).toBe(false);
    } finally {
      await f.db.recursiveDelete(f.db.collection('v2_entitlements'));
      await f.db.recursiveDelete(f.db.collection('v2_outbox'));
      await f.db.terminate();
    }
  });
});
