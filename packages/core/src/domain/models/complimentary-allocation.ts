import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

export type ComplimentaryCategory = 'artist' | 'staff' | 'sponsor' | 'press' | 'influencer';

export interface ComplimentaryAllocation extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  category: ComplimentaryCategory;
  reason: string;
  quota: number;
  claimedCount: number;
  status: 'active' | 'closed';
  expiresAt: string | null;
  createdBy: EntityId;
}

export interface ComplimentaryAllocationClaim extends VersionedEntity {
  id: EntityId;
  allocationId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  recipientUserId: EntityId;
  holderName: string;
  status: 'issued' | 'revoked';
  orderId: EntityId;
  issuedBy: EntityId;
  issuedAt: string;
  revokedBy: EntityId | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export function createComplimentaryAllocation(input: {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  category: ComplimentaryCategory;
  reason: string;
  quota: number;
  createdBy: EntityId;
  expiresAt?: string | null;
  now?: Date;
}): ComplimentaryAllocation {
  const reason = input.reason.trim();
  if (!reason) throw new InvalidOperationError('A complimentary allocation requires a reason');
  if (!Number.isSafeInteger(input.quota) || input.quota < 1) {
    throw new InvalidOperationError('Complimentary allocation quota must be a positive integer');
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= (input.now ?? new Date()).getTime()) {
    throw new InvalidOperationError('Complimentary allocation expiry must be in the future');
  }
  if (!input.createdBy) throw new InvalidOperationError('Allocation issuer is required');
  const now = input.now ?? new Date();
  return {
    ...newVersionedEntity(now),
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    tierId: input.tierId,
    category: input.category,
    reason,
    quota: input.quota,
    claimedCount: 0,
    status: 'active',
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy,
  };
}

export function claimComplimentaryAllocation(input: {
  allocation: ComplimentaryAllocation;
  claimId: EntityId;
  orderId: EntityId;
  recipientUserId: EntityId;
  holderName: string;
  issuedBy: EntityId;
  now?: Date;
}): { allocation: ComplimentaryAllocation; claim: ComplimentaryAllocationClaim } {
  const { allocation } = input;
  const now = input.now ?? new Date();
  const holderName = input.holderName.trim();
  if (allocation.status !== 'active') {
    throw new InvalidOperationError('Complimentary allocation is closed');
  }
  if (allocation.expiresAt && Date.parse(allocation.expiresAt) <= now.getTime()) {
    throw new InvalidOperationError('Complimentary allocation has expired');
  }
  if (allocation.claimedCount >= allocation.quota) {
    throw new InvalidOperationError('Complimentary allocation quota is exhausted');
  }
  if (!input.recipientUserId || !holderName || !input.issuedBy) {
    throw new InvalidOperationError('A verified recipient and holder name are required');
  }
  const claim: ComplimentaryAllocationClaim = {
    ...newVersionedEntity(now),
    id: input.claimId,
    allocationId: allocation.id,
    eventId: allocation.eventId,
    organizationId: allocation.organizationId,
    tierId: allocation.tierId,
    recipientUserId: input.recipientUserId,
    holderName,
    status: 'issued',
    orderId: input.orderId,
    issuedBy: input.issuedBy,
    issuedAt: now.toISOString(),
    revokedBy: null,
    revokedAt: null,
    revocationReason: null,
  };
  return {
    allocation: {
      ...bumpVersion(allocation, now),
      claimedCount: allocation.claimedCount + 1,
    },
    claim,
  };
}

/** Revocation consumes quota permanently; it never silently reopens allocation capacity. */
export function revokeComplimentaryClaim(
  claim: ComplimentaryAllocationClaim,
  input: { revokedBy: EntityId; reason: string; unused: boolean; now?: Date },
): ComplimentaryAllocationClaim {
  const reason = input.reason.trim();
  if (!input.revokedBy || !reason) {
    throw new InvalidOperationError('Comp revocation requires an issuer and audit reason');
  }
  if (!input.unused || claim.status !== 'issued') {
    throw new InvalidOperationError('Only an unused complimentary ticket can be revoked');
  }
  const now = input.now ?? new Date();
  return {
    ...bumpVersion(claim, now),
    status: 'revoked',
    revokedBy: input.revokedBy,
    revokedAt: now.toISOString(),
    revocationReason: reason,
  };
}
