import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FirestoreEmailDeliveryRepository } from './firestore-email-delivery-repository.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(emulator)('transactional email delivery durability (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator))
      throw new Error('Email delivery integration tests require a loopback Firestore emulator');
    db = new Firestore({
      projectId: `demo-email-${randomUUID().slice(0, 8)}`,
      host: emulator,
      ssl: false,
    });
  });

  afterAll(async () => {
    if (db) {
      await db.recursiveDelete(db.collection('v2_email_deliveries'));
      await db.terminate();
    }
  });

  it('retains the intent across interrupted delivery and permits recovery after its lease', async () => {
    const id = `MAIL-${randomUUID()}`;
    const repository = new FirestoreEmailDeliveryRepository(db);
    const now = Date.now();
    const intent = {
      id,
      aggregateId: `ORD-${randomUUID()}`,
      kind: 'booking_receipt',
      status: 'queued' as const,
      recipientHash: 'sha256-only',
      retryCount: 0,
      providerMessageId: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      lastError: null,
      leaseExpiresAt: null,
    };

    await repository.createIfAbsent(intent);
    expect(await repository.claim(id, now, now + 60_000)).toBe(true);
    expect(await repository.claim(id, now + 1, now + 60_001)).toBe(false);
    expect(await repository.get(id)).toMatchObject({ status: 'sending', retryCount: 1 });

    // Models a process stopping after claim but before provider completion.
    expect(await repository.claim(id, now + 60_001, now + 120_001)).toBe(true);
    expect(await repository.get(id)).toMatchObject({ status: 'sending', retryCount: 2 });

    await repository.markSent(id, 'provider_request_id', now + 60_002);
    expect(await repository.claim(id, now + 120_002, now + 180_002)).toBe(false);
    expect(await repository.get(id)).toMatchObject({
      status: 'sent',
      retryCount: 2,
      providerMessageId: 'provider_request_id',
    });
  });
});
