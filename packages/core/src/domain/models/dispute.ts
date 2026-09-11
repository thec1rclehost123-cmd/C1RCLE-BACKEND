import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Dispute (Phase 6) ──────────────────────────────────────────────────────────
 *
 * A partner's challenge against a ledger entry or payout amount. Minimal FSM
 * (no richer status set found in the v1 reference): `open -> under_review ->
 * resolved`. Amounts in integer paise.
 */

export type DisputeStatus = 'open' | 'under_review' | 'resolved';

/** Set only by the admin resolution desk — the partner-side `resolveDispute` never sets this. */
export type DisputeResolutionOutcome = 'upheld' | 'denied';

export interface Dispute extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  orderId: EntityId;
  ledgerEntryId: EntityId | null;
  raisedBy: EntityId;
  reason: string;
  amount: number; // paise
  status: DisputeStatus;
  resolutionNote: string | null;
  resolvedAt: string | null;
  /** Non-null only when resolved by an admin, not the partner-side `resolveDispute`. */
  resolution: DisputeResolutionOutcome | null;
}

export interface DisputeCreateInput {
  organizationId: EntityId;
  orderId: EntityId;
  ledgerEntryId?: EntityId | null;
  raisedBy: EntityId;
  reason: string;
  amount: number;
  now?: Date;
}

export function createDispute(input: DisputeCreateInput): Dispute {
  if (input.amount <= 0) {
    throw new InvalidOperationError('Dispute amount must be a positive number of paise');
  }
  const now = input.now ?? new Date();
  return {
    id: `dispute-${input.organizationId}-${Date.now()}`,
    organizationId: input.organizationId,
    orderId: input.orderId,
    ledgerEntryId: input.ledgerEntryId ?? null,
    raisedBy: input.raisedBy,
    reason: input.reason,
    amount: input.amount,
    status: 'open',
    resolutionNote: null,
    resolvedAt: null,
    resolution: null,
    ...newVersionedEntity(now),
  };
}

export function beginReview(dispute: Dispute, now: Date = new Date()): Dispute {
  if (dispute.status !== 'open') {
    throw new InvalidOperationError(
      `Cannot begin review on a dispute that is ${dispute.status}, not open`,
    );
  }
  return { ...bumpVersion(dispute, now), status: 'under_review' };
}

export function resolveDispute(
  dispute: Dispute,
  resolutionNote: string,
  now: Date = new Date(),
): Dispute {
  if (dispute.status === 'resolved') {
    throw new InvalidOperationError('Dispute is already resolved');
  }
  return {
    ...bumpVersion(dispute, now),
    status: 'resolved',
    resolutionNote,
    resolvedAt: now.toISOString(),
  };
}

/**
 * Admin resolution — same terminal transition as `resolveDispute`, but
 * records an `outcome`, which the application layer uses to decide whether
 * to write a correcting ledger entry (`upheld`) or leave the ledger
 * untouched (`denied`). The ledger mutation itself lives in
 * `admin-dispute-service.ts`, not here — this function only owns the
 * dispute's own state.
 */
export function adminResolveDispute(
  dispute: Dispute,
  outcome: DisputeResolutionOutcome,
  resolutionNote: string,
  now: Date = new Date(),
): Dispute {
  if (dispute.status === 'resolved') {
    throw new InvalidOperationError('Dispute is already resolved');
  }
  return {
    ...bumpVersion(dispute, now),
    status: 'resolved',
    resolutionNote,
    resolvedAt: now.toISOString(),
    resolution: outcome,
  };
}
