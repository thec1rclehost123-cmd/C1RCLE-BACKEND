import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createComplimentaryAllocation } from '../../domain/models/complimentary-allocation.js';

import { FirestoreComplimentaryAllocationRepository } from './firestore-complimentary-allocation-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('M5 complimentary allocation Firestore transactions', () => {
  it('allows only one concurrent claim at quota and replays the winning key', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const repository = new FirestoreComplimentaryAllocationRepository(db);
    const suffix = randomUUID();
    const now = new Date();
    const allocation = createComplimentaryAllocation({
      id: `COMP-ALLOC-${suffix}`,
      eventId: `EVT-${suffix}`,
      organizationId: `ORG-${suffix}`,
      tierId: `TIER-${suffix}`,
      category: 'sponsor',
      reason: 'Named sponsor allocation',
      quota: 1,
      createdBy: `ADMIN-${suffix}`,
      now,
    });
    const inputs = [1, 2].map((index) => ({
      allocationId: allocation.id,
      claimId: `COMP-CLAIM-${suffix}-${index}`,
      orderId: `COMP-ORDER-${suffix}-${index}`,
      recipientUserId: `USER-${suffix}-${index}`,
      holderName: `Guest ${index}`,
      issuedBy: `ADMIN-${suffix}`,
      now,
    }));
    const allocationCollection = db.collection('v2_complimentary_allocations');
    const claimCollection = db.collection('v2_complimentary_claims');
    try {
      await repository.createAllocation(allocation);
      const results = await Promise.allSettled(inputs.map((input) => repository.issueClaim(input)));
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (!winner || winner.status !== 'fulfilled') throw new Error('Expected a quota winner');
      expect(winner.value.allocation.claimedCount).toBe(1);
      const winningInput = inputs.find((input) => input.claimId === winner.value.claim.id);
      if (!winningInput) throw new Error('Expected to find the winning idempotency key');
      await expect(repository.issueClaim(winningInput)).resolves.toMatchObject({
        replayed: true,
        claim: { id: winner.value.claim.id },
      });
      await expect(
        repository.revokeClaim({
          claimId: winner.value.claim.id,
          revokedBy: `ADMIN-${suffix}`,
          reason: 'Allocation issued in error',
          now,
        }),
      ).resolves.toMatchObject({
        status: 'revoked',
        revocationReason: 'Allocation issued in error',
      });
      const storedClaims = await claimCollection.where('allocationId', '==', allocation.id).get();
      expect(storedClaims.size).toBe(1);
    } finally {
      const storedClaims = await claimCollection.where('allocationId', '==', allocation.id).get();
      const batch = db.batch();
      storedClaims.docs.forEach((document) => batch.delete(document.ref));
      batch.delete(allocationCollection.doc(allocation.id));
      await batch.commit();
      await db.terminate();
    }
  });
});
