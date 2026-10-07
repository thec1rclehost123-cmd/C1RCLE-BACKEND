import { createEvent, createTicketTier, createVenue } from '@c1rcle/core/domain';

import type { ActorContext } from '@c1rcle/core/application';

import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── One-off: create a scanner test event + door code ────────────────────────
 *
 * Recreates the earlier throwaway "event-creator" dev script that was lost
 * locally. Semantics are identical to `seed-scanner-e2e.ts` (writes real
 * records to whatever FIRESTORE_PROJECT_ID `.env.local` points at — currently
 * `c1rcle-v2` — via `services.repos()`), but the event targets the existing
 * partner test org ("Anil Venue One") instead of a fresh seed org.
 *
 * The one thing that CHANGED vs the original script: the event's startAt is
 * `15:30:00.000Z` (21:00 IST) — the original wrongly used `21:00:00.000Z`,
 * which is 02:30 IST the next day. Everything is `doorcode_20261003_`-prefixed
 * so re-runs (with a new date) never collide with prior records.
 *
 * Usage: `pnpm --filter api-gateway exec tsx --env-file-if-exists=.env.local src/scripts/create-scanner-event.ts`
 */
const OWNER_USER_ID = 'lmwqDUh54w2PFEd6tmLJ'; // anilvenue1@yopmail.com — Anil Venue One
const ORG_MATCH = 'anil venue one';

// 2026-10-03 is a Saturday. 15:30Z == 21:00 IST — the intended door-open time.
const EVENT_DATE = '2026-10-03';
const START_AT = `${EVENT_DATE}T15:30:00.000Z`;
const END_AT = `${EVENT_DATE}T23:30:00.000Z`;
const PREFIX = 'doorcode_20261003';

async function main(): Promise<void> {
  const gateway = getGatewayConfig();
  if (gateway.STORAGE_DRIVER !== 'firestore') {
    throw new Error(
      'STORAGE_DRIVER must be firestore — a memory-driver seed dies with this process.',
    );
  }

  const services = createV2Services();
  const repos = services.repos();
  const now = new Date();

  // ── Resolve the partner test org from the known owner user id ──────────────
  const page = await repos.organizations.listForMember(OWNER_USER_ID, { limit: 25 });
  const org = page.items.find((o) => o.name.toLowerCase().includes(ORG_MATCH)) ?? page.items[0];
  if (org === undefined) {
    throw new Error(
      `Owner ${OWNER_USER_ID} belongs to no organizations (checked ${page.items.length} rows).`,
    );
  }
  console.info(`Organization: ${org.id} — ${org.name}`);

  // ── Fresh test venue under that org (never touches the partner's real one) ─
  const venue = createVenue({
    id: `${PREFIX}_venue`,
    organizationId: org.id,
    ownerId: OWNER_USER_ID,
    name: 'Door Code Test Venue',
    slug: `${PREFIX}-venue`,
    description: 'Created by create-scanner-event.ts for scanner-app dev.',
    capacity: 500,
    city: 'Mumbai',
    now,
  });
  await repos.venues.save(venue);
  console.info(`Venue: ${venue.id}`);

  // ── The event — startAt 15:30:00.000Z = 21:00 IST (the fixed value) ───────
  const draftEvent = createEvent({
    id: `${PREFIX}_event`,
    organizationId: org.id,
    venueId: venue.id,
    title: 'Door Code Test Night',
    summary: 'Scanner-app dev event — created with the corrected 15:30Z startAt.',
    startAt: START_AT,
    endAt: END_AT,
    capacity: 500,
    now,
  });
  const event = {
    ...draftEvent,
    status: 'published' as const,
    isPublic: true,
    startingPricePaise: 50000,
    isFree: false,
  };
  await repos.events.save(event);
  console.info(`Event: ${event.id} — starts ${START_AT} (15:30Z = 21:00 IST), ends ${END_AT}`);

  // ── Tiers (general + walkin + dinein; walkin/dinein are required by the
  //    door's walk-in flow — see seed-scanner-e2e.ts note) ────────────────────
  await repos.catalog.saveTier(
    createTicketTier({
      id: `${PREFIX}_tier`,
      eventId: event.id,
      organizationId: org.id,
      name: 'General Entry',
      priceInPaise: 50000,
      quantity: 500,
      now,
    }),
  );
  await repos.catalog.saveTier(
    createTicketTier({
      id: `${PREFIX}_tier_walkin`,
      eventId: event.id,
      organizationId: org.id,
      name: 'Walk-in',
      entryType: 'walkin',
      priceInPaise: 30000,
      quantity: 1000,
      now,
    }),
  );
  await repos.catalog.saveTier(
    createTicketTier({
      id: `${PREFIX}_tier_dinein`,
      eventId: event.id,
      organizationId: org.id,
      name: 'Dine-in',
      entryType: 'dinein',
      priceInPaise: 80000,
      quantity: 200,
      now,
    }),
  );
  console.info('Tiers: general / walk-in / dine-in seeded.');

  // ── Mint the door code (full: scan + door entry + walk-in at the door) ─────
  const ownerActor: ActorContext = {
    userId: OWNER_USER_ID,
    organizationId: org.id,
    role: 'owner',
    capabilities: ['host', 'venue', 'promoter'],
  };
  const code = await services.scanner.createEventCode(
    { eventId: event.id, type: 'full', gate: 'main', expiresAt: END_AT },
    ownerActor,
  );
  console.info('');
  console.info('═══ Scanner door code ═══');
  console.info(`Code:      ${code.code}`);
  console.info(`Type:      ${code.type} (gate: ${code.gate})`);
  console.info(`Expires:   ${code.expiresAt}`);
  console.info(`Scans usd: ${code.stats.scansCount}`);
  console.info('');
  console.info('═══ Context ═══');
  console.info(`org:  ${org.id}`);
  console.info(`venue: ${venue.id}`);
  console.info(`event: ${event.id}`);
  console.info(
    `Reminder: apps/scanner-app/.env EXPO_PUBLIC_ORGANIZATION_ID must be this org id, and EXPO_PUBLIC_API_BASE_URL must point at the gateway.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
