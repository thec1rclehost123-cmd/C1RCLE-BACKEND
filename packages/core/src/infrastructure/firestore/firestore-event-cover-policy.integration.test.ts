import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  acceptEventCoverPolicy,
  proposeEventCoverPolicy,
} from '../../domain/models/event-cover.js';

import { FirestoreEventCoverPolicyRepository } from './firestore-event-cover-policy-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M5 event cover policy Firestore transactions', () => {
  it('stores exact-version Venue acceptance once and refuses a changed policy', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreEventCoverPolicyRepository(db);
    const suffix = randomUUID();
    const proposalId = `ECP-${suffix}`;
    const now = new Date();
    const proposal = proposeEventCoverPolicy({
      id: proposalId,
      hostOrganizationId: `ORG-host-${suffix}`,
      venueOrganizationId: `ORG-venue-${suffix}`,
      proposedByUserId: `USR-host-${suffix}`,
      policyVersion: 'fixture-cover-v1',
      terms: {
        eventId: `EVT-${suffix}`,
        venueOrganizationId: `ORG-venue-${suffix}`,
        merchantOrganizationId: `ORG-merchant-${suffix}`,
        coverAmountPaise: 150_000,
        minimumSpendPaise: 50_000,
        redemptionOpensAt: new Date(now.getTime() + 60_000).toISOString(),
        redemptionClosesAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
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
    const acceptance = acceptEventCoverPolicy({
      id: `ECA-${suffix}`,
      proposal,
      acceptingVenueOrganizationId: proposal.venueOrganizationId,
      acceptedByUserId: `USR-venue-${suffix}`,
      now,
    });
    const proposals = db.collection('v2_event_cover_policies');
    const acceptances = db.collection('v2_event_cover_policy_acceptances');
    try {
      await repository.createProposal(proposal);
      await repository.createProposal(proposal);
      await repository.acceptProposal(acceptance);
      await repository.acceptProposal(acceptance);
      expect(await repository.getProposal(proposalId)).toMatchObject({
        id: proposalId,
        policyVersion: 'fixture-cover-v1',
        termsDigest: proposal.termsDigest,
      });
      expect(await repository.listProposalsByEvent(proposal.terms.eventId)).toEqual([proposal]);
      expect(await repository.getAcceptance(proposalId)).toMatchObject({
        proposalId,
        termsDigest: proposal.termsDigest,
        acceptedByUserId: acceptance.acceptedByUserId,
      });
      await expect(
        repository.acceptProposal({ ...acceptance, termsDigest: '0'.repeat(64) }),
      ).rejects.toThrow(/exact proposal version/);
    } finally {
      await Promise.all([proposals.doc(proposalId).delete(), acceptances.doc(proposalId).delete()]);
      await db.terminate();
    }
  });
});
