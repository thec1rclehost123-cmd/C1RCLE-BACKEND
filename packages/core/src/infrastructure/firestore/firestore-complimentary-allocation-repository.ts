import { ConflictError, NotFoundError } from '../../domain/errors.js';
import {
  claimComplimentaryAllocation,
  revokeComplimentaryClaim,
} from '../../domain/models/complimentary-allocation.js';

import { paginateUnordered } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ComplimentaryAllocation,
  ComplimentaryAllocationClaim,
} from '../../domain/models/complimentary-allocation.js';
import type {
  ComplimentaryAllocationRepository,
  PaginationQuery,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const ALLOCATIONS = 'v2_complimentary_allocations';
const CLAIMS = 'v2_complimentary_claims';

export class FirestoreComplimentaryAllocationRepository implements ComplimentaryAllocationRepository {
  constructor(private readonly db: Firestore) {}

  async createAllocation(allocation: ComplimentaryAllocation): Promise<void> {
    const ref = this.db.collection(ALLOCATIONS).doc(allocation.id);
    await this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) throw new ConflictError('Allocation already exists');
      tx.create(ref, allocation);
    });
  }

  async getAllocation(id: EntityId): Promise<ComplimentaryAllocation | null> {
    const snap = await this.db.collection(ALLOCATIONS).doc(id).get();
    const data = snap.data();
    return snap.exists && data ? toAllocation(data) : null;
  }

  async listAllocationsByEvent(eventId: EntityId, query: PaginationQuery) {
    return paginateUnordered(
      this.db.collection(ALLOCATIONS).where('eventId', '==', eventId),
      query,
      toAllocation,
    );
  }

  async getClaim(id: EntityId): Promise<ComplimentaryAllocationClaim | null> {
    const snap = await this.db.collection(CLAIMS).doc(id).get();
    const data = snap.data();
    return snap.exists && data ? toClaim(data) : null;
  }

  async issueClaim(input: {
    allocationId: EntityId;
    claimId: EntityId;
    orderId: EntityId;
    recipientUserId: EntityId;
    holderName: string;
    issuedBy: EntityId;
    now: Date;
  }) {
    const allocationRef = this.db.collection(ALLOCATIONS).doc(input.allocationId);
    const claimRef = this.db.collection(CLAIMS).doc(input.claimId);
    return this.db.runTransaction(async (tx) => {
      const [allocationSnap, claimSnap] = await Promise.all([
        tx.get(allocationRef),
        tx.get(claimRef),
      ]);
      const allocationData = allocationSnap.data();
      const existingClaimData = claimSnap.data();
      if (!allocationSnap.exists || !allocationData) {
        throw new NotFoundError('complimentary_allocation', input.allocationId);
      }
      const allocation = toAllocation(allocationData);
      if (claimSnap.exists && existingClaimData) {
        const existing = toClaim(existingClaimData);
        if (
          existing.allocationId !== input.allocationId ||
          existing.recipientUserId !== input.recipientUserId ||
          existing.orderId !== input.orderId ||
          existing.holderName !== input.holderName.trim()
        ) {
          throw new ConflictError('Comp claim idempotency key was used for another recipient');
        }
        return { allocation, claim: existing, replayed: true };
      }

      const duplicateQuery = this.db
        .collection(CLAIMS)
        .where('allocationId', '==', input.allocationId)
        .where('recipientUserId', '==', input.recipientUserId)
        .where('status', '==', 'issued')
        .limit(1);
      const duplicateSnap = await tx.get(duplicateQuery);
      if (!duplicateSnap.empty) {
        throw new ConflictError('Recipient already has a claim in this allocation');
      }

      const transition = claimComplimentaryAllocation({
        allocation,
        claimId: input.claimId,
        orderId: input.orderId,
        recipientUserId: input.recipientUserId,
        holderName: input.holderName,
        issuedBy: input.issuedBy,
        now: input.now,
      });
      tx.set(allocationRef, transition.allocation);
      tx.create(claimRef, transition.claim);
      return { ...transition, replayed: false };
    });
  }

  async revokeClaim(input: { claimId: EntityId; revokedBy: EntityId; reason: string; now: Date }) {
    const ref = this.db.collection(CLAIMS).doc(input.claimId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (!snap.exists || !data) throw new NotFoundError('complimentary_claim', input.claimId);
      const claim = toClaim(data);
      if (claim.status === 'revoked') return claim;
      const revoked = revokeComplimentaryClaim(claim, { ...input, unused: true });
      tx.set(ref, revoked);
      return revoked;
    });
  }
}

function toAllocation(data: DocumentData): ComplimentaryAllocation {
  return data as ComplimentaryAllocation;
}

function toClaim(data: DocumentData): ComplimentaryAllocationClaim {
  return data as ComplimentaryAllocationClaim;
}
