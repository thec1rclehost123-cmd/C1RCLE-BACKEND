import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import {
  createBankAccount,
  removeBankAccount,
  setAsDefault,
  unsetDefault,
} from '../../domain/models/bank-account.js';
import { decryptField, encryptField } from '../../infrastructure/encryption.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { BankAccount } from '../../domain/models/bank-account.js';
import type { BankAccountRepository } from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Bank Account Service (Phase 6) ─────────────────────────────────────────────
 *
 * The only place `packages/core` decrypts a bank account number — only for the
 * payout-processing operator flow (`getFullAccountNumber`), never for a
 * partner-facing read. Routes must always serialize the masked view.
 */

export interface BankAccountServiceDeps {
  bankAccounts: BankAccountRepository;
  config: ServiceDeps['config'];
}

export interface AddBankAccountInput {
  organizationId: EntityId;
  bankName: string;
  accountHolder: string;
  accountNumber: string; // plaintext in, never stored in plaintext
  ifscCode: string;
}

export interface BankAccountService {
  addBankAccount(input: AddBankAccountInput, actor: ActorContext): Promise<BankAccount>;
  listBankAccounts(organizationId: EntityId, actor: ActorContext): Promise<BankAccount[]>;
  setDefaultBankAccount(accountId: EntityId, actor: ActorContext): Promise<BankAccount>;
  removeAccount(accountId: EntityId, actor: ActorContext): Promise<void>;
  /** Operator-only: decrypts for the actual bank transfer call. Never exposed via a route DTO. */
  getFullAccountNumber(accountId: EntityId, actor: ActorContext): Promise<string>;
}

export function createBankAccountService(deps: BankAccountServiceDeps): BankAccountService {
  const { bankAccounts, config } = deps;

  async function addBankAccount(
    input: AddBankAccountInput,
    actor: ActorContext,
  ): Promise<BankAccount> {
    requireOrgAccess(actor, input.organizationId);

    const existing = await bankAccounts.listByOrganization(input.organizationId);
    const last4 = input.accountNumber.slice(-4);
    const encryptedAccountNumber = encryptField(
      input.accountNumber,
      config.bankEncryptionSecret,
      config.bankEncryptionSalt,
      input.organizationId,
    );

    const account = createBankAccount({
      organizationId: input.organizationId,
      bankName: input.bankName,
      accountHolder: input.accountHolder,
      last4,
      encryptedAccountNumber,
      ifscCode: input.ifscCode,
      isFirstAccount: existing.length === 0,
      now: config.clock.now(),
    });
    return bankAccounts.create(account);
  }

  async function listBankAccounts(
    organizationId: EntityId,
    actor: ActorContext,
  ): Promise<BankAccount[]> {
    requireOrgAccess(actor, organizationId);
    return bankAccounts.listByOrganization(organizationId);
  }

  async function setDefaultBankAccount(
    accountId: EntityId,
    actor: ActorContext,
  ): Promise<BankAccount> {
    const account = await bankAccounts.findById(accountId);
    if (!account) throw new NotFoundError('BankAccount', accountId);
    requireOrgAccess(actor, account.organizationId);

    const currentDefault = await bankAccounts.findDefaultByOrganization(account.organizationId);
    if (currentDefault && currentDefault.id !== account.id) {
      await bankAccounts.save(unsetDefault(currentDefault, config.clock.now()));
    }
    return bankAccounts.save(setAsDefault(account, config.clock.now()));
  }

  async function removeAccount(accountId: EntityId, actor: ActorContext): Promise<void> {
    const account = await bankAccounts.findById(accountId);
    if (!account) throw new NotFoundError('BankAccount', accountId);
    requireOrgAccess(actor, account.organizationId);

    removeBankAccount(account); // throws InvalidOperationError if it is the default
    await bankAccounts.delete(accountId);
  }

  async function getFullAccountNumber(accountId: EntityId, actor: ActorContext): Promise<string> {
    const account = await bankAccounts.findById(accountId);
    if (!account) throw new NotFoundError('BankAccount', accountId);
    requireOrgAccess(actor, account.organizationId);
    if (!account.encryptedAccountNumber) {
      throw new InvalidOperationError('Bank account has no stored account number');
    }
    return decryptField(
      account.encryptedAccountNumber,
      config.bankEncryptionSecret,
      config.bankEncryptionSalt,
      account.organizationId,
    );
  }

  return {
    addBankAccount,
    listBankAccounts,
    setDefaultBankAccount,
    removeAccount,
    getFullAccountNumber,
  };
}
