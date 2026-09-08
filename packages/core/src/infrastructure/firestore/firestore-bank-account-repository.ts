import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type { BankAccount } from '../../domain/models/bank-account.js';
import type { BankAccountRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const BANK_ACCOUNT_COLLECTION = 'v2_bank_accounts';

export class FirestoreBankAccountRepository implements BankAccountRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(BANK_ACCOUNT_COLLECTION);
  }

  async create(account: BankAccount): Promise<BankAccount> {
    await this.collection.doc(account.id).set(toDoc(account));
    return account;
  }

  async findById(id: EntityId): Promise<BankAccount | null> {
    const snap = await this.collection.doc(id).get();
    const data = snap.data();
    return data ? toAccount(data) : null;
  }

  async listByOrganization(organizationId: EntityId): Promise<BankAccount[]> {
    const snap = await this.collection.where('organizationId', '==', organizationId).get();
    return snap.docs.map((doc) => toAccount(doc.data()));
  }

  async findDefaultByOrganization(organizationId: EntityId): Promise<BankAccount | null> {
    const snap = await this.collection
      .where('organizationId', '==', organizationId)
      .where('isDefault', '==', true)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return doc ? toAccount(doc.data()) : null;
  }

  async save(account: BankAccount): Promise<BankAccount> {
    const ref = this.collection.doc(account.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data();
      if (data) {
        const existing = toAccount(data);
        if (existing.version !== account.version - 1) {
          throw new VersionConflictError(account.version - 1, existing.version);
        }
      }
      tx.set(ref, toDoc(account));
      return account;
    });
  }

  async delete(id: EntityId): Promise<void> {
    await this.collection.doc(id).delete();
  }
}

function toDoc(account: BankAccount): DocumentData {
  return {
    id: account.id,
    organizationId: account.organizationId,
    bankName: account.bankName,
    accountHolder: account.accountHolder,
    last4: account.last4,
    encryptedAccountNumber: account.encryptedAccountNumber,
    ifscCode: account.ifscCode,
    isDefault: account.isDefault,
    verified: account.verified,
    version: account.version,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function toAccount(data: DocumentData): BankAccount {
  return {
    id: data.id as string,
    organizationId: data.organizationId as string,
    bankName: data.bankName as string,
    accountHolder: data.accountHolder as string,
    last4: data.last4 as string,
    encryptedAccountNumber: data.encryptedAccountNumber as string,
    ifscCode: data.ifscCode as string,
    isDefault: data.isDefault as boolean,
    verified: data.verified as boolean,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}
