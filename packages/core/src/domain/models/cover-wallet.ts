import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Cover Wallet (Phase 5) ────────────────────────────────────────────────────
 *
 * Pre-paid wallet for venue entry + cover charges. All amounts in integer paise.
 * Invariants:
 * - balance >= 0 (terminated if balance == 0)
 * - credit/debit via Firestore transactions (balance + txn atomic)
 * - idempotency keys on every mutation
 * - velocity limit: max 3 debits/min per device
 * - terminated wallets reject all mutations
 * - offline debits blocked
 * - termination time = next day 05:00 local (tzOffset +05:30)
 */

export type CoverWalletStatus = 'active' | 'terminated' | 'closed';

export type CoverWalletTxnType =
  | 'credit'      // top-up, referral bonus, promo
  | 'debit'       // entry cover charge
  | 'refund'      // refund of debit
  | 'adjustment'; // admin correction

export type CoverWalletTxnStatus = 'pending' | 'committed' | 'failed' | 'reversed';

export interface CoverWallet extends VersionedEntity {
  id: EntityId;
  /** User UID (guest or staff) */
  userId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** Current balance (integer paise) */
  balance: number;
  /** Opening balance at activation */
  openingBalance: number;
  /** Total credits (paise) */
  totalCredits: number;
  /** Total debits (paise) */
  totalDebits: number;
  /** Total refunds (paise) */
  totalRefunds: number;
  /** Status */
  status: CoverWalletStatus;
  /** Termination timestamp (next day 05:00 local) */
  terminatedAt: string | null;
  /** Termination reason */
  terminationReason: string | null;
  /** Last transaction timestamp */
  lastTxnAt: string | null;
  /** Last credit timestamp */
  lastCreditAt: string | null;
  /** Last debit timestamp */
  lastDebitAt: string | null;
  /** Metadata */
  metadata: Record<string, any>;
}

export interface CoverWalletTxn extends VersionedEntity {
  id: EntityId;
  walletId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  userId: EntityId;
  /** Transaction type */
  type: CoverWalletTxnType;
  /** Amount in paise (positive for credit, negative for debit/refund) */
  amount: number;
  /** Balance after this transaction */
  balanceAfter: number;
  /** Status */
  status: CoverWalletTxnStatus;
  /** Idempotency key (client-supplied, required for all mutations) */
  idempotencyKey: string;
  /** Reference to source (doorSaleId, scanLedgerId, promoId, etc.) */
  referenceId: EntityId | null;
  /** Reference type */
  referenceType: string | null;
  /** Device ID that initiated (for velocity limiting) */
  deviceId: string | null;
  /** Operator UID (staff who processed) */
  operatorUid: EntityId | null;
  /** Operator name */
  operatorName: string | null;
  /** Description */
  description: string | null;
  /** Failure reason (if failed) */
  failureReason: string | null;
  /** Processed timestamp */
  processedAt: string | null;
}

export interface CoverWalletCreateInput {
  userId: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  openingBalance: number;
  metadata?: Record<string, any>;
  now?: Date;
}

export function createCoverWallet(input: CoverWalletCreateInput): CoverWallet {
  const now = input.now ?? new Date();
  // Compute termination time: next day 05:00 local (tzOffset +05:30)
  const terminationTime = computeTerminationTime(now);
  
  return {
    id: `CW-${input.eventId}-${input.userId}-${Date.now()}`,
    userId: input.userId,
    eventId: input.eventId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    balance: input.openingBalance,
    openingBalance: input.openingBalance,
    totalCredits: input.openingBalance,
    totalDebits: 0,
    totalRefunds: 0,
    status: 'active',
    terminatedAt: null,
    terminationReason: null,
    lastTxnAt: null,
    lastCreditAt: null,
    lastDebitAt: null,
    metadata: input.metadata ?? {},
    ...newVersionedEntity(now),
  };
}

export interface CoverWalletCreditInput {
  walletId: EntityId;
  amount: number; // paise, positive
  referenceId: EntityId | null;
  referenceType: string | null;
  operatorUid: EntityId | null;
  operatorName: string | null;
  description: string | null;
  idempotencyKey: string;
  now?: Date;
}

export interface CoverWalletDebitInput {
  walletId: EntityId;
  amount: number; // paise, positive (will be stored as negative)
  referenceId: EntityId | null;
  referenceType: string | null;
  operatorUid: EntityId | null;
  operatorName: string | null;
  description: string | null;
  idempotencyKey: string;
  deviceId: string | null;
  now?: Date;
}

/**
 * Compute termination time: next day 05:00 local (tzOffset +05:30)
 * This is called at wallet creation to set the termination deadline.
 */
export function computeTerminationTime(from: Date = new Date()): string {
  const tzOffsetMinutes = 5 * 60 + 30; // +05:30
  const local = new Date(from.getTime() + tzOffsetMinutes * 60 * 1000);
  
  // Next day 05:00 local
  local.setDate(local.getDate() + 1);
  local.setUTCHours(5, 0, 0, 0);
  
  // Convert back to UTC
  const utc = new Date(local.getTime() - tzOffsetMinutes * 60 * 1000);
  return utc.toISOString();
}

export function isWalletActive(wallet: CoverWallet): boolean {
  return wallet.status === 'active';
}

export function isWalletTerminated(wallet: CoverWallet): boolean {
  return wallet.status === 'terminated' || wallet.status === 'closed';
}

export function canWalletDebit(wallet: CoverWallet, amount: number): boolean {
  if (!isWalletActive(wallet)) return false;
  if (wallet.balance < amount) return false;
  return true;
}

export function applyCredit(wallet: CoverWallet, input: CoverWalletCreditInput): CoverWallet {
  if (!isWalletActive(wallet)) {
    throw new InvalidOperationError('Wallet is not active');
  }
  const now = input.now ?? new Date();
  return {
    ...bumpVersion(wallet, now),
    balance: wallet.balance + input.amount,
    totalCredits: wallet.totalCredits + input.amount,
    lastTxnAt: now.toISOString(),
    lastCreditAt: now.toISOString(),
  };
}

export function applyDebit(wallet: CoverWallet, input: CoverWalletDebitInput): CoverWallet {
  if (!isWalletActive(wallet)) {
    throw new InvalidOperationError('Wallet is not active');
  }
  if (wallet.balance < input.amount) {
    throw new InvalidOperationError('Insufficient balance');
  }
  const now = input.now ?? new Date();
  const newBalance = wallet.balance - input.amount;
  return {
    ...bumpVersion(wallet, now),
    balance: newBalance,
    totalDebits: wallet.totalDebits + input.amount,
    lastTxnAt: now.toISOString(),
    lastDebitAt: now.toISOString(),
    status: newBalance === 0 ? 'terminated' : wallet.status,
    terminatedAt: newBalance === 0 ? now.toISOString() : wallet.terminatedAt,
    terminationReason: newBalance === 0 ? 'balance_depleted' : wallet.terminationReason,
  };
}

export function applyRefund(wallet: CoverWallet, amount: number, now: Date = new Date()): CoverWallet {
  if (!isWalletActive(wallet)) {
    throw new InvalidOperationError('Wallet is not active');
  }
  return {
    ...bumpVersion(wallet, now),
    balance: wallet.balance + amount,
    totalRefunds: wallet.totalRefunds + amount,
    lastTxnAt: now.toISOString(),
  };
}