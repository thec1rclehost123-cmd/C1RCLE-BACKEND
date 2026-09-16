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

/**
 * `frozen` is reversible and non-terminal (unlike `terminated`/`closed`) —
 * only reachable from `active`, and only `active` is reachable from it.
 * `isWalletActive` naturally excludes it, so every mutation already gated
 * on that check (`applyCredit`/`applyDebit`/`applyRefund`) rejects while
 * frozen with no changes needed to those functions.
 */
export type CoverWalletStatus = 'active' | 'frozen' | 'terminated' | 'closed';

export type CoverWalletTxnType =
  | 'credit' // top-up, referral bonus, promo
  | 'debit' // entry cover charge
  | 'refund' // refund of debit
  | 'adjustment'; // admin correction

export type CoverWalletTxnStatus = 'pending' | 'committed' | 'failed' | 'reversed';

/**
 * One thing a bartender can ring up against a tab.
 *
 * Preset items exist so the scanner never types an amount. Free-entry pricing
 * at a door, on a phone, at 1am, is how a ₹500 drink becomes a ₹5,000 charge
 * — and the guest cannot check the screen before it is taken. The price comes
 * from the venue's own list, and the scanner only ever names the item.
 */
export interface CoverWalletPresetItem {
  id: EntityId;
  label: string;
  amountPaise: number;
  /** Run out of a drink? Turn it off without editing the venue's price list. */
  isAvailable: boolean;
}

export interface CoverWalletRules {
  /** The only things this wallet can be charged for. Empty = nothing. */
  presetItems: CoverWalletPresetItem[];
  /** Belt-and-braces bounds on one charge, independent of the item list. */
  minChargePaise: number;
  maxChargePaise: number;
  /** Whether the scanner may show the guest's balance on screen. */
  showBalanceToGuest: boolean;
}

export const DEFAULT_COVER_WALLET_RULES: CoverWalletRules = {
  presetItems: [],
  minChargePaise: 1,
  // A single charge above ₹50,000 is a typo or a fraud, not a round of drinks.
  maxChargePaise: 5_000_000,
  showBalanceToGuest: true,
};

/** Fails closed: an unknown or unavailable item can never be charged. */
export function findChargeableItem(
  rules: CoverWalletRules,
  presetItemId: EntityId,
): CoverWalletPresetItem | null {
  const item = rules.presetItems.find((candidate) => candidate.id === presetItemId);
  if (!item || !item.isAvailable) return null;
  return item;
}

/**
 * Price for a charge, computed from the venue's list — never from the client.
 * Returns null when the item is unknown, unavailable, or the total falls
 * outside the wallet's own bounds.
 */
export function priceForCharge(
  rules: CoverWalletRules,
  presetItemId: EntityId,
  quantity: number,
): number | null {
  const item = findChargeableItem(rules, presetItemId);
  if (!item) return null;
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  const total = item.amountPaise * quantity;
  if (!Number.isSafeInteger(total)) return null;
  if (total < rules.minChargePaise || total > rules.maxChargePaise) return null;
  return total;
}

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
  metadata: Record<string, unknown>;
  /** What this wallet may be charged for, and within what bounds. */
  rules: CoverWalletRules;
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
  metadata?: Record<string, unknown>;
  rules?: Partial<CoverWalletRules>;
  now?: Date;
}

export function createCoverWallet(input: CoverWalletCreateInput): CoverWallet {
  const now = input.now ?? new Date();
  // Compute termination time: next day 05:00 local (tzOffset +05:30)
  const _terminationTime = computeTerminationTime(now);

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
    rules: { ...DEFAULT_COVER_WALLET_RULES, ...input.rules },
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

export function isWalletFrozen(wallet: CoverWallet): boolean {
  return wallet.status === 'frozen';
}

export function freezeWallet(wallet: CoverWallet, now?: Date): CoverWallet {
  if (!isWalletActive(wallet)) {
    throw new InvalidOperationError(`Cannot freeze a wallet that is ${wallet.status}, not active`);
  }
  return { ...bumpVersion(wallet, now ?? new Date()), status: 'frozen' };
}

export function unfreezeWallet(wallet: CoverWallet, now?: Date): CoverWallet {
  if (!isWalletFrozen(wallet)) {
    throw new InvalidOperationError(
      `Cannot unfreeze a wallet that is ${wallet.status}, not frozen`,
    );
  }
  return { ...bumpVersion(wallet, now ?? new Date()), status: 'active' };
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

export function applyRefund(
  wallet: CoverWallet,
  amount: number,
  now: Date = new Date(),
): CoverWallet {
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
