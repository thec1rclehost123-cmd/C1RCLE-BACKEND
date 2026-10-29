import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

export type TicketTransferStatus =
  'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'frozen';

export interface TicketTransfer extends VersionedEntity {
  id: EntityId;
  entitlementId: EntityId;
  eventId: EntityId;
  senderUserId: EntityId;
  /** Legacy direct-account transfers retain this binding when present. */
  recipientUserId: EntityId | null;
  /** SHA-256 of the normalized invitation email; allows claim without account lookup. */
  recipientEmailHash?: string | null;
  status: TicketTransferStatus;
  expiresAt: string;
  acceptedAt: string | null;
  resolvedAt: string | null;
}

export const MAX_TICKET_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

export function createTicketTransfer(input: {
  id: EntityId;
  entitlementId: EntityId;
  eventId: EntityId;
  senderUserId: EntityId;
  recipientUserId?: EntityId | null;
  recipientEmailHash?: string | null;
  expiresAt: string;
  now?: Date;
}): TicketTransfer {
  const now = input.now ?? new Date();
  const expiry = Date.parse(input.expiresAt);
  if (
    !input.senderUserId ||
    (!input.recipientUserId && !/^[a-f0-9]{64}$/.test(input.recipientEmailHash ?? '')) ||
    (input.recipientUserId && input.senderUserId === input.recipientUserId)
  ) {
    throw new InvalidOperationError(
      'A transfer must bind a different recipient account or verified email',
    );
  }
  if (
    !Number.isFinite(expiry) ||
    expiry <= now.getTime() ||
    expiry > now.getTime() + MAX_TICKET_TRANSFER_TTL_MS
  ) {
    throw new InvalidOperationError('Ticket transfer expiry must be within 24 hours');
  }
  return {
    ...newVersionedEntity(now),
    id: input.id,
    entitlementId: input.entitlementId,
    eventId: input.eventId,
    senderUserId: input.senderUserId,
    recipientUserId: input.recipientUserId ?? null,
    recipientEmailHash: input.recipientEmailHash ?? null,
    status: 'pending',
    expiresAt: new Date(expiry).toISOString(),
    acceptedAt: null,
    resolvedAt: null,
  };
}

export function resolveTicketTransfer(
  transfer: TicketTransfer,
  status: Exclude<TicketTransferStatus, 'pending'>,
  now: Date = new Date(),
): TicketTransfer {
  if (transfer.status !== 'pending') {
    throw new InvalidOperationError('This ticket transfer is no longer pending');
  }
  if (Date.parse(transfer.expiresAt) <= now.getTime() && status !== 'expired') {
    throw new InvalidOperationError('This ticket transfer has expired');
  }
  if (status === 'expired' && Date.parse(transfer.expiresAt) > now.getTime()) {
    throw new InvalidOperationError('This ticket transfer has not expired');
  }
  const resolvedAt = now.toISOString();
  return {
    ...bumpVersion(transfer, now),
    status,
    acceptedAt: status === 'accepted' ? resolvedAt : null,
    resolvedAt,
  };
}
