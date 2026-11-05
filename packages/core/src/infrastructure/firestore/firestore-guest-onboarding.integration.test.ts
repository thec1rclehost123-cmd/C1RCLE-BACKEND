import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createGuestProfileService } from '../../application/guest-profile/guest-profile-service.js';

import { FirestoreGuestProfileRepository } from './firestore-guest-profile-repository.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(host)('Guest onboarding persisted resume (local Emulator)', () => {
  it('reloads canonical partial fields and verified phone without a second profile store', async () => {
    if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
      throw new Error('Loopback Emulator required');
    const db = new Firestore({ projectId: 'demo-c1rcle-onboarding', host, ssl: false });
    const userId = `guest-${randomUUID()}`;
    const service = () =>
      createGuestProfileService({
        guestProfiles: new FirestoreGuestProfileRepository(db),
        config: { clock: { now: () => new Date('2026-11-04T00:00:00Z') } } as never,
      });
    try {
      await service().saveOnboarding(userId, { displayName: 'Google Name' });
      await service().saveOnboarding(userId, { dateOfBirth: '2000-02-29' });
      const partial = await service().getOnboarding(userId);
      expect(partial.profile?.displayName).toBe('Google Name');
      expect(partial.profile?.dateOfBirth).toBe('2000-02-29');
      expect(partial.complete).toBe(false);
      await service().verifyPhone(userId, '+919876543210', 'synthetic-proof', {
        name: 'synthetic',
        verify: async () => ({ passed: true, provider: 'firebase-phone' }),
      });
      await service().saveOnboarding(userId, { tastes: ['House', 'Comedy'] });
      const reloaded = await service().getOnboarding(userId);
      expect(reloaded.complete).toBe(true);
      expect(reloaded.profile?.tastes).toEqual(['House', 'Comedy']);
      expect(reloaded.profile?.phoneNumber).toBe('+919876543210');
      expect((await service().getOnboarding(`other-${userId}`)).profile).toBeNull();
    } finally {
      await db.collection('v2_guest_profiles').doc(userId).delete();
      await db.terminate();
    }
  }, 30000);
});
