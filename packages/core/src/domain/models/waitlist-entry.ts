import { ConflictError, InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

export type WaitlistStatus = 'waiting' | 'offered' | 'accepted' | 'expired' | 'cancelled';

/** One verified person waiting for a specific event tier, in persisted FIFO order. */
export interface WaitlistEntry extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  userId: EntityId;
  accessGrantId: EntityId | null;
  eligibilityAttested: boolean;
  eligibilityAttestedAt: string | null;
  sequence: number;
  status: WaitlistStatus;
  offerReservationId: EntityId | null;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  resolvedAt: string | null;
}

export function createWaitlistEntry(input: {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  tierId: EntityId;
  userId: EntityId;
  sequence: number;
  accessGrantId?: EntityId | null;
  eligibilityAttested?: boolean;
  now?: Date;
}): WaitlistEntry {
  if (!input.userId)
    throw new InvalidOperationError('A verified account is required for waitlist entry');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new InvalidOperationError('Waitlist sequence must be a positive integer');
  }
  return {
    ...newVersionedEntity(input.now ?? new Date()),
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    tierId: input.tierId,
    userId: input.userId,
    accessGrantId: input.accessGrantId ?? null,
    eligibilityAttested: input.eligibilityAttested ?? false,
    eligibilityAttestedAt: input.eligibilityAttested
      ? (input.now ?? new Date()).toISOString()
      : null,
    sequence: input.sequence,
    status: 'waiting',
    offerReservationId: null,
    offeredAt: null,
    offerExpiresAt: null,
    resolvedAt: null,
  };
}

export function offerWaitlistEntry(
  entry: WaitlistEntry,
  input: { reservationId: EntityId; expiresAt: string; now?: Date },
): WaitlistEntry {
  const now = input.now ?? new Date();
  if (entry.status === 'offered' && entry.offerReservationId === input.reservationId) return entry;
  if (entry.status !== 'waiting') throw new ConflictError('Waitlist entry is no longer waiting');
  if (!input.reservationId || Date.parse(input.expiresAt) <= now.getTime()) {
    throw new InvalidOperationError('Waitlist offer must reserve inventory until a future expiry');
  }
  return {
    ...bumpVersion(entry, now),
    status: 'offered',
    offerReservationId: input.reservationId,
    offeredAt: now.toISOString(),
    offerExpiresAt: input.expiresAt,
  };
}

export function acceptWaitlistOffer(
  entry: WaitlistEntry,
  input: { userId: EntityId; now?: Date },
): WaitlistEntry {
  const now = input.now ?? new Date();
  if (entry.userId !== input.userId)
    throw new ConflictError('Waitlist offer belongs to another account');
  if (
    (entry.status !== 'offered' && entry.status !== 'accepted') ||
    !entry.offerExpiresAt ||
    Date.parse(entry.offerExpiresAt) <= now.getTime()
  ) {
    throw new ConflictError('Waitlist offer is no longer active');
  }
  return { ...bumpVersion(entry, now), status: 'accepted', resolvedAt: now.toISOString() };
}

export function expireWaitlistOffer(entry: WaitlistEntry, now?: Date): WaitlistEntry {
  const at = now ?? new Date();
  if (entry.status === 'expired') return entry;
  if (
    (entry.status !== 'offered' && entry.status !== 'accepted') ||
    !entry.offerExpiresAt ||
    Date.parse(entry.offerExpiresAt) > at.getTime()
  ) {
    throw new ConflictError('Waitlist offer is not expired');
  }
  return { ...bumpVersion(entry, at), status: 'expired', resolvedAt: at.toISOString() };
}

export function cancelWaitlistEntry(
  entry: WaitlistEntry,
  input: { userId: EntityId; now?: Date },
): WaitlistEntry {
  const at = input.now ?? new Date();
  if (entry.userId !== input.userId)
    throw new ConflictError('Waitlist entry belongs to another account');
  if (entry.status !== 'waiting' && entry.status !== 'offered') {
    throw new ConflictError('Waitlist entry cannot be cancelled in its current state');
  }
  return { ...bumpVersion(entry, at), status: 'cancelled', resolvedAt: at.toISOString() };
}
