import { describe, expect, it } from 'vitest';

import { VersionConflictError } from '../../domain/errors.js';
import { decryptField, encryptField } from '../../infrastructure/encryption.js';
import { MemoryBankAccountRepository } from '../../infrastructure/memory/memory-bank-account-repository.js';

import { migrateBankAccountKeys } from './bank-account-key-migration.js';

import type { BankAccount } from '../../domain/models/bank-account.js';

const legacy = { secret: 'legacy-secret', salt: 'legacy-salt' };
const current = { secret: 'current-secret-that-is-long-enough-0123456789', salt: 'current-salt' };
const keys = { current, legacy };

const NOW = new Date('2026-10-11T00:00:00.000Z');

function account(
  id: string,
  orgId: string,
  key: { secret: string; salt: string } | null,
): BankAccount {
  return {
    id,
    organizationId: orgId,
    bankName: 'HDFC',
    accountHolder: 'A',
    last4: '7890',
    encryptedAccountNumber: key ? encryptField('00001234567890', key.secret, key.salt, orgId) : '',
    ifscCode: 'HDFC0001234',
    isDefault: true,
    verified: true,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

async function seed(repo: MemoryBankAccountRepository, accounts: BankAccount[]) {
  for (const a of accounts) await repo.create(a);
}

describe('migrateBankAccountKeys', () => {
  it('migrates legacy-sealed numbers, leaves current ones, and reports the rest', async () => {
    const repo = new MemoryBankAccountRepository();
    await seed(repo, [
      account('a1', 'org_1', legacy),
      account('a2', 'org_2', current),
      account('a3', 'org_3', null),
      account('a4', 'org_4', { secret: 'unknown', salt: 'x' }),
    ]);

    const report = await migrateBankAccountKeys({
      bankAccounts: repo,
      keys,
      apply: true,
      now: () => NOW,
    });

    expect(report).toMatchObject({
      total: 4,
      migrated: 1,
      alreadyCurrent: 1,
      withoutNumber: 1,
      skippedConcurrent: 0,
      unreadableIds: ['a4'],
    });
    const migrated = await repo.findById('a1');
    // Same plaintext, now under the current key, bound to the same organisation, version bumped.
    expect(
      decryptField(migrated?.encryptedAccountNumber ?? '', current.secret, current.salt, 'org_1'),
    ).toBe('00001234567890');
    expect(() =>
      decryptField(migrated?.encryptedAccountNumber ?? '', legacy.secret, legacy.salt, 'org_1'),
    ).toThrow();
    expect(migrated?.version).toBe(2);
    // The unreadable one is untouched.
    expect((await repo.findById('a4'))?.version).toBe(1);
  });

  it('writes nothing in a dry run, but reports what it would do', async () => {
    const repo = new MemoryBankAccountRepository();
    const original = account('a1', 'org_1', legacy);
    await seed(repo, [original]);

    const report = await migrateBankAccountKeys({ bankAccounts: repo, keys, apply: false });

    expect(report.migrated).toBe(1);
    expect(await repo.findById('a1')).toEqual(original);
  });

  it('is idempotent: a second run migrates nothing', async () => {
    const repo = new MemoryBankAccountRepository();
    await seed(repo, [account('a1', 'org_1', legacy), account('a2', 'org_2', legacy)]);

    const first = await migrateBankAccountKeys({
      bankAccounts: repo,
      keys,
      apply: true,
      now: () => NOW,
    });
    const second = await migrateBankAccountKeys({
      bankAccounts: repo,
      keys,
      apply: true,
      now: () => NOW,
    });

    expect(first.migrated).toBe(2);
    expect(second).toMatchObject({ migrated: 0, alreadyCurrent: 2, unreadableIds: [] });
  });

  it('skips, rather than overwrites, an account changed since it was read', async () => {
    const repo = new MemoryBankAccountRepository();
    await seed(repo, [account('a1', 'org_1', legacy)]);
    const realSave = repo.save.bind(repo);
    repo.save = async () => {
      throw new VersionConflictError(1, 2);
    };

    const report = await migrateBankAccountKeys({
      bankAccounts: repo,
      keys,
      apply: true,
      now: () => NOW,
    });
    repo.save = realSave;

    expect(report).toMatchObject({ migrated: 0, skippedConcurrent: 1 });
    // Left exactly as it was: still readable with the legacy key.
    const untouched = await repo.findById('a1');
    expect(
      decryptField(untouched?.encryptedAccountNumber ?? '', legacy.secret, legacy.salt, 'org_1'),
    ).toBe('00001234567890');
  });

  it('propagates an unexpected write failure instead of hiding it', async () => {
    const repo = new MemoryBankAccountRepository();
    await seed(repo, [account('a1', 'org_1', legacy)]);
    repo.save = async () => {
      throw new Error('firestore unavailable');
    };
    await expect(migrateBankAccountKeys({ bankAccounts: repo, keys, apply: true })).rejects.toThrow(
      'firestore unavailable',
    );
  });

  it('never exposes an account number in its report', async () => {
    const repo = new MemoryBankAccountRepository();
    await seed(repo, [
      account('a1', 'org_1', legacy),
      account('a4', 'org_4', { secret: 'u', salt: 'x' }),
    ]);
    const report = await migrateBankAccountKeys({ bankAccounts: repo, keys, apply: true });
    expect(JSON.stringify(report)).not.toContain('00001234567890');
  });
});
