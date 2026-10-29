import { ConflictError, InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

export type TicketAccessCodeStatus = 'active' | 'revoked';
export type TicketAccessScope = 'tiers' | 'event';

/** A one-time displayed verifier-backed code that grants access to selected tiers. */
export interface TicketAccessCode extends VersionedEntity {
  /** SHA-256 verifier; the plaintext code is never persisted. */
  id: EntityId;
  kind: 'code' | 'invitation';
  /** Event scope grants protected event detail; tier scope grants only listed tiers. */
  scope?: TicketAccessScope;
  eventId: EntityId;
  organizationId: EntityId;
  tierIds: EntityId[];
  /** SHA-256 of normalized invite email; null for shareable access codes. */
  recipientEmailHash: string | null;
  createdBy: EntityId;
  status: TicketAccessCodeStatus;
  startsAt: string;
  expiresAt: string;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt: string | null;
  revokedBy: EntityId | null;
  revokedReason: string | null;
}

/** Identity-bound grant. Purchases must present this id and revalidate ownership. */
export interface TicketAccessGrant extends VersionedEntity {
  id: EntityId;
  codeId: EntityId;
  scope?: TicketAccessScope;
  eventId: EntityId;
  organizationId: EntityId;
  userId: EntityId;
  tierIds: EntityId[];
  expiresAt: string;
}

export function createTicketAccessCode(input: {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierIds: readonly EntityId[];
  kind?: 'code' | 'invitation';
  scope?: TicketAccessScope;
  recipientEmailHash?: string | null;
  createdBy: EntityId;
  startsAt: string;
  expiresAt: string;
  maxRedemptions: number;
  now?: Date;
}): TicketAccessCode {
  const tierIds = [...new Set(input.tierIds)];
  const scope = input.scope ?? 'tiers';
  if ((scope === 'tiers' && !tierIds.length) || tierIds.length !== input.tierIds.length) {
    throw new InvalidOperationError('Access codes require unique eligible tiers');
  }
  if (
    !Number.isInteger(input.maxRedemptions) ||
    input.maxRedemptions < 1 ||
    input.maxRedemptions > 10_000
  ) {
    throw new InvalidOperationError('Access code redemption limit must be between 1 and 10000');
  }
  if (
    input.kind === 'invitation' &&
    (input.maxRedemptions !== 1 || !/^[a-f0-9]{64}$/.test(input.recipientEmailHash ?? ''))
  ) {
    throw new InvalidOperationError(
      'Invitations require one claim and a normalized email verifier',
    );
  }
  if (
    !Number.isFinite(Date.parse(input.startsAt)) ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    Date.parse(input.startsAt) >= Date.parse(input.expiresAt)
  ) {
    throw new InvalidOperationError('Access code must have a valid start and expiry window');
  }
  if (Date.parse(input.expiresAt) - Date.parse(input.startsAt) > 366 * 24 * 60 * 60 * 1000) {
    throw new InvalidOperationError('Access code validity cannot exceed 366 days');
  }
  return {
    ...newVersionedEntity(input.now ?? new Date()),
    id: input.id,
    kind: input.kind ?? 'code',
    scope,
    eventId: input.eventId,
    organizationId: input.organizationId,
    tierIds,
    recipientEmailHash: input.recipientEmailHash ?? null,
    createdBy: input.createdBy,
    status: 'active',
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    maxRedemptions: input.maxRedemptions,
    redemptionCount: 0,
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
  };
}

export function redeemTicketAccessCode(
  code: TicketAccessCode,
  input: {
    grantId: EntityId;
    userId: EntityId;
    recipientEmailHash?: string | null;
    now?: Date;
  },
): { code: TicketAccessCode; grant: TicketAccessGrant } {
  const now = input.now ?? new Date();
  if (
    code.status !== 'active' ||
    Date.parse(code.startsAt) > now.getTime() ||
    Date.parse(code.expiresAt) <= now.getTime()
  ) {
    throw new ConflictError('Access code is unavailable');
  }
  if (code.redemptionCount >= code.maxRedemptions) {
    throw new ConflictError('Access code is unavailable');
  }
  if (
    code.kind === 'invitation' &&
    (!code.recipientEmailHash || code.recipientEmailHash !== input.recipientEmailHash)
  ) {
    throw new ConflictError('Access code is unavailable');
  }
  return {
    code: {
      ...bumpVersion(code, now),
      redemptionCount: code.redemptionCount + 1,
    },
    grant: {
      ...newVersionedEntity(now),
      id: input.grantId,
      codeId: code.id,
      scope: code.scope ?? 'tiers',
      eventId: code.eventId,
      organizationId: code.organizationId,
      userId: input.userId,
      tierIds: [...code.tierIds],
      expiresAt: code.expiresAt,
    },
  };
}

export function revokeTicketAccessCode(
  code: TicketAccessCode,
  actorUserId: EntityId,
  reason: string,
  now: Date = new Date(),
): TicketAccessCode {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 8 || normalizedReason.length > 500) {
    throw new InvalidOperationError(
      'Access code revocation requires a reason of 8 to 500 characters',
    );
  }
  if (code.status === 'revoked') return code;
  return {
    ...bumpVersion(code, now),
    status: 'revoked',
    revokedAt: now.toISOString(),
    revokedBy: actorUserId,
    revokedReason: normalizedReason,
  };
}
