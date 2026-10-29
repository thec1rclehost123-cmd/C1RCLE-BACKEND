import { describe, expect, it } from 'vitest';

import { MemoryWaitlistRepository } from './memory-waitlist-repository.js';

describe('MemoryWaitlistRepository', () => {
  it('deduplicates active users, offers FIFO and replays the same reserved offer', async () => {
    const repository = new MemoryWaitlistRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    const first = await repository.join({
      id: 'wait_1',
      eventId: 'event_1',
      organizationId: 'org_1',
      tierId: 'tier_1',
      userId: 'guest_1',
      now,
    });
    expect(first.created).toBe(true);
    expect(await repository.join({ ...first.entry, id: 'wait_duplicate', now })).toMatchObject({
      created: false,
      entry: { id: 'wait_1' },
    });
    await repository.join({
      id: 'wait_2',
      eventId: 'event_1',
      organizationId: 'org_1',
      tierId: 'tier_1',
      userId: 'guest_2',
      now,
    });
    const offerInput = {
      eventId: 'event_1',
      tierId: 'tier_1',
      reservationId: 'hold_1',
      expiresAt: '2026-10-28T12:10:00.000Z',
      now,
    };
    const offer = await repository.offerNext(offerInput);
    expect(offer).toMatchObject({ id: 'wait_1', sequence: 1, status: 'offered' });
    expect(await repository.offerNext(offerInput)).toEqual(offer);
    expect(await repository.offerNext({ ...offerInput, reservationId: 'hold_2' })).toMatchObject({
      id: 'wait_2',
      sequence: 2,
    });
    await repository.acceptOffer({ entryId: 'wait_2', userId: 'guest_2', now });
    await expect(
      repository.listExpiredOffers(new Date(offerInput.expiresAt), 2),
    ).resolves.toMatchObject([
      { id: 'wait_1', status: 'offered' },
      { id: 'wait_2', status: 'accepted' },
    ]);
  });
});
