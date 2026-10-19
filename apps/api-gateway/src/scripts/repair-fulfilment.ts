import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── Repair stalled order fulfilment ─────────────────────────────────────────
 *
 * Fulfilment is idempotent but not a single transaction, so a crash between its
 * writes can leave a charged order without its hold conversion, tickets or
 * ledger entry. This finds such orders in a recent window and finishes them.
 *
 *   pnpm --filter api-gateway repair:fulfilment                 # report only
 *   pnpm --filter api-gateway repair:fulfilment -- --apply      # repair
 *   pnpm --filter api-gateway repair:fulfilment -- --hours 72 --settle-minutes 15 --max 1000
 *
 * Report-only by default. It never changes an order that is not already paid,
 * and every repair step is one fulfilment already uses, so running it twice, or
 * while a webhook is arriving, is safe. Run it against the environment whose
 * Firestore credentials are loaded (STORAGE_DRIVER=firestore).
 */

interface Args {
  apply: boolean;
  hours: number;
  settleMinutes: number;
  max: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, hours: 48, settleMinutes: 10, max: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--apply') args.apply = true;
    else if (token === '--hours' && next) args.hours = Number(argv[++i]);
    else if (token === '--settle-minutes' && next) args.settleMinutes = Number(argv[++i]);
    else if (token === '--max' && next) args.max = Number(argv[++i]);
    else if (token !== '--') throw new Error(`Unknown argument: ${String(token)}`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`--${name} must be a positive number`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const gw = getGatewayConfig();
  if (gw.STORAGE_DRIVER === 'memory') {
    throw new Error(
      'STORAGE_DRIVER=memory has no persistent orders to repair. Point this at the real database.',
    );
  }

  const report = await createV2Services().fulfilmentRepair.sweep({
    lookbackMs: args.hours * 60 * 60 * 1000,
    settleMs: args.settleMinutes * 60 * 1000,
    maxOrders: args.max,
    dryRun: !args.apply,
  });

  console.log(
    `${args.apply ? 'REPAIR' : 'DRY RUN'}: scanned ${String(report.scanned)} paid orders, ` +
      `${String(report.complete)} complete, ${String(report.findings.length)} need attention` +
      (report.truncated ? ' (stopped at --max; there may be more)' : ''),
  );
  for (const finding of report.findings) {
    console.log(
      `  ${finding.orderId}: ${finding.outcome}` +
        (finding.missing.length > 0 ? ` (missing ${finding.missing.join(', ')})` : '') +
        (finding.detail ? ` - ${finding.detail}` : ''),
    );
  }
  if (!args.apply && report.findings.length > 0) {
    console.log('Re-run with --apply to repair the orders above.');
  }
  if (report.findings.some((f) => f.outcome === 'error' || f.outcome === 'still_incomplete')) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
