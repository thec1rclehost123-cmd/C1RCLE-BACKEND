import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';

import { FirestoreOutboxStore } from './firestore-outbox-store.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('scoped outbox dispatch (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('claims only the newly appended event while leaving unrelated backlog pending', async () => {
    const suffix = randomUUID();
    const oldEvent = domainEvent({
      type: 'event.published',
      id: `m4-outbox-old-${suffix}`,
      aggregateId: `m4-event-old-${suffix}`,
      organizationId: `m4-org-old-${suffix}`,
      actorId: `m4-user-old-${suffix}`,
      payload: { title: 'Old pending event' },
      occurredAt: Date.now() - 1_000,
    });
    const newEvent = domainEvent({
      type: 'event.published',
      id: `m4-outbox-new-${suffix}`,
      aggregateId: `m4-event-new-${suffix}`,
      organizationId: `m4-org-new-${suffix}`,
      actorId: `m4-user-new-${suffix}`,
      payload: { title: 'New event' },
      occurredAt: Date.now(),
    });
    const store = new FirestoreOutboxStore(db);

    try {
      await store.append(oldEvent);
      await store.append(newEvent);

      const claimed = await store.claimPending({
        workerId: 'm4-scoped-test-worker',
        now: Date.now(),
        leaseMs: 5_000,
        eventId: newEvent.id,
      });

      expect(claimed.map((record) => record.id)).toEqual([newEvent.id]);
      expect((await db.collection('v2_outbox').doc(oldEvent.id).get()).get('status')).toBe(
        'pending',
      );
      expect((await db.collection('v2_outbox').doc(newEvent.id).get()).get('status')).toBe(
        'processing',
      );
    } finally {
      await Promise.all([
        db.collection('v2_outbox').doc(oldEvent.id).delete(),
        db.collection('v2_outbox').doc(newEvent.id).delete(),
      ]);
    }
  }, 45_000);
});
