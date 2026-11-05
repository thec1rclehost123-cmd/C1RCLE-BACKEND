import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { domainEvent } from '../../domain/events.js';
import { createEvent, postponeEvent, cancelEvent } from '../../domain/models/event.js';

import { FirestoreEventRepository } from './firestore-event-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore event lifecycle + durable notification boundary', () => {
  it('commits exactly one concurrent lifecycle change with its matching outbox fact', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const now = new Date('2026-11-04T12:00:00.000Z');
    const repository = new FirestoreEventRepository(db);
    const event = {
      ...createEvent({
        id: `event-${suffix}`,
        organizationId: 'host',
        venueId: 'venue',
        title: 'Night',
        startAt: '2026-11-10T20:00:00.000Z',
        now,
      }),
      status: 'published' as const,
      isPublic: true,
    };
    const postponed = postponeEvent(event, 'Rescheduling', 'host', event.organizationId, now);
    const cancelled = cancelEvent(event, 'Cancelled', now);
    const postponeFact = domainEvent({
      id: `postponed-${suffix}`,
      type: 'event.updated',
      aggregateId: event.id,
      organizationId: event.organizationId,
      actorId: 'host-owner',
      payload: { title: event.title },
      occurredAt: now.getTime(),
    });
    const cancelFact = domainEvent({
      id: `cancelled-${suffix}`,
      type: 'event.cancelled',
      aggregateId: event.id,
      organizationId: event.organizationId,
      actorId: 'host-owner',
      payload: { title: event.title, reason: 'Cancelled', eventVersion: cancelled.version },
      occurredAt: now.getTime(),
    });
    try {
      await repository.save(event);
      const outcomes = await Promise.allSettled([
        repository.save(postponed, null, postponeFact),
        repository.save(cancelled, null, cancelFact),
      ]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const stored = await repository.getById(event.id);
      const queued = await Promise.all([
        db.collection('v2_outbox').doc(postponeFact.id).get(),
        db.collection('v2_outbox').doc(cancelFact.id).get(),
      ]);
      expect(stored?.version).toBe(2);
      expect(queued.filter((doc) => doc.exists)).toHaveLength(1);
      expect(queued[stored?.status === 'postponed' ? 0 : 1]?.exists).toBe(true);
      if (stored?.status === 'postponed') expect(stored.postponement?.reason).toBe('Rescheduling');
    } finally {
      await Promise.all([
        db.collection('v2_events').doc(event.id).delete(),
        db.collection('v2_outbox').doc(postponeFact.id).delete(),
        db.collection('v2_outbox').doc(cancelFact.id).delete(),
      ]);
      await db.terminate();
    }
  }, 30_000);
});
