import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Promoter connections (Phase 1) ──────────────────────────────────────────
 *
 * The promoter↔host and promoter↔venue relationship, ported from v1
 * `routes/v1/promoter-connections.ts`. Distinct from `Partnership`, which is
 * the venue↔host relationship: the parties, the initiator rules and the
 * revoke action all differ, so collapsing them into one model would mean a
 * status field that means different things depending on who is looking.
 *
 * v1's rules, kept:
 *  - starts `pending`; blocked while a `pending` OR `active` one exists for
 *    the pair (v1 fixed this as "BUG-2" — the original only checked pending)
 *  - only the RECIPIENT may approve, reject or block
 *  - only the PROMOTER may revoke — that asymmetry is the point of `revoke`
 *    existing alongside `reject`
 */

export type PromoterConnectionStatus = 'pending' | 'active' | 'rejected' | 'blocked' | 'revoked';

const CONNECTION_TRANSITIONS: Readonly<
  Record<PromoterConnectionStatus, readonly PromoterConnectionStatus[]>
> = {
  pending: ['active', 'rejected', 'blocked', 'revoked'],
  // An active connection can be withdrawn by either side's own action.
  active: ['revoked', 'blocked'],
  rejected: [],
  blocked: [],
  revoked: [],
};

/** Who the promoter is connecting to. */
export type ConnectionTargetType = 'host' | 'venue';

/** Which side opened the conversation. */
export type ConnectionInitiator = 'promoter' | 'target';

export interface PromoterConnection extends VersionedEntity {
  id: EntityId;
  promoterId: EntityId;
  targetId: EntityId;
  targetType: ConnectionTargetType;
  initiatedBy: ConnectionInitiator;
  status: PromoterConnectionStatus;
  message: string | null;
  resolutionReason: string | null;
  resolvedAt: string | null;
}

export interface CreatePromoterConnectionInput {
  id: EntityId;
  promoterId: EntityId;
  targetId: EntityId;
  targetType: ConnectionTargetType;
  initiatedBy: ConnectionInitiator;
  message?: string;
  now?: Date;
}

export function createPromoterConnection(input: CreatePromoterConnectionInput): PromoterConnection {
  if (input.promoterId === input.targetId) {
    throw new InvalidOperationError('A promoter cannot connect to themselves');
  }
  return {
    id: input.id,
    promoterId: input.promoterId,
    targetId: input.targetId,
    targetType: input.targetType,
    initiatedBy: input.initiatedBy,
    status: 'pending',
    message: input.message ?? null,
    resolutionReason: null,
    resolvedAt: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/**
 * The side that must answer. When the promoter opened it, the target answers;
 * when the target opened it, the promoter does.
 */
export function recipientOf(connection: PromoterConnection): EntityId {
  return connection.initiatedBy === 'promoter' ? connection.targetId : connection.promoterId;
}

export function isPartyToConnection(
  connection: PromoterConnection,
  organizationId: EntityId,
): boolean {
  return connection.promoterId === organizationId || connection.targetId === organizationId;
}

function transition(
  connection: PromoterConnection,
  to: PromoterConnectionStatus,
  now: Date,
  reason?: string,
): PromoterConnection {
  if (connection.status === to) return connection;
  const next = transitionStatus(connection.status, to, CONNECTION_TRANSITIONS);
  return {
    ...bumpVersion(connection, now),
    status: next,
    resolutionReason: reason ?? connection.resolutionReason,
    resolvedAt: now.toISOString(),
  };
}

export function approveConnection(
  connection: PromoterConnection,
  approvingId: EntityId,
  now?: Date,
): PromoterConnection {
  if (approvingId !== recipientOf(connection)) {
    throw new InvalidOperationError('Only the recipient can approve this connection');
  }
  return transition(connection, 'active', now ?? new Date());
}

export function rejectConnection(
  connection: PromoterConnection,
  rejectingId: EntityId,
  reason?: string,
  now?: Date,
): PromoterConnection {
  if (rejectingId !== recipientOf(connection)) {
    throw new InvalidOperationError('Only the recipient can reject this connection');
  }
  return transition(connection, 'rejected', now ?? new Date(), reason);
}

/** Blocking is terminal and open to either party, as with partnerships. */
export function blockConnection(
  connection: PromoterConnection,
  blockingId: EntityId,
  reason?: string,
  now?: Date,
): PromoterConnection {
  if (!isPartyToConnection(connection, blockingId)) {
    throw new InvalidOperationError('Only a party to this connection can block it');
  }
  return transition(connection, 'blocked', now ?? new Date(), reason);
}

/**
 * Withdrawal by the promoter. Separate from `reject` on purpose: v1 gave the
 * promoter this action specifically so they could pull out of a connection
 * they opened, or leave one they no longer want, without it reading as the
 * counterparty having refused them.
 */
export function revokeConnection(
  connection: PromoterConnection,
  revokingId: EntityId,
  now?: Date,
): PromoterConnection {
  if (revokingId !== connection.promoterId) {
    throw new InvalidOperationError('Only the promoter can revoke this connection');
  }
  return transition(connection, 'revoked', now ?? new Date());
}

/** Occupies the pair — v1's "already exists or is pending" guard. */
export function isConnectionLive(connection: PromoterConnection): boolean {
  return connection.status === 'pending' || connection.status === 'active';
}
