import { refreshAnalyticsReadModel } from '@c1rcle/core';

import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── Backfill the analytics read model (B11) ─────────────────────────────────
 *
 * Runs one full pass over every organization and every event, recomputing and
 * storing each read-model row. The live gateway reconciles a row when an
 * event's lifecycle changes and sweeps the rest on an interval; this is for a
 * database that predates the projection, or right after a schema change to what
 * a row holds — the same function the periodic refresh calls, run once by hand.
 *
 * Usage:
 *
 *   pnpm --filter api-gateway backfill:analytics
 *
 * Reads are pure and the writes are upserts, so the pass is safe to re-run and
 * safe to run against a live database (a concurrent request keeps its fallback
 * until a row exists — see `AnalyticsService`).
 */

async function main(): Promise<void> {
  const gateway = getGatewayConfig();

  if (gateway.STORAGE_DRIVER === 'memory') {
    // A memory-driver backfill projects into a store that dies with this
    // process — it would report success and change nothing.
    throw new Error(
      'STORAGE_DRIVER=memory would backfill an in-memory store that dies with this ' +
        'process. Set STORAGE_DRIVER=firestore (with credentials) to backfill real data.',
    );
  }

  const services = createV2Services();
  const repos = services.repos();

  const result = await refreshAnalyticsReadModel({
    analytics: services.analytics,
    events: repos.events,
    organizations: repos.organizations,
    logger: {
      info: (message, fields) => console.info(message, fields ?? {}),
      warn: (message, fields) => console.warn(message, fields ?? {}),
      error: (message, fields) => console.error(message, fields ?? {}),
    },
  });

  console.info(
    `Backfilled ${result.events} event row(s) and ${result.organizations} organization row(s)` +
      (result.failures > 0 ? `, ${result.failures} failure(s) — see the log above.` : '.'),
  );

  if (result.failures > 0) {
    // A non-zero exit so an operator/CI notices, even though the rows that did
    // project are committed.
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
