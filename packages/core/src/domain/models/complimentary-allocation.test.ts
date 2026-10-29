import { describe, expect, it } from 'vitest';

import {
  claimComplimentaryAllocation,
  createComplimentaryAllocation,
  revokeComplimentaryClaim,
} from './complimentary-allocation.js';

const now = new Date('2026-10-28T12:00:00.000Z');

function allocation(quota = 1) {
  return createComplimentaryAllocation({
    id: 'comp_alloc_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    category: 'artist',
    reason: 'Performing artist allocation',
    quota,
    createdBy: 'admin_1',
    expiresAt: '2026-11-28T12:00:00.000Z',
    now,
  });
}

describe('complimentary allocations', () => {
  it('requires an auditable reason and a positive explicit quota', () => {
    expect(() => allocation(0)).toThrow(/positive integer/);
    expect(() =>
      createComplimentaryAllocation({
        id: 'comp_alloc_1',
        eventId: 'event_1',
        organizationId: 'org_1',
        tierId: 'tier_1',
        category: 'staff',
        reason: '  ',
        quota: 1,
        createdBy: 'admin_1',
        now,
      }),
    ).toThrow(/requires a reason/);
  });

  it('issues named claims up to quota and refuses another claim', () => {
    const first = claimComplimentaryAllocation({
      allocation: allocation(),
      claimId: 'comp_claim_1',
      orderId: 'COMP-order_1',
      recipientUserId: 'verified_user_1',
      holderName: 'Artist One',
      issuedBy: 'admin_2',
      now,
    });
    expect(first.allocation.claimedCount).toBe(1);
    expect(first.claim).toMatchObject({
      recipientUserId: 'verified_user_1',
      holderName: 'Artist One',
      issuedBy: 'admin_2',
      status: 'issued',
    });
    expect(() =>
      claimComplimentaryAllocation({
        allocation: first.allocation,
        claimId: 'comp_claim_2',
        orderId: 'COMP-order_2',
        recipientUserId: 'verified_user_2',
        holderName: 'Artist Two',
        issuedBy: 'admin_2',
        now,
      }),
    ).toThrow(/quota is exhausted/);
  });

  it('requires an unused ticket and reason to revoke; revocation does not restore quota', () => {
    const issued = claimComplimentaryAllocation({
      allocation: allocation(2),
      claimId: 'comp_claim_1',
      orderId: 'COMP-order_1',
      recipientUserId: 'verified_user_1',
      holderName: 'Artist One',
      issuedBy: 'admin_1',
      now,
    });
    const revoked = revokeComplimentaryClaim(issued.claim, {
      revokedBy: 'admin_2',
      reason: 'Recipient withdrew',
      unused: true,
      now,
    });
    expect(revoked).toMatchObject({ status: 'revoked', revokedBy: 'admin_2' });
    expect(issued.allocation.claimedCount).toBe(1);
    expect(() =>
      revokeComplimentaryClaim(issued.claim, {
        revokedBy: 'admin_2',
        reason: 'Entry was already scanned',
        unused: false,
        now,
      }),
    ).toThrow(/unused/);
  });
});
