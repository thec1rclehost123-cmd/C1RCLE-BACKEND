import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { ConflictError, InvalidOperationError, UnauthorizedError } from '../../domain/errors.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { MemoryLeaderboardRepository } from '../../infrastructure/memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { CheckoutService, rsvpOrderId } from './checkout-service.js';

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
});

const actor = (userId: string): ActorContext => ({
  userId,
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
});

function buildService() {
  const events = new MemoryEventRepository();
  const catalog = new MemoryEventCatalogRepository();
  const orders = new MemoryOrderRepository();
  const entitlements = new MemoryEntitlementRepository();
  const carts = new MemoryCartReservationRepository();
  const deps = {
    config,
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
      ledger: new MemoryLedgerRepository(),
      leaderboard: new MemoryLeaderboardRepository(),
    },
  } as unknown as ServiceDeps;
  return { deps, events, catalog, orders, service: new CheckoutService(deps) };
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
    priceInPaise: 0,
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
    priceInPaise: 0,
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

  it('rejects a legacy tier whose door price is non-zero', async () => {
    const { events, catalog, service } = buildService();
    await seedPublishedFreeEvent(events);
    const modern = createTicketTier({
      id: 'tier_door_paid',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Door Paid',
      priceInPaise: 0,
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
      priceInPaise: 0,
      quantity: 10,
    });
    await catalog.saveTier(tier);

    await expect(
      service.createRsvp({ actor: actor('user_1'), eventId: 'evt_draft', tierId: 'tier_draft' }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });
});
