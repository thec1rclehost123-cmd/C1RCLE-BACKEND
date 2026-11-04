import { describe, expect, it, vi } from 'vitest';

import { WaitlistService } from './waitlist-service.js';

describe('WaitlistService expiry worker', () => {
  it('expires due offers and releases their active cart reservations', async () => {
    const now = new Date('2026-10-28T12:10:00.000Z');
    const candidate = {
      id: 'wait_1',
      offerReservationId: 'hold_1',
      status: 'accepted',
    };
    const repositories = {
      waitlist: {
        listExpiredOffers: vi.fn(async () => [candidate]),
        getById: vi.fn(async () => ({ ...candidate, status: 'expired' })),
        expireOffer: vi.fn(async () => ({ ...candidate, status: 'expired' })),
      },
      cartReservations: {
        getById: vi.fn(async () => ({ id: 'hold_1', status: 'active' })),
        release: vi.fn(async () => undefined),
      },
    };
    const service = new WaitlistService(
      { repositories, config: { clock: { now: () => now } } } as never,
      {} as never,
      {} as never,
    );

    await expect(service.cleanupExpiredOffers(now, 20)).resolves.toBe(1);
    expect(repositories.waitlist.listExpiredOffers).toHaveBeenCalledWith(now, 20);
    expect(repositories.waitlist.expireOffer).toHaveBeenCalledWith({ entryId: 'wait_1', now });
    expect(repositories.cartReservations.release).toHaveBeenCalledWith('hold_1');
  });
});
