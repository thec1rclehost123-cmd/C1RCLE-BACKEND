import { migrateBankAccountKeys } from '@c1rcle/core/application';
import { LEGACY_BANK_ENCRYPTION_SALT, LEGACY_BANK_ENCRYPTION_SECRET } from '@c1rcle/core/config';

import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── Re-encrypt bank-account numbers under the real ENCRYPTION_KEY ───────────
 *
 * Before `ENCRYPTION_KEY` was wired through, bank-account numbers were sealed
 * with a secret that is published in this repository. They stay readable (the
 * service falls back to that legacy key), but they are only as protected as that
 * constant. This moves each one under the configured key.
 *
 * Usage:
 *
 *   pnpm --filter api-gateway reencrypt:bank-accounts            # dry run (default)
 *   pnpm --filter api-gateway reencrypt:bank-accounts -- --apply # write the changes
 *
 * The default is a dry run. It is idempotent (a second run migrates nothing),
 * skips any record that changed while it ran, and prints counts and record ids
 * only — never an account number. Logic and its tests: core
 * `application/finance/bank-account-key-migration.ts`.
 *
 * Back up `ENCRYPTION_KEY` before running with --apply: migrated records can no
 * longer be read with the legacy default.
 */
async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  const gateway = getGatewayConfig();

  if (gateway.STORAGE_DRIVER === 'memory') {
    throw new Error('STORAGE_DRIVER=memory has no persisted bank accounts to migrate.');
  }
  const secret = gateway.ENCRYPTION_KEY;
  if (!secret || secret === LEGACY_BANK_ENCRYPTION_SECRET) {
    throw new Error(
      'Set ENCRYPTION_KEY to a real secret first: re-encrypting under the published default would change nothing.',
    );
  }

  const report = await migrateBankAccountKeys({
    bankAccounts: createV2Services().repos().bankAccounts,
    keys: {
      current: { secret, salt: gateway.ENCRYPTION_SALT ?? LEGACY_BANK_ENCRYPTION_SALT },
      legacy: { secret: LEGACY_BANK_ENCRYPTION_SECRET, salt: LEGACY_BANK_ENCRYPTION_SALT },
    },
    apply,
  });

  console.info(
    `${apply ? 'APPLIED' : 'DRY RUN (nothing written)'} — v2_bank_accounts: ${report.total} records, ` +
      `${report.alreadyCurrent} already under the current key, ` +
      `${report.migrated} ${apply ? 'migrated' : 'would be migrated'}, ` +
      `${report.withoutNumber} without a stored number, ` +
      `${report.skippedConcurrent} skipped (changed concurrently), ` +
      `${report.unreadableIds.length} unreadable.`,
  );
  if (report.unreadableIds.length > 0) {
    console.warn(
      `Unreadable under both keys (investigate; not migrated): ${report.unreadableIds.join(', ')}`,
    );
    process.exitCode = 1;
  }
  if (!apply && report.migrated > 0) console.info('Re-run with --apply to write the changes.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
