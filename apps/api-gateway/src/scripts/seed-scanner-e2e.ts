import { createHmac } from 'node:crypto';

import {
  createCoverWallet,
  createEvent,
  createOrganization,
  createTicketTier,
  createVenue,
  issueEntitlements,
} from '@c1rcle/core/domain';

import type { ActorContext } from '@c1rcle/core/application';
import type { PricingBreakdown } from '@c1rcle/core/domain';

import { getGatewayConfig } from '../config/index.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── One-off: seed data for the scanner-app manual E2E walkthrough ──────────
 *
 * Everything here is prefixed `seed_e2e_` so it is identifiable and safe to
 * delete later. This exists because Phase 1's exit criterion
 * (`06-v1-vs-v2-and-rollout.md`) — pair → redeem → scan valid/couple/
 * already-used → offline → recover → search roster → manual check-in →
 * heartbeat — has never actually been run against a real backend, and
 * nothing in this repo could stand a scanner shift up from nothing.
 *
 * Writes real records to whatever `FIRESTORE_PROJECT_ID` `.env.local` points
 * at (currently `c1rcle-v2`) via `services.repos()` directly — the same
 * pattern `seed-platform-admin.ts` and `migrate-and-seed-v1-sample.ts` use.
 * A Better Auth user is created through the real HTTP signup route (not
 * hand-written into Firestore) because password hashing is Better Auth's
 * concern, not something to reimplement here.
 *
 * Usage: `pnpm --filter api-gateway exec tsx src/scripts/seed-scanner-e2e.ts`
 * Requires the gateway to already be running on the URL below (it calls
 * itself over HTTP for the one step — signup — that has to go through a real
 * auth flow).
 */

const GATEWAY_URL = 'http://localhost:8080';
const OWNER_EMAIL = 'seed_e2e_owner@c1rcle.test';
const OWNER_PASSWORD = 'SeedE2E-Owner-2026!';
const ORG_ID = 'seed_e2e_org';
const VENUE_ID = 'seed_e2e_venue';
const EVENT_ID = 'seed_e2e_event';
const TIER_ID = 'seed_e2e_tier';

async function signUpOwner(): Promise<{ userId: string }> {
  const response = await fetch(`${GATEWAY_URL}/api/v2/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      displayName: 'Seed E2E Owner',
    }),
  });
  if (response.status === 201) {
    const body = (await response.json()) as { user: { id: string } };
    return { userId: body.user.id };
  }
  if (response.status === 409 || response.status === 400 || response.status === 422) {
    // Already signed up on a prior run — log in to recover the user id
    // instead of failing, so re-running this script stays idempotent-ish.
    const loginResponse = await fetch(`${GATEWAY_URL}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    if (!loginResponse.ok) {
      throw new Error(
        `Signup returned ${String(response.status)} and recovery login also failed (${String(loginResponse.status)}). Response: ${await response.text()}`,
      );
    }
    const body = (await loginResponse.json()) as { user: { id: string } };
    return { userId: body.user.id };
  }
  throw new Error(`Signup failed: ${String(response.status)} ${await response.text()}`);
}

async function main(): Promise<void> {
  const gateway = getGatewayConfig();
  if (gateway.STORAGE_DRIVER !== 'firestore') {
    throw new Error(
      'STORAGE_DRIVER must be firestore — a memory-driver seed dies with this process.',
    );
  }
  if (!gateway.MAGIC_TICKET_SECRET) {
    throw new Error('MAGIC_TICKET_SECRET must be set to mint a valid wallet QR.');
  }

  console.info('Signing up seed owner via real Better Auth flow…');
  const { userId } = await signUpOwner();
  console.info(`Owner user id: ${userId}`);

  const services = createV2Services();
  const repos = services.repos();
  const now = new Date();

  const org = createOrganization({
    id: ORG_ID,
    name: 'Seed E2E Nightclub',
    slug: 'seed-e2e-nightclub',
    ownerId: userId,
    now,
  });
  await repos.organizations.save(org);
  console.info(`Organization: ${ORG_ID}`);

  const venue = createVenue({
    id: VENUE_ID,
    organizationId: ORG_ID,
    ownerId: userId,
    name: 'Seed E2E Venue',
    slug: 'seed-e2e-venue',
    description: 'Manual E2E walkthrough venue.',
    capacity: 300,
    city: 'Mumbai',
    now,
  });
  await repos.venues.save(venue);
  console.info(`Venue: ${VENUE_ID}`);

  const startAt = now.toISOString();
  const endAt = new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const draftEvent = createEvent({
    id: EVENT_ID,
    organizationId: ORG_ID,
    venueId: VENUE_ID,
    title: 'Seed E2E Walkthrough Night',
    summary: 'Created by seed-scanner-e2e.ts for the manual scanner-app walkthrough.',
    startAt,
    endAt,
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
  console.info(`Event: ${EVENT_ID} (published, starts ${startAt})`);

  const tier = createTicketTier({
    id: TIER_ID,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    name: 'General Entry',
    priceInPaise: 50000,
    quantity: 200,
    now,
  });
  await repos.catalog.saveTier(tier);
  console.info(`Ticket tier: ${TIER_ID}`);

  // `createWalkIn`/`createDineIn` price off a tier with `entryType` exactly
  // 'walkin'/'dinein' (`FirestoreEventCatalogRepository.findWalkInTier`) —
  // a plain ('general') tier does not satisfy either, and doing without
  // these throws "Walk-in/Dine-in tier not configured for this event".
  await repos.catalog.saveTier(
    createTicketTier({
      id: 'seed_e2e_tier_walkin',
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      name: 'Walk-in',
      entryType: 'walkin',
      priceInPaise: 30000,
      quantity: 1000,
      now,
    }),
  );
  await repos.catalog.saveTier(
    createTicketTier({
      id: 'seed_e2e_tier_dinein',
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      name: 'Dine-in',
      entryType: 'dinein',
      priceInPaise: 80000,
      quantity: 200,
      now,
    }),
  );
  console.info('Walk-in and dine-in tiers seeded.');

  // ── Three entitlements covering the three scan-result branches ───────────
  const ticketPricing: PricingBreakdown = {
    lines: [
      {
        tierId: TIER_ID,
        tierName: tier.name,
        quantity: 1,
        unitPricePaise: 50000,
        subtotalPaise: 50000,
      },
    ],
    subtotalPaise: 50000,
    discountPaise: 0,
    discountedSubtotalPaise: 50000,
    platformFeePaise: 7500,
    paymentFeePaise: 1000,
    gstPaise: 0,
    grandTotalPaise: 58500,
    appliedPromoCode: null,
    currency: 'INR',
  };

  const { createOrder } = await import('@c1rcle/core/domain');

  async function seedTicket(
    idSuffix: string,
    guestName: string,
    admitCount: 1 | 2,
    preScan: boolean,
  ): Promise<string> {
    const orderId = `seed_e2e_order_${idSuffix}`;
    let order = createOrder({
      id: orderId,
      eventId: EVENT_ID,
      organizationId: ORG_ID,
      contact: { name: guestName, email: `${idSuffix}@example.test`, phone: '9876543210' },
      pricing: ticketPricing,
      now,
    });
    order = {
      ...order,
      status: 'paid' as const,
      paymentIntentId: `pi_${orderId}`,
      paymentId: `pay_${orderId}`,
      paidAt: now.toISOString(),
    };
    await repos.orders.save(order);
    const [entitlement] = issueEntitlements({
      order,
      now,
      admitsPerUnit: { [TIER_ID]: admitCount },
    });
    if (entitlement === undefined) throw new Error('issueEntitlements produced nothing');
    if (preScan) {
      await repos.entitlements.save({
        ...entitlement,
        status: 'redeemed',
        scanCount: entitlement.scanCountAllowed,
        scannedAt: [now.toISOString()],
      });
    } else {
      await repos.entitlements.save(entitlement);
    }
    return entitlement.id;
  }

  const validTicketId = await seedTicket('valid', 'Seed Valid Guest', 1, false);
  const coupleTicketId = await seedTicket('couple', 'Seed Couple Guest', 2, false);
  const usedTicketId = await seedTicket('used', 'Seed Used Guest', 1, true);
  console.info(`Valid single ticket (never scanned): ${validTicketId}`);
  console.info(`Couple ticket (2 seats, triggers confirmation_required): ${coupleTicketId}`);
  console.info(`Already-used ticket (triggers "already used" denial): ${usedTicketId}`);
  console.info(
    'Type any of the above bare ids into the scanner-app manual code field — no colons means',
  );
  console.info(
    'the server treats it as a legacy non-magic id, which is a valid (non-rotating) lookup path.',
  );

  // ── Cover wallet with two preset items, plus a real signed QR to type in ──
  // The port's `create(input: CoverWalletCreateInput)` signature promises a
  // bare-fields input, but `FirestoreCoverWalletRepository.create` actually
  // reads `.id` straight off whatever it's given with no id-generation step
  // of its own — passing the declared input type (no `id`) fails at runtime
  // with an empty Firestore document path. Pre-constructing the entity with
  // `createCoverWallet()` (which does mint the id) and passing that instead
  // works because it's a structural superset of the declared input type.
  const walletEntity = createCoverWallet({
    userId: `seed_e2e_wallet_guest`,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    venueId: VENUE_ID,
    openingBalance: 200000,
    rules: {
      presetItems: [
        { id: 'seed_item_drink', label: 'Drink', amountPaise: 50000, isAvailable: true },
        { id: 'seed_item_shot', label: 'Shot', amountPaise: 20000, isAvailable: true },
      ],
    },
    now,
  });
  const wallet = await repos.coverWallets.create(walletEntity);
  const windowStart = Math.floor(Date.now() / 1000 / 30) * 30;
  const walletHmac = createHmac('sha256', gateway.MAGIC_TICKET_SECRET)
    .update(`wallet:${wallet.id}:${String(windowStart)}`)
    .digest('hex');
  const walletQr = `cw:${wallet.id}:${String(windowStart)}:${walletHmac}`;
  console.info(`Cover wallet: ${wallet.id} — opening balance ₹2000, 2 preset items`);
  console.info(
    `Wallet QR payload (valid for ~60s from now, re-run this script if it expires): ${walletQr}`,
  );

  // ── Two door codes: one for scan/door-entry/walk-in, one for charging ────
  const ownerActor: ActorContext = {
    userId,
    organizationId: ORG_ID,
    role: 'owner',
    capabilities: ['host', 'venue', 'promoter'],
  };
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const fullCode = await services.scanner.createEventCode(
    { eventId: EVENT_ID, type: 'full', gate: 'north', expiresAt },
    ownerActor,
  );
  const chargeCode = await services.scanner.createEventCode(
    { eventId: EVENT_ID, type: 'charge', gate: 'north', expiresAt },
    ownerActor,
  );
  console.info('');
  console.info('═══ Redeem these in the scanner-app after login/pairing ═══');
  console.info(`Full door code (scan + door entry + walk-in): ${fullCode.code}`);
  console.info(`Charge-only door code (cover-wallet tab):      ${chargeCode.code}`);
  console.info('');
  console.info('═══ Login credentials ═══');
  console.info(`Staff ID / email: ${OWNER_EMAIL}`);
  console.info(`Password:         ${OWNER_PASSWORD}`);
  console.info(
    `Organization ID:  ${ORG_ID}  (only needed if the login screen shows the venue-id field)`,
  );
  console.info('');
  console.info(
    `Reminder: apps/scanner-app/.env's EXPO_PUBLIC_API_BASE_URL must point at ${GATEWAY_URL} for this to work.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
