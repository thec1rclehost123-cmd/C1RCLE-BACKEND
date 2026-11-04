import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { FirestoreWaitlistRepository } from './firestore-waitlist-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M5 waitlist Firestore ordering', () => {
  it('deduplicates concurrent active joins and offers in sequence order with replay safety', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreWaitlistRepository(db);
    const suffix = randomUUID();
    const eventId = `EVT-${suffix}`;
    const tierId = `TIER-${suffix}`;
    const now = new Date();
    const eventEntries = db.collection('v2_waitlist_entries').where('eventId', '==', eventId);
    try {
      const sameUser = await Promise.all([
        repository.join({
          id: `WAIT-${suffix}-1`,
          eventId,
          organizationId: `ORG-${suffix}`,
          tierId,
          userId: `USER-${suffix}-1`,
          now,
        }),
        repository.join({
          id: `WAIT-${suffix}-2`,
          eventId,
          organizationId: `ORG-${suffix}`,
          tierId,
          userId: `USER-${suffix}-1`,
          now,
        }),
      ]);
      expect(sameUser.map((result) => result.entry.id)).toEqual([
        sameUser[0]?.entry.id,
        sameUser[0]?.entry.id,
      ]);
      expect(sameUser.filter((result) => result.created)).toHaveLength(1);
      const second = await repository.join({
        id: `WAIT-${suffix}-3`,
        eventId,
        organizationId: `ORG-${suffix}`,
        tierId,
        userId: `USER-${suffix}-2`,
        now,
      });
      const firstPage = await repository.listByEventTier(eventId, tierId, {
        limit: 1,
        cursor: null,
      });
      const nextPage = await repository.listByEventTier(eventId, tierId, {
        limit: 1,
        cursor: firstPage.nextCursor,
      });
      expect(firstPage.items.map((entry) => entry.sequence)).toEqual([1]);
      expect(firstPage.nextCursor).toBe('1');
      expect(nextPage.items.map((entry) => entry.sequence)).toEqual([2]);
      expect(nextPage.nextCursor).toBeNull();
      const offerInput = {
        eventId,
        tierId,
        actorId: `ADMIN-${suffix}`,
        reservationId: `HOLD-${suffix}-1`,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        now,
      };
      const [offerA, offerB] = await Promise.all([
        repository.offerNext(offerInput),
        repository.offerNext(offerInput),
      ]);
      expect(offerA?.id).toBe(sameUser[0]?.entry.id);
      expect(offerB?.id).toBe(offerA?.id);
      const secondOffer = await repository.offerNext({
        ...offerInput,
        reservationId: `HOLD-${suffix}-2`,
      });
      expect(secondOffer).toMatchObject({ id: second.entry.id, sequence: 2 });
      const accepted = await repository.acceptOffer({
        entryId: second.entry.id,
        userId: second.entry.userId,
        now,
      });
      expect(accepted.status).toBe('accepted');
      await expect(
        repository.listExpiredOffers(new Date(offerInput.expiresAt), 10),
      ).resolves.toMatchObject([
        { id: sameUser[0]?.entry.id, status: 'offered' },
        { id: second.entry.id, status: 'accepted' },
      ]);
      expect(
        await repository.expireOffer({
          entryId: second.entry.id,
          now: new Date(offerInput.expiresAt),
        }),
      ).toMatchObject({ status: 'expired', offerReservationId: `HOLD-${suffix}-2` });
      await expect(
        repository.listExpiredOffers(new Date(offerInput.expiresAt), 10),
      ).resolves.toMatchObject([{ id: sameUser[0]?.entry.id, status: 'offered' }]);
      const outbox = await db
        .collection('v2_outbox')
        .where('aggregateId', 'in', [sameUser[0]?.entry.id, second.entry.id])
        .get();
      expect(outbox.docs.map((document) => document.get('type')).sort()).toEqual([
        'waitlist.accepted',
        'waitlist.expired',
        'waitlist.joined',
        'waitlist.joined',
        'waitlist.offered',
        'waitlist.offered',
      ]);
      expect(
        outbox.docs.some((document) => {
          const payload = document.get('payload') as Record<string, unknown>;
          return 'userId' in payload || 'email' in payload || 'recipientEmail' in payload;
        }),
      ).toBe(false);
    } finally {
      const [entries, keys, counters] = await Promise.all([
        eventEntries.get(),
        db.collection('v2_waitlist_active_keys').where('eventId', '==', eventId).get(),
        db.collection('v2_waitlist_sequences').where('eventId', '==', eventId).get(),
      ]);
      const outbox = entries.empty
        ? null
        : await db
            .collection('v2_outbox')
            .where(
              'aggregateId',
              'in',
              entries.docs.map((document) => document.id),
            )
            .get();
      const batch = db.batch();
      for (const snap of [entries, keys, counters, ...(outbox ? [outbox] : [])])
        snap.docs.forEach((document) => batch.delete(document.ref));
      await batch.commit();
      await db.terminate();
    }
  }, 30_000);
});
