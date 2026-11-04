import { describe, expect, it } from 'vitest';

import {
  acceptEventCoverPolicy,
  proposeEventCoverPolicy,
} from '../../domain/models/event-cover.js';

import { MemoryEventCoverPolicyRepository } from './memory-event-cover-policy-repository.js';

const now = new Date('2026-10-28T12:00:00.000Z');

function proposal(id = 'policy-1', coverAmountPaise = 150_000) {
  return proposeEventCoverPolicy({
    id,
    hostOrganizationId: 'host-1',
    venueOrganizationId: 'venue-1',
    proposedByUserId: 'host-user-1',
    policyVersion: 'fixture-v1',
    terms: {
      eventId: 'event-1',
      venueOrganizationId: 'venue-1',
      merchantOrganizationId: 'merchant-1',
      coverAmountPaise,
      minimumSpendPaise: 50_000,
      redemptionOpensAt: '2026-11-01T18:00:00.000Z',
      redemptionClosesAt: '2026-11-02T02:00:00.000Z',
      eligibleCategories: ['food'],
      excludedCategories: ['alcohol'],
      alcoholRule: 'exclude_alcohol',
      partialRedemption: true,
      splitTender: true,
      refundPolicy: 'unused_full_before_redemption',
      transferUnusedOnly: true,
      commissionBasis: 'net_admission_after_allocated_discount',
      unusedBalancePolicy: 'approved_minimum_spend_expiry',
    },
    now,
  });
}

describe('MemoryEventCoverPolicyRepository', () => {
  it('persists and reads immutable proposals and exact-version Venue acceptance', async () => {
    const repository = new MemoryEventCoverPolicyRepository();
    const draft = proposal();
    const acceptance = acceptEventCoverPolicy({
      id: 'acceptance-1',
      proposal: draft,
      acceptingVenueOrganizationId: 'venue-1',
      acceptedByUserId: 'venue-user-1',
      now,
    });
    await repository.createProposal(draft);
    await repository.acceptProposal(acceptance);
    expect(await repository.getProposal(draft.id)).toEqual(draft);
    expect(await repository.getAcceptance(draft.id)).toEqual(acceptance);
    expect(await repository.listProposalsByEvent('event-1')).toEqual([draft]);
    await expect(
      repository.acceptProposal(
        acceptEventCoverPolicy({
          id: 'acceptance-retry',
          proposal: draft,
          acceptingVenueOrganizationId: 'venue-1',
          acceptedByUserId: 'venue-user-1',
          now: new Date(now.getTime() + 1),
        }),
      ),
    ).resolves.toEqual(acceptance);
  });

  it('rejects changed proposal contents under the same id and mismatched acceptance digest', async () => {
    const repository = new MemoryEventCoverPolicyRepository();
    const draft = proposal();
    await repository.createProposal(draft);
    await expect(repository.createProposal(proposal(draft.id, 200_000))).rejects.toThrow(
      'proposal id is already used',
    );
    const acceptance = acceptEventCoverPolicy({
      id: 'acceptance-invalid',
      proposal: { ...draft, termsDigest: 'f'.repeat(64) },
      acceptingVenueOrganizationId: 'venue-1',
      acceptedByUserId: 'venue-user-1',
      now,
    });
    await expect(repository.acceptProposal(acceptance)).rejects.toThrow(
      'does not match the exact proposal version',
    );
  });
});
