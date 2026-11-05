import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import {
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
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';
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
  const entitlements = new MemoryEntitlementRepository();
  const carts = new MemoryCartReservationRepository();
  const orders = new MemoryOrderRepository({ catalog, carts, entitlements, events });
  catalog.inventoryClaims = { orders, carts };
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
      providerPayments: new MemoryProviderPaymentRepository(),
      leaderboard: new MemoryLeaderboardRepository(),
    },
  } as unknown as ServiceDeps;
  orders.fulfilmentStore = {
    carts,
    events,
    entitlements: deps.repositories.entitlements as MemoryEntitlementRepository,
    ledger: deps.repositories.ledger as MemoryLedgerRepository,
    journals: deps.repositories.financialJournals as MemoryFinancialJournalRepository,
    outbox: deps.outbox as MemoryOutboxStore,
    providerPayments: deps.repositories.providerPayments as MemoryProviderPaymentRepository,
  };
  (deps.repositories.entitlements as MemoryEntitlementRepository).issuanceOutbox =
    deps.outbox as MemoryOutboxStore;
  (deps.repositories.entitlements as MemoryEntitlementRepository).admissionOrders = orders;

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
  it('fulfills a zero-price RSVP tier on an event that also has paid entry', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    const event = await events.getById('evt_1');
    if (!event) throw new Error('Missing seeded event');
    await events.save({
      ...event,
      isFree: false,
      startingPricePaise: 50_000,
      version: event.version + 1,
    });
    seedTier(catalog);
    const result = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_1',
    });
    expect(result.order.status).toBe('paid');
    expect(result.order.lines[0]?.quantity).toBe(1);
    expect(result.entitlements).toHaveLength(1);
  });
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

  it('replays a second RSVP and converges id and slug callers on one order', async () => {
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
    ).resolves.toMatchObject({
      order: { id: first.order.id },
      entitlements: [{ id: first.entitlements[0]?.id }],
    });

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

describe('M3 RSVP inventory invariants', () => {
  it('allows only one verified account to acquire the final RSVP', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { quantity: 1 });
    const results = await Promise.allSettled(
      ['user_1', 'user_2'].map((userId) =>
        service.createRsvp({ actor: actor(userId), eventId: 'evt_1', tierId: 'tier_1' }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('M3 RSVP cancellation', () => {
  it('releases exactly once and another account can acquire the returned seat', async () => {
    const { events, catalog, service, deps } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { quantity: 1 });
    const first = await service.createRsvp({
      actor: actor('user_1'),
      eventId: 'evt_1',
      tierId: 'tier_1',
    });
    await expect(service.cancelRsvp(first.order.id, actor('user_2'))).rejects.toThrow();
    const cancelled = await service.cancelRsvp(first.order.id, actor('user_1'));
    expect(cancelled.status).toBe('cancelled');
    const replay = await service.cancelRsvp(first.order.id, actor('user_1'));
    expect(replay.version).toBe(cancelled.version);
    expect(
      await deps.repositories.entitlements.getById(
        first.entitlements[0]?.id ?? 'missing-test-ticket',
      ),
    ).toMatchObject({ status: 'void', credentialVersion: 2 });
    const second = await service.createRsvp({
      actor: actor('user_2'),
      eventId: 'evt_1',
      tierId: 'tier_1',
    });
    expect(second.order.status).toBe('paid');
    expect(await deps.inventory.getAvailableQuantity('evt_1', 'tier_1')).toBe(0);
  });
});

describe('M3 verified acquisition', () => {
  it('does not let an unverified account reserve paid checkout inventory', async () => {
    const { events, catalog, service, users } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { accessType: 'ENTRY', priceInPaise: 50000 });
    const { pricing } = await service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_1', quantity: 1 }],
    });
    const user = await users.getById('user_1');
    if (!user) throw new Error('Verified fixture user missing');
    users.save({ ...user, emailVerified: false });
    await expect(
      service.createHold({
        actor: actor('user_1'),
        eventId: 'evt_1',
        organizationId: 'org_1',
        lines: pricing.lines,
        pricing,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: 'unverified-checkout',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('M3 RSVP authoritative sale windows', () => {
  it.each([
    { salesStartAt: new Date(NOW.getTime() + 1).toISOString(), salesEndAt: null, allowed: false },
    {
      salesStartAt: NOW.toISOString(),
      salesEndAt: new Date(NOW.getTime() + 1).toISOString(),
      allowed: true,
    },
    { salesStartAt: null, salesEndAt: NOW.toISOString(), allowed: false },
  ])(
    'enforces inclusive opening and exclusive closing: $allowed',
    async ({ allowed, ...window }) => {
      const { events, catalog, service } = buildService();
      await seedPublishedFreeEvent(events);
      seedTier(catalog, window);
      const result = service.createRsvp({
        actor: actor('user_1'),
        eventId: 'evt_1',
        tierId: 'tier_1',
      });
      if (allowed) await expect(result).resolves.toMatchObject({ order: { status: 'paid' } });
      else await expect(result).rejects.toThrow(/sales are closed/);
    },
  );
  it('does not acquire a stale published event after admission has closed', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    const event = events.events.get('evt_1');
    if (!event) throw new Error('Published fixture event missing');
    events.events.set(event.id, {
      ...event,
      startAt: new Date(NOW.getTime() - 6 * 3600000).toISOString(),
    });
    seedTier(catalog);
    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
    ).rejects.toThrow(/sales are closed/);
  });
});

describe('M3 V1 door requirements without provisional M5 enablement', () => {
  it.each(['MALE', 'FEMALE'] as const)(
    'requires acknowledgment for %s but no profile gender or provisional flag',
    async (audienceType) => {
      const serviceConfig = createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'test-project' },
        clock: { now: () => NOW },
        features: { m5EligibilityRulesEnabled: false },
      });
      const { events, catalog, service } = buildService(serviceConfig);
      await seedPublishedFreeEvent(events);
      seedTier(catalog, { audienceType });
      await expect(
        service.createRsvp({ actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' }),
      ).rejects.toThrow(/Confirm/);
      const result = await service.createRsvp({
        actor: actor('user_1'),
        eventId: 'evt_1',
        tierId: 'tier_1',
        eligibilityAttested: true,
      });
      expect(result.entitlements).toHaveLength(1);
      expect(result.entitlements[0]?.scanCountAllowed).toBe(1);
      expect(result.entitlements[0]?.eligibility?.audienceType).toBe(audienceType);
    },
  );
});

it('supports acknowledged paid Couple checkout with provisional eligibility flags off', async () => {
  const serviceConfig = createCoreConfig({
    redis: { url: 'redis://localhost:6379' },
    firestore: { projectId: 'test-project' },
    clock: { now: () => NOW },
    features: { m5EligibilityRulesEnabled: false },
  });
  const { events, catalog, service } = buildService(serviceConfig);
  await seedPublishedFreeEvent(events);
  seedTier(catalog, {
    accessType: 'ENTRY',
    priceInPaise: 50000,
    audienceType: 'COUPLE',
    guestCount: 2,
    admissionMode: 'bundle',
  });
  await expect(
    service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_1', quantity: 1 }],
    }),
  ).rejects.toThrow(/Confirm/);
  const { pricing } = await service.quote({
    actor: actor('user_1'),
    eventId: 'evt_1',
    lines: [{ tierId: 'tier_1', quantity: 1, eligibilityAttested: true }],
  });
  const hold = await service.createHold({
    actor: actor('user_1'),
    eventId: 'evt_1',
    organizationId: 'org_1',
    lines: pricing.lines.map((line) => ({ ...line, eligibilityAttested: true })),
    pricing,
    appliedPromoCode: null,
    attribution: null,
    idempotencyKey: 'v1-couple',
  });
  expect(hold.lines[0]?.guestCount).toBe(2);
  expect(hold.lines[0]?.eligibility?.audienceType).toBe('COUPLE');
});

describe('M3 acquisition ownership and retry boundaries', () => {
  it('scopes a repeated paid hold key to its verified buyer', async () => {
    const { events, catalog, service, deps } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { accessType: 'ENTRY', priceInPaise: 50000 });
    const { pricing } = await service.quote({
      actor: actor('user_1'),
      eventId: 'evt_1',
      lines: [{ tierId: 'tier_1', quantity: 1 }],
    });
    const input = {
      eventId: 'evt_1',
      organizationId: 'org_1',
      lines: pricing.lines,
      pricing,
      appliedPromoCode: null,
      attribution: null,
      idempotencyKey: 'shared-browser-retry',
    };
    const first = await service.createHold({ ...input, actor: actor('user_1') });
    const replay = await service.createHold({ ...input, actor: actor('user_1') });
    const otherBuyer = await service.createHold({ ...input, actor: actor('user_2') });
    expect(replay.id).toBe(first.id);
    expect(replay.userId).toBe('user_1');
    expect(otherBuyer.id).not.toBe(first.id);
    expect(otherBuyer.userId).toBe('user_2');
    expect(await deps.inventory.getAvailableQuantity('evt_1', 'tier_1')).toBe(8);
    await expect(
      service.createHold({ ...input, actor: actor('user_2'), userId: 'user_1' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await deps.inventory.getAvailableQuantity('evt_1', 'tier_1')).toBe(8);
  });

  it('does not resurrect a cancelled RSVP through a deterministic acquisition retry', async () => {
    const { events, catalog, service, deps, outbox } = buildService();
    await seedPublishedFreeEvent(events);
    seedTier(catalog, { quantity: 1 });
    const command = { actor: actor('user_1'), eventId: 'evt_1', tierId: 'tier_1' };
    const first = await service.createRsvp(command);
    const cancelled = await service.cancelRsvp(first.order.id, actor('user_1'));
    await expect(service.createRsvp(command)).rejects.toThrow();
    await expect(service.cancelRsvp(first.order.id, actor(''))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.cancelRsvp('RSVP-missing', actor('user_1'))).rejects.toThrow();
    expect(await deps.repositories.orders.getById(first.order.id)).toMatchObject({
      status: 'cancelled',
      version: cancelled.version,
    });
    expect(
      await deps.repositories.entitlements.getById(first.entitlements[0]?.id ?? ''),
    ).toMatchObject({ status: 'void', credentialVersion: 2 });
    expect(await deps.inventory.getAvailableQuantity('evt_1', 'tier_1')).toBe(1);
    expect(outbox.all().filter((row) => row.type === 'rsvp.cancelled')).toHaveLength(1);
  });

  it.each(['entered', 'refund-locked', 'invitation-pending'] as const)(
    'does not release RSVP inventory when its admission is %s',
    async (state) => {
      const { events, catalog, service, deps } = buildService();
      await seedPublishedFreeEvent(events);
      seedTier(catalog, { quantity: 1 });
      const result = await service.createRsvp({
        actor: actor('user_1'),
        eventId: 'evt_1',
        tierId: 'tier_1',
      });
      const entitlement = result.entitlements[0];
      if (!entitlement) throw new Error('RSVP fixture ticket missing');
      await deps.repositories.entitlements.save({
        ...entitlement,
        version: entitlement.version + 1,
        ...(state === 'entered'
          ? { status: 'redeemed' as const, scanCount: 1, scannedAt: [NOW.toISOString()] }
          : {}),
        ...(state === 'refund-locked'
          ? { refundLock: { refundRequestId: 'REF-review', frozenAt: NOW.toISOString() } }
          : {}),
        ...(state === 'invitation-pending' ? { pendingTransferId: 'TRF-held' } : {}),
      });
      await expect(service.cancelRsvp(result.order.id, actor('user_1'))).rejects.toThrow(
        /unused RSVP/,
      );
      expect(await deps.repositories.orders.getById(result.order.id)).toMatchObject({
        status: 'paid',
        version: result.order.version,
      });
      expect(await deps.inventory.getAvailableQuantity('evt_1', 'tier_1')).toBe(0);
      await expect(
        service.createRsvp({ actor: actor('user_2'), eventId: 'evt_1', tierId: 'tier_1' }),
      ).rejects.toThrow(/inventory/);
    },
  );
});
