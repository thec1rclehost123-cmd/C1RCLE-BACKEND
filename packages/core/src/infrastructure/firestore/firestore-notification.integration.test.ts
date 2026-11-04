import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { createNotification } from '../../domain/models/notification.js';

import { FirestoreNotificationRepository } from './firestore-notification-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('partner notification delivery (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('creates once and preserves read state when an event is redelivered', async () => {
    const id = `m4-notification-${randomUUID()}`;
    const repo = new FirestoreNotificationRepository(db);
    const notification = createNotification({
      id,
      recipientId: 'm4-promoter',
      recipientType: 'promoter',
      type: 'promoter.attributed_sale',
      title: 'An attributed booking was fulfilled',
      body: 'Frozen commission: ₹12.50.',
      dedupeKey: `promoter_sale:${id}`,
      now: new Date('2026-10-28T12:00:00.000Z'),
    });

    try {
      expect(await repo.createIfAbsent(notification)).toBe(true);
      await repo.markRead(id, '2026-10-28T12:01:00.000Z');
      expect(await repo.createIfAbsent({ ...notification, body: 'redelivered payload' })).toBe(
        false,
      );
      expect(await repo.getById(id)).toMatchObject({ read: true, body: notification.body });
    } finally {
      await db.collection('v2_notifications').doc(id).delete();
    }
  }, 45_000);
});
