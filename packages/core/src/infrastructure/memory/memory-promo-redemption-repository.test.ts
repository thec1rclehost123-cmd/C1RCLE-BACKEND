import { describe, expect, it } from 'vitest';

import { MemoryPromoRedemptionRepository } from './memory-repositories.js';

const claim = (repo: MemoryPromoRedemptionRepository, orderId: string, userId: string) =>
  repo.claim({
    redemption: {
      id: `red_${orderId}`,
      promoId: 'promo_1',
      orderId,
      userId,
      redeemedAt: new Date().toISOString(),
    },
    promoIds: ['promo_1', 'ONCE'],
    historicalRedemptionCount: 0,
    maxRedemptions: 1,
    maxPerUser: 1,
  });

describe('MemoryPromoRedemptionRepository.claim', () => {
  it('atomically admits only one claimant for a global limit', async () => {
    const repo = new MemoryPromoRedemptionRepository();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => claim(repo, `order_${index}`, `user_${index}`)),
    );

    expect(results.filter((result) => result === 'claimed')).toHaveLength(1);
    expect(await repo.countByPromo('promo_1')).toBe(1);
  });

  it('enforces a per-user limit and makes an order retry idempotent', async () => {
    const repo = new MemoryPromoRedemptionRepository();
    expect(await claim(repo, 'order_1', 'user_1')).toBe('claimed');
    expect(await claim(repo, 'order_1', 'user_1')).toBe('already_claimed');

    const second = await repo.claim({
      redemption: {
        id: 'red_order_2',
        promoId: 'promo_1',
        orderId: 'order_2',
        userId: 'user_1',
        redeemedAt: new Date().toISOString(),
      },
      promoIds: ['promo_1'],
      historicalRedemptionCount: 0,
      maxRedemptions: null,
      maxPerUser: 1,
    });
    expect(second).toBe('user_limit');
  });
});
