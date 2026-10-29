import { ConflictError, NotFoundError } from '../../domain/errors.js';
import {
  claimComplimentaryAllocation,
  revokeComplimentaryClaim,
} from '../../domain/models/complimentary-allocation.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  ComplimentaryAllocation,
  ComplimentaryAllocationClaim,
} from '../../domain/models/complimentary-allocation.js';
import type {
  ComplimentaryAllocationRepository,
  Page,
  PaginationQuery,
} from '../../domain/ports/repositories.js';

export class MemoryComplimentaryAllocationRepository implements ComplimentaryAllocationRepository {
  private readonly allocations = new Map<EntityId, ComplimentaryAllocation>();
  private readonly claims = new Map<EntityId, ComplimentaryAllocationClaim>();

  async createAllocation(allocation: ComplimentaryAllocation): Promise<void> {
    if (this.allocations.has(allocation.id)) throw new ConflictError('Allocation already exists');
    this.allocations.set(allocation.id, allocation);
  }

  async getAllocation(id: EntityId): Promise<ComplimentaryAllocation | null> {
    return this.allocations.get(id) ?? null;
  }

  async listAllocationsByEvent(
    eventId: EntityId,
    query: PaginationQuery,
  ): Promise<Page<ComplimentaryAllocation>> {
    const all = [...this.allocations.values()]
      .filter((allocation) => allocation.eventId === eventId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const limit = Math.min(Math.max(query.limit, 1), 100);
    const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
    return {
      items: all.slice(start, start + limit),
      total: all.length,
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async getClaim(id: EntityId): Promise<ComplimentaryAllocationClaim | null> {
    return this.claims.get(id) ?? null;
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
    const existing = this.claims.get(input.claimId);
    if (existing) {
      if (
        existing.allocationId !== input.allocationId ||
        existing.recipientUserId !== input.recipientUserId ||
        existing.orderId !== input.orderId ||
        existing.holderName !== input.holderName.trim()
      ) {
        throw new ConflictError('Comp claim idempotency key was used for another recipient');
      }
      const allocation = this.allocations.get(existing.allocationId);
      if (!allocation) throw new NotFoundError('complimentary_allocation', existing.allocationId);
      return { allocation, claim: existing, replayed: true };
    }
    const duplicate = [...this.claims.values()].find(
      (claim) =>
        claim.allocationId === input.allocationId &&
        claim.recipientUserId === input.recipientUserId &&
        claim.status === 'issued',
    );
    if (duplicate) throw new ConflictError('Recipient already has a claim in this allocation');
    const allocation = this.allocations.get(input.allocationId);
    if (!allocation) throw new NotFoundError('complimentary_allocation', input.allocationId);
    const transition = claimComplimentaryAllocation({
      allocation,
      claimId: input.claimId,
      orderId: input.orderId,
      recipientUserId: input.recipientUserId,
      holderName: input.holderName,
      issuedBy: input.issuedBy,
      now: input.now,
    });
    this.allocations.set(transition.allocation.id, transition.allocation);
    this.claims.set(transition.claim.id, transition.claim);
    return { ...transition, replayed: false };
  }

  async revokeClaim(input: { claimId: EntityId; revokedBy: EntityId; reason: string; now: Date }) {
    const claim = this.claims.get(input.claimId);
    if (!claim) throw new NotFoundError('complimentary_claim', input.claimId);
    if (claim.status === 'revoked') return claim;
    const revoked = revokeComplimentaryClaim(claim, { ...input, unused: true });
    this.claims.set(revoked.id, revoked);
    return revoked;
  }
}
