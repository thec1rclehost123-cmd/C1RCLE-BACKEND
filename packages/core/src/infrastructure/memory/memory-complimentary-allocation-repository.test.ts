import { describe, expect, it } from 'vitest';

import { createComplimentaryAllocation } from '../../domain/models/complimentary-allocation.js';

import { MemoryComplimentaryAllocationRepository } from './memory-complimentary-allocation-repository.js';

const now = new Date('2026-10-28T12:00:00.000Z');

function createAllocation(quota = 1) {
  return createComplimentaryAllocation({
    id: 'allocation_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    category: 'press',
    reason: 'Press allocation',
    quota,
    createdBy: 'admin_1',
    now,
  });
}

describe('MemoryComplimentaryAllocationRepository', () => {
  it('enforces quota, recipient uniqueness and idempotent claim replay', async () => {
    const repository = new MemoryComplimentaryAllocationRepository();
    await repository.createAllocation(createAllocation(2));
    const input = {
      allocationId: 'allocation_1',
      claimId: 'claim_1',
      orderId: 'COMP-order_1',
      recipientUserId: 'guest_1',
      holderName: 'Press One',
      issuedBy: 'admin_2',
      now,
    };

    const first = await repository.issueClaim(input);
    const replay = await repository.issueClaim(input);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.allocation.claimedCount).toBe(1);
    await expect(
      repository.issueClaim({ ...input, claimId: 'claim_2', orderId: 'COMP-order_2' }),
    ).rejects.toThrow(/already has a claim/);
    const second = await repository.issueClaim({
      ...input,
      claimId: 'claim_2',
      orderId: 'COMP-order_2',
      recipientUserId: 'guest_2',
      holderName: 'Press Two',
    });
    expect(second.allocation.claimedCount).toBe(2);
    await expect(
      repository.issueClaim({
        ...input,
        claimId: 'claim_3',
        orderId: 'COMP-order_3',
        recipientUserId: 'guest_3',
      }),
    ).rejects.toThrow(/quota is exhausted/);
  });
});
