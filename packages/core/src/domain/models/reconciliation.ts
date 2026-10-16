import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

export type ReconciliationRunStatus = 'running' | 'completed' | 'failed';
export type ReconciliationDiscrepancyKind =
  | 'captured_payment_without_order'
  | 'paid_order_without_capture'
  | 'paid_order_without_ticket'
  | 'ticket_without_paid_order'
  | 'missing_journal'
  | 'duplicate_journal'
  | 'unbalanced_journal'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'provider_order_mismatch'
  | 'refund_mismatch'
  | 'chargeback_mismatch'
  | 'stale_pending_payment'
  | 'payout_mismatch';

export type ReconciliationDiscrepancyState =
  'open' | 'finance_review' | 'support_required' | 'resolved';

export interface ReconciliationRun extends VersionedEntity {
  id: EntityId;
  status: ReconciliationRunStatus;
  requestedBy: EntityId;
  startedAt: string;
  completedAt: string | null;
  scannedCounts: Record<string, number>;
  discrepancyCount: number;
  failureReason: string | null;
}

export interface ReconciliationDiscrepancy extends VersionedEntity {
  id: EntityId;
  runId: EntityId;
  kind: ReconciliationDiscrepancyKind;
  state: ReconciliationDiscrepancyState;
  organizationId: EntityId | null;
  orderId: EntityId | null;
  paymentId: string | null;
  payoutId: EntityId | null;
  amountPaise: number | null;
  currency: string | null;
  evidence: Record<string, string | number | boolean | null>;
  repair: 'recheck_evidence' | null;
  resolutionReason: string | null;
  resolvedBy: EntityId | null;
  resolvedAt: string | null;
}

export function createReconciliationRun(input: {
  id: EntityId;
  requestedBy: EntityId;
  now: Date;
}): ReconciliationRun {
  return {
    id: input.id,
    status: 'running',
    requestedBy: input.requestedBy,
    startedAt: input.now.toISOString(),
    completedAt: null,
    scannedCounts: {},
    discrepancyCount: 0,
    failureReason: null,
    ...newVersionedEntity(input.now),
  };
}

export function completeReconciliationRun(
  run: ReconciliationRun,
  scannedCounts: Record<string, number>,
  discrepancyCount: number,
  now: Date,
): ReconciliationRun {
  if (run.status !== 'running') throw new InvalidOperationError('Reconciliation run is not active');
  return {
    ...bumpVersion(run, now),
    status: 'completed',
    completedAt: now.toISOString(),
    scannedCounts,
    discrepancyCount,
  };
}

export function failReconciliationRun(
  run: ReconciliationRun,
  failureReason: string,
  now: Date,
): ReconciliationRun {
  if (run.status !== 'running') throw new InvalidOperationError('Reconciliation run is not active');
  return {
    ...bumpVersion(run, now),
    status: 'failed',
    completedAt: now.toISOString(),
    failureReason: failureReason.trim() || 'Reconciliation failed',
  };
}

export function resolveReconciliationDiscrepancy(
  discrepancy: ReconciliationDiscrepancy,
  actorId: EntityId,
  reason: string,
  now: Date,
): ReconciliationDiscrepancy {
  if (!reason.trim()) throw new InvalidOperationError('Resolution requires a reason');
  if (discrepancy.state === 'resolved') return discrepancy;
  return {
    ...bumpVersion(discrepancy, now),
    state: 'resolved',
    resolutionReason: reason.trim(),
    resolvedBy: actorId,
    resolvedAt: now.toISOString(),
  };
}
