import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { FirestoreReferralLinkRepository } from './firestore-referral-link-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Promoter click retry idempotency (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  it('counts a click token once, then accepts a new click after its retry window', async () => {
    const id = `m4-click-${randomUUID()}`;
    const ref = db.collection('v2_promoter_links').doc(id);
    const repo = new FirestoreReferralLinkRepository(db);
    await ref.set({ id, isActive: true, clicks: 0 });

    try {
      const now = new Date('2026-10-28T12:00:00.000Z');
      const attempts = await Promise.all([
        repo.recordClick(id, 'm4-click-token', now),
        repo.recordClick(id, 'm4-click-token', now),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect((await ref.get()).get('clicks')).toBe(1);

      expect(await repo.recordClick(id, 'm4-next-click', new Date(now.getTime() + 60_001))).toBe(
        true,
      );
      const stored = await ref.get();
      expect(stored.get('clicks')).toBe(2);
      expect(stored.get('recentClickKeys')).toHaveLength(1);
    } finally {
      await ref.delete();
    }
  }, 45_000);
});
