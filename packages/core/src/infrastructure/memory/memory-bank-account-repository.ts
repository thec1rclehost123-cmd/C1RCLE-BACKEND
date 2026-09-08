import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { BankAccount } from '../../domain/models/bank-account.js';
import type { BankAccountRepository } from '../../domain/ports/repositories.js';

export class MemoryBankAccountRepository implements BankAccountRepository {
  accounts = new Map<EntityId, BankAccount>();

  async create(account: BankAccount): Promise<BankAccount> {
    this.accounts.set(account.id, account);
    return account;
  }

  async findById(id: EntityId): Promise<BankAccount | null> {
    return this.accounts.get(id) ?? null;
  }

  async listByOrganization(organizationId: EntityId): Promise<BankAccount[]> {
    return [...this.accounts.values()].filter((a) => a.organizationId === organizationId);
  }

  async findDefaultByOrganization(organizationId: EntityId): Promise<BankAccount | null> {
    return (
      [...this.accounts.values()].find((a) => a.organizationId === organizationId && a.isDefault) ??
      null
    );
  }

  async save(account: BankAccount): Promise<BankAccount> {
    const existing = this.accounts.get(account.id);
    if (existing && existing.version !== account.version - 1) {
      throw new VersionConflictError(account.version - 1, existing.version);
    }
    this.accounts.set(account.id, account);
    return account;
  }

  async delete(id: EntityId): Promise<void> {
    this.accounts.delete(id);
  }
}
