import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { FirestorePromoRedemptionRepository } from './firestore-promo-redemption-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('atomic promo redemption (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  const runClaims = async (
    users: string[],
    maxRedemptions: number | null,
    maxPerUser: number | null,
  ) => {
    const run = randomUUID().slice(0, 8);
    const promoId = `promo_${run}`;
    const repo = new FirestorePromoRedemptionRepository(db);
    const results = await Promise.all(
      users.map((userId, index) =>
        repo.claim({
          redemption: {
            id: `red_${run}_${index}`,
            promoId,
            orderId: `order_${run}_${index}`,
            userId,
            redeemedAt: new Date().toISOString(),
          },
          promoIds: [promoId, `CODE_${run}`],
          historicalRedemptionCount: 0,
          maxRedemptions,
          maxPerUser,
        }),
      ),
    );
    return { repo, promoId, results };
  };

  it('serializes concurrent buyers at the global limit', async () => {
    const { repo, promoId, results } = await runClaims(
      Array.from({ length: 12 }, (_, index) => `user_${index}`),
      1,
      null,
    );
    expect(results.filter((result) => result === 'claimed')).toHaveLength(1);
    expect(await repo.countByPromo(promoId)).toBe(1);
  }, 120_000);

  it('serializes concurrent orders at the per-user limit', async () => {
    const { results } = await runClaims(['same_user', 'same_user'], null, 1);
    expect(results.sort()).toEqual(['claimed', 'user_limit']);
  }, 120_000);

  it('treats a duplicate order retry as one redemption', async () => {
    const run = randomUUID().slice(0, 8);
    const repo = new FirestorePromoRedemptionRepository(db);
    const input = {
      redemption: {
        id: `red_${run}`,
        promoId: `promo_${run}`,
        orderId: `order_${run}`,
        userId: 'user_1',
        redeemedAt: new Date().toISOString(),
      },
      promoIds: [`promo_${run}`],
      historicalRedemptionCount: 0,
      maxRedemptions: 1,
      maxPerUser: 1,
    };
    const results = await Promise.all([repo.claim(input), repo.claim(input), repo.claim(input)]);
    expect(results.filter((result) => result === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result === 'already_claimed')).toHaveLength(2);
  }, 120_000);
});
