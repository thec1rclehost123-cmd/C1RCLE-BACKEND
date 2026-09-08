import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Bank Account (Phase 6) ─────────────────────────────────────────────────────
 *
 * Partner payout destination. The full account number is stored encrypted
 * (`infrastructure/encryption.ts`, AES-256-CBC) — the domain model only ever
 * carries `last4` plaintext plus the ciphertext blob; it is never decrypted
 * back to the wire (routes always serialize a masked `••1234` view, never
 * `encryptedAccountNumber`). One `isDefault` account at a time per org —
 * enforced here, not left to callers to remember.
 */

export interface BankAccount extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  bankName: string;
  accountHolder: string;
  /** Last 4 digits, plaintext (safe to display: `••1234`). */
  last4: string;
  /** AES-256-CBC envelope (`<ivHex>:<cipherHex>`) of the full account number. */
  encryptedAccountNumber: string;
  ifscCode: string;
  isDefault: boolean;
  verified: boolean;
}

export interface BankAccountCreateInput {
  organizationId: EntityId;
  bankName: string;
  accountHolder: string;
  last4: string;
  encryptedAccountNumber: string;
  ifscCode: string;
  /** True if this is the org's first bank account (becomes default). */
  isFirstAccount: boolean;
  now?: Date;
}

export function createBankAccount(input: BankAccountCreateInput): BankAccount {
  const now = input.now ?? new Date();
  return {
    id: `bank-${input.organizationId}-${Date.now()}`,
    organizationId: input.organizationId,
    bankName: input.bankName,
    accountHolder: input.accountHolder,
    last4: input.last4,
    encryptedAccountNumber: input.encryptedAccountNumber,
    ifscCode: input.ifscCode,
    isDefault: input.isFirstAccount,
    verified: false,
    ...newVersionedEntity(now),
  };
}

export function setAsDefault(account: BankAccount, now: Date = new Date()): BankAccount {
  return { ...bumpVersion(account, now), isDefault: true };
}

export function unsetDefault(account: BankAccount, now: Date = new Date()): BankAccount {
  return { ...bumpVersion(account, now), isDefault: false };
}

export function removeBankAccount(account: BankAccount): void {
  if (account.isDefault) {
    throw new InvalidOperationError(
      'Cannot remove the default bank account — set another account as default first',
    );
  }
}

export function maskAccountNumber(last4: string): string {
  return `••${last4}`;
}
