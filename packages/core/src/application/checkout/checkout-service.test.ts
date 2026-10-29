import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidOperationError,
  TicketTierNotFoundError,
  UnauthorizedError,
} from '../../domain/errors.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { createGuestProfile } from '../../domain/models/guest-profile.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryGuestProfileRepository } from '../../infrastructure/memory/memory-guest-profile-repository.js';
import { MemoryLeaderboardRepository } from '../../infrastructure/memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryOutboxStore } from '../../infrastructure/memory/memory-outbox-store.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { MemoryUserAccountRepository } from '../../infrastructure/memory/memory-user-account-repository.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { admitsForTier, CheckoutService, rsvpOrderId } from './checkout-service.js';

import type { TicketTier } from '../../domain/models/event-catalog.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── CheckoutService.createRsvp over the memory driver ───────────────────────
 * Pins the RSVP rules directly: auth required, free-event + zero-price-tier
 * eligibility (including legacy tier docs that predate `priceInPaise`), one
 * RSVP per user per event with id/slug convergence, and unpublished-event
 * rejection. The HTTP layer is covered separately in
 * `apps/api-gateway/.../rsvp/rsvp-routes.test.ts`.
 */

const NOW = new Date('2026-09-22T00:00:00.000Z');

const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'test-project' },
  clock: { now: () => NOW },
  features: { m5EligibilityRulesEnabled: true },
});

const actor = (userId: string): ActorContext => ({
  userId,
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
});

function buildService(serviceConfig = config) {
  const events = new MemoryEventRepository();
  const catalog = new MemoryEventCatalogRepository();
  const orders = new MemoryOrderRepository();
  const entitlements = new MemoryEntitlementRepository();
  const carts = new MemoryCartReservationRepository();
  const guestProfiles = new MemoryGuestProfileRepository();
  const users = new MemoryUserAccountRepository();
  const outbox = new MemoryOutboxStore();
  for (const id of ['user_1', 'user_2']) {
    users.save({
      id,
      email: `${id}@example.test`,
      name: id,
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    });
  }
  const deps = {
    config: serviceConfig,
    outbox,
    pricing: new PricingService({ eventCatalog: catalog }),
    inventory: new InventoryService({
      eventCatalog: catalog,
      cartReservation: carts,
      order: orders,
    }),
    repositories: {
      events,
      catalog,
      cartReservations: carts,
      orders,
      entitlements,
      guestProfiles,
      users,
      ledger: new MemoryLedgerRepository(),
      financialJournals: new MemoryFinancialJournalRepository(),
      leaderboard: new MemoryLeaderboardRepository(),
    },
  } as unknown as ServiceDeps;
  return {
    deps,
    outbox,
    events,
    catalog,
    orders,
    guestProfiles,
    users,
    service: new CheckoutService(deps),
  };
}

async function seedPublishedFreeEvent(
  events: MemoryEventRepository,
  eventId = 'evt_1',
): Promise<void> {
  let event = createEvent({
    id: eventId,
    organizationId: 'org_1',
    venueId: 'ven_1',
    title: 'RSVP Night',
    startAt: '2026-09-27T21:00:00.000Z',
  });
  for (const to of ['review', 'scheduled', 'published'] as const) {
    event = transitionEvent(event, to, NOW);
  }
  // Fresh-row save expects version 1 (casSet) — the transitions above only
  // prove the published status, not the version chain.
  await events.save({ ...event, version: 1 });
}

function seedTier(
  catalog: MemoryEventCatalogRepository,
  overrides: Partial<TicketTier> = {},
): TicketTier {
  const tier = createTicketTier({
    id: 'tier_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    name: 'General Admission',
    accessType: 'RSVP',
    quantity: 10,
    ...overrides,
  });
  void catalog.saveTier(tier);
  return tier;
}

/** The exact legacy shape found in production Firestore (no `priceInPaise`). */
function seedLegacyFreeTier(catalog: MemoryEventCatalogRepository): void {
  const modern = createTicketTier({
    id: 'tier_legacy',
    eventId: 'evt_1',
    organizationId: 'org_1',
    name: 'General Admission',
    accessType: 'RSVP',
    quantity: 250,
  });
  const legacy = {
    ...modern,
    priceInPaise: undefined,
    doorPriceInPaise: null,
    accessType: 'RSVP',
  } as unknown as TicketTier;
  void catalog.saveTier(legacy);
}

describe('CheckoutService.createRsvp', () => {
  it('requires an eligibility attestation without collecting attendee demographics', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { audienceType: 'FEMALE', minAge: 21 });

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
    await expect(
      service.quote({
        actor: actor('user_1'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_1', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);

    const { order, entitlements } = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_1',
      eligibilityAttested: true,
    });
    expect(order.lines[0]?.eligibility).toMatchObject({
      audienceType: 'FEMALE',
      minAge: 21,
      maxAge: null,
      attested: true,
    });
    expect(order.lines[0]?.eligibility).not.toHaveProperty('gender');
    expect(order.lines[0]?.eligibility).not.toHaveProperty('dateOfBirth');
    expect(entitlements[0]?.eligibility).toEqual(order.lines[0]?.eligibility);

    const quote = await service.quote({
      actor: actor('user_2'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_1', quantity: 1, eligibilityAttested: true }],
    });
    const hold = await service.createHold({
      actor: actor('user_2'),
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: [
        {
          tierId: 'tier_1',
          tierName: 'General Admission',
          quantity: 1,
          unitPricePaise: 0,
          eligibilityAttested: true,
        },
      ],
      pricing: quote.pricing,
      appliedPromoCode: null,
      attribution: quote.attribution,
      idempotencyKey: 'eligible-hold',
    });
    expect(hold.lines[0]?.eligibility).toMatchObject({
      audienceType: 'FEMALE',
      minAge: 21,
      maxAge: null,
      attested: true,
    });
  });

  it('keeps restricted eligibility sales blocked when the approval gate is off', async () => {
    const restrictedConfig = createCoreConfig({
      redis: { url: 'redis://localhost:6379' },
      firestore: { projectId: 'test-project' },
      clock: { now: () => NOW },
      features: { m5EligibilityRulesEnabled: false },
    });
    const { events, catalog, service } = buildService(restrictedConfig);
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { audienceType: 'STUDENT' });

    await expect(
      service.quote({
        actor: actor('user_1'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_1', quantity: 1, eligibilityAttested: true }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.createRsvp({
        actor: actor('user_1'),
        eventId: 'evt_1',
        tierId: 'tier_1',
        eligibilityAttested: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('uses the authenticated Guest profile name without storing email or phone', async () => {
    const { events, catalog, guestProfiles, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);
    await guestProfiles.save(
      createGuestProfile('user_1', {
        displayName: 'M3 RSVP Buyer',
        dateOfBirth: '2000-01-01',
        city: 'Pune',
        tastes: ['Music'],
        intents: ['Meet people'],
        now: NOW,
      }),
    );

    const { order, entitlements } = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_1',
    });

    expect(order.contact).toEqual({ name: 'M3 RSVP Buyer', email: '', phone: '' });
    expect(entitlements[0]?.holderName).toBe('M3 RSVP Buyer');
  });

  it('fulfills a legacy tier doc without priceInPaise (production shape)', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedLegacyFreeTier(catalog);

    const { order, entitlements } = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_legacy',
    });

    expect(order.status).toBe('paid');
    expect(order.userId).toBe('user_1');
    expect(order.grandTotalPaise).toBe(0);
    expect(order.paymentIntentId).toBeNull();
    expect(order.paymentId).toBe(order.id);
    expect(order.lines).toHaveLength(1);
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]).toMatchObject({ orderId: order.id, status: 'valid' });
  });

  it('writes one durable, role-explicit issuance event per RSVP entitlement', async () => {
    const { events, catalog, service, outbox } = buildService();
    await seedPublishedFreeEvent(events);
    seedLegacyFreeTier(catalog);

    const first = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_legacy',
    });
    const issuanceEvents = (await outbox.listPending()).filter(
      (row) => row.type === 'ticket.issued',
    );
    expect(issuanceEvents).toHaveLength(1);
    expect(issuanceEvents[0]?.payload).toMatchObject({
      type: 'ticket.issued',
      payload: {
        entitlementId: first.entitlements[0]?.id,
        orderId: first.order.id,
        eventId: 'evt_1',
        purchaserUserId: 'user_1',
        holderUserId: 'user_1',
      },
    });
  });

  it('rejects a legacy tier whose door price is non-zero', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    const modern = createTicketTier({
      id: 'tier_door_paid',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Door Paid',
      priceInPaise: 1000,
      quantity: 10,
    });
    const legacy = {
      ...modern,
      priceInPaise: undefined,
      doorPriceInPaise: 5000,
    } as unknown as TicketTier;
    await catalog.saveTier(legacy);

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_door_paid' }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('rejects group-shaped free RSVP tiers until every attendee has an identity-bound claim', async () => {
    const { events, catalog, orders, service } = buildService();
    await seedPublishedFreeEvent(events);
    const rsvpTier = createTicketTier({
      id: 'tier_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Legacy group RSVP',
      accessType: 'RSVP',
      quantity: 10,
    });
    // Simulate a legacy or manually corrupted stored row that predates the
    // current domain-level guard against group-shaped free RSVP tiers.
    await catalog.saveTier({ ...rsvpTier, guestCount: 2 });

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toThrow(/individually verified attendee claim/);
    await expect(orders.getById(rsvpOrderId('evt_1', 'user_1'))).resolves.toBeNull();
  });

  it('rejects unauthenticated and system actors', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);

    await expect(
      service.createRsvp({ actor: actor(''), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      service.createRsvp({
        actor: { ...actor('x'), userId: 'system:internal' },
        eventId: 'evt_1',
        tierId: 'tier_1',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('requires a persisted verified account and fails closed when it is missing', async () => {
    const { events, catalog, users, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);
    users.save({
      id: 'unverified',
      email: 'unverified@example.test',
      name: 'Unverified',
      image: null,
      emailVerified: false,
      role: 'guest',
      createdAt: NOW.getTime(),
      updatedAt: NOW.getTime(),
    });

    await expect(
      service.createRsvp({ actor: actor('unverified'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.createRsvp({ actor: actor('missing'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('does not issue a restricted RSVP without an access grant', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);
    const tier = await catalog.getTierById('tier_1');
    expect(tier).not.toBeNull();
    if (!tier) return;
    await catalog.saveTier({ ...tier, accessMode: 'invited', version: tier.version + 1 });

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(TicketTierNotFoundError);
  });

  it('blocks paid quote and free RSVP on a private event without its event grant', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);
    const event = await events.getById('evt_1');
    expect(event).not.toBeNull();
    if (!event) return;
    await events.save({
      ...event,
      visibilityMode: 'code',
      isPublic: false,
      version: event.version + 1,
    });

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(TicketTierNotFoundError);
    await expect(
      service.quote({
        actor: actor('user_1'),
        eventId: 'evt_1',
        lines: [{ tierId: 'tier_1', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(TicketTierNotFoundError);
  });

  it('rejects a second RSVP and converges id and slug callers on one order', async () => {
    const { events, catalog, orders, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog);

    const first = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_1',
    });
    // The guest portal addresses events by slug — same user via slug hits the
    // same deterministic order, not a second ticket.
    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'rsvp-night', tierId: 'tier_1' }),
    ).rejects.toBeInstanceOf(ConflictError);

    const page = await orders.listByUser('user_1', { limit: 100 });
    expect(page.items).toHaveLength(1);
    expect(first.order.id).toBe(rsvpOrderId('evt_1', 'user_1'));
  });

  it('rejects unpublished events', async () => {
    const { events, catalog, service } = buildService();
    await events.save(
      createEvent({
        id: 'evt_draft',
        organizationId: 'org_1',
        venueId: 'ven_1',
        title: 'Draft Night',
        startAt: '2026-09-27T21:00:00.000Z',
      }),
    );
    const tier = createTicketTier({
      id: 'tier_draft',
      eventId: 'evt_draft',
      organizationId: 'org_1',
      name: 'General Admission',
      accessType: 'RSVP',
      quantity: 10,
    });
    await catalog.saveTier(tier);

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_draft', tierId: 'tier_draft' }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});

describe('admitsForTier (D4 — headcount comes from tier metadata, not a default of 1)', () => {
  it('admits 2 for a couple tier via guestCount', () => {
    expect(admitsForTier({ guestCount: 2, entryType: 'general' })).toBe(2);
  });

  it('admits 2 for a couple entryType when guestCount is absent', () => {
    expect(admitsForTier({ entryType: 'couple' })).toBe(2);
  });

  it('guestCount wins over entryType', () => {
    expect(admitsForTier({ guestCount: 4, entryType: 'couple' })).toBe(4);
  });

  it('admits 1 for a general tier and for an unknown/missing tier', () => {
    expect(admitsForTier({ entryType: 'general' })).toBe(1);
    expect(admitsForTier(undefined)).toBe(1);
    expect(admitsForTier(null)).toBe(1);
  });
});
