import { VersionConflictError } from '../../domain/errors.js';
import { reencryptField } from '../../infrastructure/encryption.js';

import type { BankAccountRepository } from '../../domain/ports/repositories.js';
import type { FieldKey } from '../../infrastructure/encryption.js';

/**
 * Moves stored bank-account numbers from the legacy (published) encryption key to
 * the configured one. See `apps/api-gateway/src/scripts/reencrypt-bank-accounts.ts`
 * for how it is run.
 *
 * Idempotent and safe to interrupt: each account is re-sealed independently, with
 * its own organisation as the encryption context (so it stays bound to that
 * record), and written through the repository's version check — an account that
 * changed since it was read is skipped, never overwritten. Account numbers are
 * never returned or logged; the report holds counts and record ids only.
 */
export interface BankAccountKeyMigrationReport {
  total: number;
  /** No stored number (nothing to migrate). */
  withoutNumber: number;
  /** Already readable under the current key. */
  alreadyCurrent: number;
  /** Re-sealed under the current key (or, in a dry run, would be). */
  migrated: number;
  /** Changed by someone else between read and write; left as it was. */
  skippedConcurrent: number;
  /** Opens under neither key: corrupt or sealed with some other secret. Not touched. */
  unreadableIds: string[];
}

export async function migrateBankAccountKeys(input: {
  bankAccounts: BankAccountRepository;
  keys: { current: FieldKey; legacy: FieldKey };
  /** `false` reports what would change and writes nothing. */
  apply: boolean;
  now?: () => Date;
}): Promise<BankAccountKeyMigrationReport> {
  const { bankAccounts, keys, apply } = input;
  const now = input.now ?? (() => new Date());
  const report: BankAccountKeyMigrationReport = {
    total: 0,
    withoutNumber: 0,
    alreadyCurrent: 0,
    migrated: 0,
    skippedConcurrent: 0,
    unreadableIds: [],
  };

  for (const account of await bankAccounts.listAll()) {
    report.total += 1;
    if (!account.encryptedAccountNumber) {
      report.withoutNumber += 1;
      continue;
    }
    const result = reencryptField(account.encryptedAccountNumber, account.organizationId, keys);
    if (result.status === 'current') {
      report.alreadyCurrent += 1;
    } else if (result.status === 'unreadable') {
      report.unreadableIds.push(account.id);
    } else if (!apply) {
      report.migrated += 1;
    } else {
      try {
        await bankAccounts.save({
          ...account,
          encryptedAccountNumber: result.envelope,
          version: account.version + 1,
          updatedAt: now().toISOString(),
        });
        report.migrated += 1;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        report.skippedConcurrent += 1;
      }
    }
  }
  return report;
}
