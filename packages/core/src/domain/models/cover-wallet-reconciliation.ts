import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Cover Wallet Reconciliation (Phase 5) ──────────────────────────────────────
 *
 * Daily reconciliation of cover wallet balances. Compares expected balance
 * (opening + credits - debits + refunds) vs actual balance. Used for audit
 * and detecting drift from failed transactions, offline sync issues, etc.
 */

export type ReconciliationStatus = 'pending' | 'completed' | 'discrepancy' | 'resolved';

export type ReconciliationDiscrepancyType =
  | 'balance_mismatch'
  | 'missing_credit'
  | 'missing_debit'
  | 'extra_transaction'
  | 'duplicate_transaction'
  | 'offline_sync_gap';

export interface CoverWalletReconciliation extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** Date being reconciled (YYYY-MM-DD in local timezone) */
  reconciliationDate: string;
  /** Wallet ID (if single wallet) or null for batch */
  walletId: EntityId | null;
  /** User ID (if single wallet) */
  userId: EntityId | null;
  /** Status */
  status: ReconciliationStatus;
  /** Expected balance (computed) */
  expectedBalance: number;
  /** Actual balance (from wallet doc) */
  actualBalance: number;
  /** Difference (actual - expected) */
  discrepancy: number;
  /** Total credits in period */
  periodCredits: number;
  /** Total debits in period */
  periodDebits: number;
  /** Total refunds in period */
  periodRefunds: number;
  /** Number of transactions in period */
  periodTxnCount: number;
  /** Discrepancy details (if any) */
  discrepancies: CoverWalletReconciliationDiscrepancy[];
  /** Resolved by */
  resolvedBy: EntityId | null;
  /** Resolution timestamp */
  resolvedAt: string | null;
  /** Resolution notes */
  resolutionNotes: string | null;
}

export interface CoverWalletReconciliationDiscrepancy {
  type: ReconciliationDiscrepancyType;
  walletId: EntityId;
  userId: EntityId;
  expectedAmount: number;
  actualAmount: number;
  transactionId: EntityId | null;
  description: string;
}

export interface CoverWalletReconciliationCreateInput {
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  reconciliationDate: string;
  walletId: EntityId | null;
  userId: EntityId | null;
  expectedBalance: number;
  actualBalance: number;
  periodCredits: number;
  periodDebits: number;
  periodRefunds: number;
  periodTxnCount: number;
  discrepancies: CoverWalletReconciliationDiscrepancy[];
  now?: Date;
}

export function createReconciliation(input: CoverWalletReconciliationCreateInput): CoverWalletReconciliation {
  const now = input.now ?? new Date();
  const discrepancy = input.actualBalance - input.expectedBalance;
  const status: ReconciliationStatus = 'pending';
  
  return {
    id: `REC-${input.eventId}-${input.reconciliationDate}-${Date.now()}`,
    eventId: input.eventId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    reconciliationDate: input.reconciliationDate,
    walletId: input.walletId,
    userId: input.userId,
    status,
    expectedBalance: input.expectedBalance,
    actualBalance: input.actualBalance,
    discrepancy,
    periodCredits: input.periodCredits,
    periodDebits: input.periodDebits,
    periodRefunds: input.periodRefunds,
    periodTxnCount: input.periodTxnCount,
    discrepancies: input.discrepancies,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNotes: null,
    ...newVersionedEntity(now),
  };
}

export function resolveReconciliation(
  reconciliation: CoverWalletReconciliation,
  resolvedBy: EntityId,
  notes: string,
  now: Date = new Date(),
): CoverWalletReconciliation {
  return {
    ...bumpVersion(reconciliation, now),
    status: 'resolved',
    resolvedBy,
    resolvedAt: now.toISOString(),
    resolutionNotes: notes,
  };
}