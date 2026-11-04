import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { createNotification } from '../../domain/models/social.js';

import { FirestoreSocialNotificationRepository } from './firestore-social-repositories.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('social event-change responses (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('serializes concurrent responses and rejects a different retry action', async () => {
    const id = `m5-event-change-${randomUUID()}`;
    const repo = new FirestoreSocialNotificationRepository(db);
    const notification = createNotification({
      userId: 'm5-event-change-test-user',
      type: 'event.material_change',
      title: 'Event details changed',
      body: 'Review the current event details.',
      link: '/tickets',
      subjectId: `EMC-${id}`,
      eventChange: {
        eventVersion: 2,
        entitlementId: `ENT-${randomUUID()}`,
        canAccept: true,
        canRequestRefund: true,
      },
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    const row = { ...notification, id };

    try {
      await repo.create(row);
      const results = await Promise.all([
        repo.respondToMaterialChange(row.userId, id, 'accepted', '2026-10-28T12:01:00.000Z'),
        repo.respondToMaterialChange(row.userId, id, 'accepted', '2026-10-28T12:02:00.000Z'),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(await repo.getById(id)).toMatchObject({
        eventChangeResponse: { response: 'accepted', respondedBy: row.userId },
      });
      await expect(
        repo.respondToMaterialChange(
          row.userId,
          id,
          'refund_requested',
          '2026-10-28T12:03:00.000Z',
        ),
      ).rejects.toThrow(/different response is already recorded/);
    } finally {
      await db.collection('v2_social_notifications').doc(id).delete();
    }
  }, 45_000);
});
