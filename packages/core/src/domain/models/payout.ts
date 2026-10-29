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

export type PayoutStatus = 'requested' | 'processing' | 'paid' | 'failed' | 'frozen';

export interface Payout extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  bankAccountId: EntityId;
  amount: number; // paise
  status: PayoutStatus;
  failureReason: string | null;
  requestedBy: EntityId;
  processedAt: string | null;
  transferReference: string | null;
  transferredAt: string | null;
  transferMethod: string | null;
  transferProof: PayoutTransferProof | null;
  approvedBy: EntityId | null;
  /**
   * The status this payout held before an admin froze it. Set only while
   * `status === 'frozen'`. `releasePayout` restores exactly this value —
   * never a caller-supplied one — so a release can't silently resurrect a
   * payout into a state it never legitimately held.
   */
  previousStatus: PayoutStatus | null;
}

export interface PayoutTransferProof {
  /** SHA-256 of the immutable proof object; the proof body is kept out of the payout row. */
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

export interface PayoutTransferEvidence {
  transferReference: string;
  transferredAt: string;
  transferMethod: string;
  proof: PayoutTransferProof;
  approvedBy: EntityId;
}

export const MINIMUM_PAYOUT_PAISE = 10_000; // ₹100

export interface PayoutCreateInput {
  id?: EntityId;
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
    id: input.id ?? `payout-${input.organizationId}-${Date.now()}`,
    organizationId: input.organizationId,
    bankAccountId: input.bankAccountId,
    amount: input.amount,
    status: 'requested',
    failureReason: null,
    requestedBy: input.requestedBy,
    processedAt: null,
    transferReference: null,
    transferredAt: null,
    transferMethod: null,
    transferProof: null,
    approvedBy: null,
    previousStatus: null,
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

export function markPayoutPaid(
  payout: Payout,
  evidence: PayoutTransferEvidence,
  now: Date = new Date(),
): Payout {
  if (payout.status !== 'processing') {
    throw new InvalidOperationError(
      `Cannot mark paid a payout that is ${payout.status}, not processing`,
    );
  }
  if (!evidence.transferReference.trim()) {
    throw new InvalidOperationError('A paid payout requires a transfer reference');
  }
  if (!evidence.transferMethod.trim()) {
    throw new InvalidOperationError('A paid payout requires a transfer method');
  }
  if (Number.isNaN(Date.parse(evidence.transferredAt))) {
    throw new InvalidOperationError('A paid payout requires a valid transfer timestamp');
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.proof.sha256)) {
    throw new InvalidOperationError('A paid payout requires a SHA-256 transfer proof hash');
  }
  if (
    !evidence.proof.contentType.trim() ||
    !Number.isSafeInteger(evidence.proof.sizeBytes) ||
    evidence.proof.sizeBytes <= 0
  ) {
    throw new InvalidOperationError('A paid payout requires immutable transfer proof metadata');
  }
  if (!evidence.approvedBy.trim() || evidence.approvedBy === payout.requestedBy) {
    throw new InvalidOperationError('Payout requester cannot approve the same payout transfer');
  }
  return {
    ...bumpVersion(payout, now),
    status: 'paid',
    processedAt: now.toISOString(),
    transferReference: evidence.transferReference.trim(),
    transferredAt: new Date(evidence.transferredAt).toISOString(),
    transferMethod: evidence.transferMethod.trim(),
    transferProof: { ...evidence.proof, sha256: evidence.proof.sha256.toLowerCase() },
    approvedBy: evidence.approvedBy,
  };
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

/**
 * Admin freeze (TIER3, dual control — see `admin-authority.ts`). Stalls a
 * payout mid-flight without losing what state it was in, so release can put
 * it back exactly where it was rather than guessing. Idempotent: freezing an
 * already-frozen payout is a no-op, matching `markPaid`'s retry-safe style.
 * Terminal payouts (`paid`, `failed`) cannot be frozen — there is nothing
 * left to stall.
 */
export function freezePayout(payout: Payout, now: Date = new Date()): Payout {
  if (payout.status === 'frozen') return payout;
  if (payout.status === 'paid' || payout.status === 'failed') {
    throw new InvalidOperationError(`Cannot freeze a payout that is already ${payout.status}`);
  }
  return {
    ...bumpVersion(payout, now),
    status: 'frozen',
    previousStatus: payout.status,
  };
}

/**
 * Admin release (TIER3, dual control) — the inverse of `freezePayout`. v1
 * had this asymmetric (freeze dual-controlled, release single-admin); v2
 * requires the second signature on both directions of a money-affecting
 * override. Always restores the stored `previousStatus`, never a
 * caller-supplied value — the exact bug class this project's refund
 * restore-after-failure function was also built to avoid.
 */
export function releasePayout(payout: Payout, now: Date = new Date()): Payout {
  if (payout.status !== 'frozen') {
    throw new InvalidOperationError(`Cannot release a payout that is not frozen`);
  }
  const restored = payout.previousStatus;
  if (restored === null) {
    throw new InvalidOperationError(`Frozen payout ${payout.id} has no recorded previous status`);
  }
  return {
    ...bumpVersion(payout, now),
    status: restored,
    previousStatus: null,
  };
}
