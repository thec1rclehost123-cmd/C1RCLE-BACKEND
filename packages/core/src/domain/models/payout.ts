import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Payout (Phase 6) ──────────────────────────────────────────────────────────
 *
 * A partner's request to withdraw available ledger balance to a bank account.
 * Amounts in integer paise. Minimum payout ₹100 (10000 paise) — v1-proven
 * `requestPromoterPayout` validation, applied uniformly to host/venue/promoter.
 */

export type PayoutStatus = 'requested' | 'processing' | 'paid' | 'failed';

export interface Payout extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  bankAccountId: EntityId;
  amount: number; // paise
  status: PayoutStatus;
  failureReason: string | null;
  requestedBy: EntityId;
  processedAt: string | null;
}

export const MINIMUM_PAYOUT_PAISE = 10_000; // ₹100

export interface PayoutCreateInput {
  organizationId: EntityId;
  bankAccountId: EntityId;
  amount: number;
  requestedBy: EntityId;
  now?: Date;
}

export function createPayout(input: PayoutCreateInput): Payout {
  if (input.amount < MINIMUM_PAYOUT_PAISE) {
    throw new InvalidOperationError(
      `Payout amount ${input.amount} is below the minimum of ${MINIMUM_PAYOUT_PAISE} paise (₹100)`,
    );
  }
  const now = input.now ?? new Date();
  return {
    id: `payout-${input.organizationId}-${Date.now()}`,
    organizationId: input.organizationId,
    bankAccountId: input.bankAccountId,
    amount: input.amount,
    status: 'requested',
    failureReason: null,
    requestedBy: input.requestedBy,
    processedAt: null,
    ...newVersionedEntity(now),
  };
}

export function beginProcessing(payout: Payout, now: Date = new Date()): Payout {
  if (payout.status !== 'requested') {
    throw new InvalidOperationError(
      `Cannot begin processing a payout that is ${payout.status}, not requested`,
    );
  }
  return { ...bumpVersion(payout, now), status: 'processing' };
}

export function markPayoutPaid(payout: Payout, now: Date = new Date()): Payout {
  if (payout.status !== 'processing') {
    throw new InvalidOperationError(
      `Cannot mark paid a payout that is ${payout.status}, not processing`,
    );
  }
  return { ...bumpVersion(payout, now), status: 'paid', processedAt: now.toISOString() };
}

export function markPayoutFailed(payout: Payout, reason: string, now: Date = new Date()): Payout {
  if (payout.status !== 'processing' && payout.status !== 'requested') {
    throw new InvalidOperationError(`Cannot fail a payout that is already ${payout.status}`);
  }
  return {
    ...bumpVersion(payout, now),
    status: 'failed',
    failureReason: reason,
    processedAt: now.toISOString(),
  };
}
