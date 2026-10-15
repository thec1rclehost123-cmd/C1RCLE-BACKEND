import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createPromoCode, createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { MemoryLeaderboardRepository } from '../../infrastructure/memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import {
  MemoryCartReservationRepository,
  MemoryEntitlementRepository,
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
  MemoryPromoRedemptionRepository,
} from '../../infrastructure/memory/memory-repositories.js';
import { InventoryService } from '../inventory/inventory-service.js';
import { PricingService } from '../pricing/pricing-service.js';

import { CheckoutService } from './checkout-service.js';

import type { Order } from '../../domain/models/order.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/**
 * ─── Payment business-logic audit ────────────────────────────────────────────
 * Each test states a rule the payment path must hold. They were written against
 * the code as found, to prove or disprove suspected defects before fixing them.
 */

const NOW = new Date('2026-10-14T00:00:00.000Z');
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

async function build(options: { eventStatus?: 'published' | 'draft' | 'cancelled' } = {}) {
  const events = new MemoryEventRepository();
  const catalog = new MemoryEventCatalogRepository();
  const orders = new MemoryOrderRepository();
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
      entitlements: new MemoryEntitlementRepository(),
      ledger: new MemoryLedgerRepository(),
      leaderboard: new MemoryLeaderboardRepository(),
      promoRedemptions: new MemoryPromoRedemptionRepository(),
    },
  } as unknown as ServiceDeps;

  let event = createEvent({
    id: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    title: 'Sky Night',
    startAt: '2026-12-01T18:00:00.000Z',
  });
  const path = {
    published: ['review', 'scheduled', 'published'],
    cancelled: ['review', 'scheduled', 'published', 'cancelled'],
    draft: [],
  }[options.eventStatus ?? 'published'] as ('review' | 'scheduled' | 'published' | 'cancelled')[];
  for (const to of path) event = transitionEvent(event, to, NOW);
  await events.save({ ...event, version: 1 });

  return {
    deps,
    catalog,
    orders,
    carts,
    events,
    redemptions: deps.repositories.promoRedemptions,
    service: new CheckoutService(deps),
  };
}

async function seedTier(catalog: MemoryEventCatalogRepository, quantity = 10) {
  await catalog.saveTier(
    createTicketTier({
      id: 'tier_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'General',
      priceInPaise: 100_000,
      quantity,
      now: NOW,
    }),
  );
}

async function holdFor(
  service: CheckoutService,
  userId: string,
  key: string,
  promoCode: string | null = null,
) {
  const { pricing } = await service.quote({
    actor: actor(userId),
    eventId: 'evt_1',
    lines: [{ tierId: 'tier_1', quantity: 1 }],
    promoCode,
  });
  return service.createHold({
    actor: actor(userId),
    eventId: 'evt_1',
    organizationId: 'org_1',
    lines: pricing.lines.map((l) => ({
      tierId: l.tierId,
      tierName: l.tierName,
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
    })),
    pricing,
    appliedPromoCode: pricing.appliedPromoCode,
    attribution: null,
    idempotencyKey: key,
  });
}

describe('an event must be on sale to take payment', () => {
  it('refuses a hold on a draft event', async () => {
    const { catalog, service } = await build({ eventStatus: 'draft' });
    await seedTier(catalog);

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(
      /not on sale|unavailable|published/i,
    );
  });

  it('refuses a hold on a cancelled event', async () => {
    const { catalog, service } = await build({ eventStatus: 'cancelled' });
    await seedTier(catalog);

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(
      /not on sale|unavailable|cancel/i,
    );
  });
});

describe('a promo code must be redeemable', () => {
  const promo = (overrides: Record<string, unknown> = {}) =>
    createPromoCode({
      id: 'promo_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      code: 'SAVE50',
      discountType: 'percent',
      discountValue: 50,
      now: NOW,
      ...overrides,
    });

  it('does not apply an expired code', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(promo({ endsAt: '2026-01-01T00:00:00.000Z' }));

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /expired|not valid|ended/i,
    );
  });

  it('does not apply a code that has not started', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(promo({ startsAt: '2027-01-01T00:00:00.000Z' }));

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /not started|not valid|not yet/i,
    );
  });

  it('does not apply a deactivated code', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo({ ...promo(), isActive: false });

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /not active|not valid|deactivated|inactive/i,
    );
  });

  it('does not apply a code whose redemption limit is used up', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo({ ...promo({ maxRedemptions: 5 }), redemptionCount: 5 });

    await expect(holdFor(service, 'user_1', 'k1', 'SAVE50')).rejects.toThrow(
      /limit|used|redeemed|exhausted/i,
    );
  });
});

describe('inventory is never oversold', () => {
  // Fixed: hold positions are assigned in a transaction and capacity is judged
  // against the holds ordered at or before a hold. Proven against a real Firestore
  // in firestore-inventory.integration.test.ts; this is the in-memory check.
  it('lets only one of two simultaneous buyers reserve the last ticket', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 1);

    const results = await Promise.allSettled([
      holdFor(service, 'user_a', 'key-a'),
      holdFor(service, 'user_b', 'key-b'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('keeps a seat taken while its order is waiting on a refund', async () => {
    const { catalog, orders, carts, service } = await build();
    await seedTier(catalog, 1);
    const hold = await holdFor(service, 'user_a', 'key-a');
    await orders.save({
      id: 'ORD-1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      userId: 'user_a',
      status: 'refund_requested',
      lines: hold.lines.map((l) => ({ ...l, subtotalPaise: l.unitPricePaise * l.quantity })),
      version: 1,
    } as unknown as Order);
    await carts.release(hold.id);

    // The buyer still holds a valid ticket, so the seat must still be unavailable.
    await expect(holdFor(service, 'user_b', 'key-b')).rejects.toThrow(/inventory/i);
  });
});

describe('an idempotency key never reaches another buyer’s hold', () => {
  it('does not return user A’s hold to user B for the same key', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 5);
    const a = await holdFor(service, 'user_a', 'shared-key');

    const b = await holdFor(service, 'user_b', 'shared-key').catch(() => null);

    expect(b === null || b.id !== a.id || b.userId === 'user_b').toBe(true);
    expect(b?.userId ?? 'user_b').toBe('user_b');
  });
});

describe('payment is refused once the event stops being on sale', () => {
  it('will not start a payment for a hold on an event that was cancelled meanwhile', async () => {
    const { catalog, events, service } = await build();
    await seedTier(catalog);
    const hold = await holdFor(service, 'user_1', 'k1');
    const stored = await events.getById('evt_1');
    if (!stored) throw new Error('event missing');
    await events.save({
      ...transitionEvent(stored, 'cancelled', NOW),
      version: stored.version + 1,
    });

    await expect(
      service.createPaymentIntent({
        actor: actor('user_1'),
        holdId: hold.id,
        idempotencyKey: 'pi-1',
      }),
    ).rejects.toThrow(/not on sale/i);
  });
});

describe('promo redemption limits count every redemption record', () => {
  const limited = (overrides: Record<string, unknown>) =>
    createPromoCode({
      id: 'promo_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      code: 'ONCE',
      discountType: 'percent',
      discountValue: 10,
      now: NOW,
      ...overrides,
    });

  const record = (promoId: string, userId = 'user_9') => ({
    id: `RED-${promoId}-${userId}`,
    promoId,
    orderId: `ORD-${promoId}-${userId}`,
    userId,
    redeemedAt: NOW.toISOString(),
  });

  it('stops a code once its total limit is reached, whether recorded by promo id or by code', async () => {
    for (const recordedUnder of ['promo_1', 'ONCE']) {
      const { catalog, redemptions, service } = await build();
      await seedTier(catalog);
      await catalog.savePromo(limited({ maxRedemptions: 1 }));
      await redemptions.create(record(recordedUnder));

      await expect(holdFor(service, 'user_1', 'k1', 'ONCE')).rejects.toThrow(/redemption limit/i);
    }
  });

  it('still allows a code below its limit', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(limited({ maxRedemptions: 2 }));

    const hold = await holdFor(service, 'user_1', 'k1', 'ONCE');

    expect(hold.pricing.discountPaise).toBe(10_000);
  });

  it('stops one buyer using a per-user-limited code twice, but not a different buyer', async () => {
    const { catalog, redemptions, service } = await build();
    await seedTier(catalog);
    await catalog.savePromo(limited({ maxPerUser: 1 }));
    await redemptions.create(record('promo_1', 'user_1'));

    await expect(holdFor(service, 'user_1', 'k1', 'ONCE')).rejects.toThrow(/already used/i);
    await expect(holdFor(service, 'user_2', 'k2', 'ONCE')).resolves.toBeDefined();
  });
});

describe('a held seat can be re-requested by its own buyer', () => {
  it('replays the same hold for the same buyer and key', async () => {
    const { catalog, service } = await build();
    await seedTier(catalog, 5);

    const first = await holdFor(service, 'user_a', 'same-key');
    const again = await holdFor(service, 'user_a', 'same-key');

    expect(again.id).toBe(first.id);
  });
});

describe('an amount the payment provider would refuse is refused up front', () => {
  it('rejects a paid total under ₹1 at quote, before any seat is held', async () => {
    const { catalog, carts, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Tiny',
        priceInPaise: 50,
        quantity: 5,
        now: NOW,
      }),
    );

    await expect(holdFor(service, 'user_1', 'k1')).rejects.toThrow(/at least ₹1/);
    expect(carts.reservations.size).toBe(0);
  });

  it('still allows a free ticket', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Free',
        accessType: 'RSVP',
        quantity: 5,
        now: NOW,
      }),
    );

    await expect(holdFor(service, 'user_1', 'k1')).resolves.toBeDefined();
  });

  it('still allows the smallest chargeable total (exactly 100 paise)', async () => {
    const { catalog, service } = await build();
    await catalog.saveTier(
      createTicketTier({
        id: 'tier_1',
        eventId: 'evt_1',
        organizationId: 'org_1',
        name: 'Cheap',
        priceInPaise: 92,
        quantity: 5,
        now: NOW,
      }),
    );

    // 92 + fees (5 + 2) + GST (1) is exactly 100 paise.
    const hold = await holdFor(service, 'user_1', 'k1');
    expect(hold.pricing.grandTotalPaise).toBe(100);
  });
});
