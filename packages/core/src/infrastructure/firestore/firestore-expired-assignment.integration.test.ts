import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { createPromoterAssignment } from '../../domain/models/event-catalog.js';

import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Promoter assignment expiry query (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('returns only due assignments in supported states', async () => {
    const suffix = randomUUID();
    const dueId = `m4-expiry-due-${suffix}`;
    const futureId = `m4-expiry-future-${suffix}`;
    const collection = db.collection('v2_event_catalog_promoter_assignments');
    const now = new Date();
    const base = {
      eventId: 'event_test',
      promoterId: 'promoter_test',
      terms: { version: 1, ratePercent: 10, flatPaise: 0 },
      status: 'accepted' as const,
      now,
    };
    await collection.doc(dueId).set(
      createPromoterAssignment({
        ...base,
        id: dueId,
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
    );
    await collection.doc(futureId).set(
      createPromoterAssignment({
        ...base,
        id: futureId,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );

    try {
      const due = await new FirestoreEventCatalogRepository(db).listExpiredAssignments(now, 100);
      expect(due.map((assignment) => assignment.id)).toContain(dueId);
      expect(due.map((assignment) => assignment.id)).not.toContain(futureId);
    } finally {
      await Promise.all([collection.doc(dueId).delete(), collection.doc(futureId).delete()]);
    }
  }, 45_000);

  it('round-trips an explicit empty commission-eligible tier set for an RSVP-only assignment', async () => {
    const assignmentId = `m4-rsvp-only-${randomUUID()}`;
    const collection = db.collection('v2_event_catalog_promoter_assignments');
    const repository = new FirestoreEventCatalogRepository(db);
    const assignment = createPromoterAssignment({
      id: assignmentId,
      eventId: `event-${randomUUID()}`,
      promoterId: `promoter-${randomUUID()}`,
      terms: { version: 1, ratePercent: 0, flatPaise: 0 },
      status: 'invited',
      eligibleTierIds: [],
    });

    try {
      await repository.saveAssignment(assignment);
      expect(await repository.getAssignmentById(assignmentId)).toMatchObject({
        id: assignmentId,
        eligibleTierIds: [],
        terms: { ratePercent: 0, flatPaise: 0 },
      });
    } finally {
      await collection.doc(assignmentId).delete();
    }
  }, 45_000);
});
