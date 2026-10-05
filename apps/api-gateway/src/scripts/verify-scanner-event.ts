import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── One-off read-back: verify where create-scanner-event.ts wrote ──────────
 * Prints the resolved Firestore project and reads back the created records so
 * we can confirm they landed in the intended env (c1rcle-v2), not a fallback.
 * READ-ONLY — mutates nothing.
 *
 * Usage (from repo root — tsx resolves the env file relative to cwd):
 *   pnpm --filter api-gateway exec tsx --env-file-if-exists=apps/api-gateway/.env.local src/scripts/verify-scanner-event.ts
 */
const ORG_ID = '0nP5KOWso3Hgyvs5OSCb';
const VENUE_ID = 'doorcode_20261003_venue';
const EVENT_ID = 'doorcode_20261003_event';
const DOOR_CODE = 'C1R-62WACHZ9';

async function main(): Promise<void> {
  const gateway = getGatewayConfig();
  console.info(
    `Target project: ${gateway.FIRESTORE_PROJECT_ID} (driver ${gateway.STORAGE_DRIVER})`,
  );
  if (gateway.FIRESTORE_PROJECT_ID !== 'c1rcle-v2') {
    throw new Error('Refusing to read back: resolved project is not c1rcle-v2.');
  }

  const repos = createV2Services().repos();

  const org = await repos.organizations.getById(ORG_ID);
  console.info(`org:    ${ORG_ID} — ${org?.name ?? 'NOT FOUND'}`);

  const venue = await repos.venues.getById(VENUE_ID);
  console.info(`venue:  ${VENUE_ID} — ${venue?.public.name ?? 'NOT FOUND'}`);

  const event = await repos.events.findById(EVENT_ID);
  console.info(
    `event:  ${EVENT_ID} — ${event?.title ?? 'NOT FOUND'} | start ${event?.startAt} end ${event?.endAt}`,
  );

  const code = await repos.eventCodes.findByCode(DOOR_CODE);
  if (code === null) {
    console.info(`code:   ${DOOR_CODE} — NOT FOUND`);
    return;
  }
  console.info(
    `code:   ${code.code} | status ${code.status} | type ${code.type} | gate ${String(code.gate)}`,
  );
  console.info(
    `        event ${code.eventId} | venue ${String(code.venueId)} | org ${code.organizationId}`,
  );
  console.info(`        expires ${code.expiresAt} | created ${code.createdAt}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
