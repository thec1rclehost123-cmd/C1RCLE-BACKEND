import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import { CheckoutService } from '../../application/checkout/checkout-service.js';
import { InventoryService } from '../../application/inventory/inventory-service.js';
import { PricingService } from '../../application/pricing/pricing-service.js';
import { createCoreConfig } from '../../config/index.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { MemoryEventRepository } from '../memory/memory-repositories.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';

import type { ActorContext, ServiceDeps } from '../../application/context.js';

/**
 * ─── Seat reservation against a REAL Firestore (emulator) ────────────────────
 * The in-memory store cannot show how Firestore actually interleaves concurrent
 * writers, so the overselling guarantee is proven here, with the real adapters.
 *
 *   firebase emulators:start --only firestore --project demo-c1rcle   # port 8089
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 pnpm --filter @c1rcle/core test \
 *     firestore-inventory
 *
 * Skipped unless FIRESTORE_EMULATOR_HOST is set, so the normal suite is unaffected.
 */
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

const NOW = new Date();
const config = createCoreConfig({
  redis: { url: 'redis://localhost:6379' },
  firestore: { projectId: 'demo-c1rcle' },
  clock: { now: () => NOW },
});
const actor = (userId: string): ActorContext => ({
  userId,
  organizationId: 'org_1',
  role: 'owner',
  capabilities: [],
});

describe.runIf(EMULATOR)('seat reservation (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  /** A published event with one tier of `capacity` seats, on a unique id so runs never collide. */
  async function setup(capacity: number) {
    const run = randomUUID().slice(0, 8);
    const eventId = `evt_${run}`;
    const tierId = `tier_${run}`;
    const events = new MemoryEventRepository();
    const catalog = new FirestoreEventCatalogRepository(db);
    const carts = new FirestoreCartReservationRepository(db);
    const orders = new FirestoreOrderRepository(db);

    let event = createEvent({
      id: eventId,
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Emulator Night',
      startAt: '2027-01-01T18:00:00.000Z',
    });
    for (const to of ['review', 'scheduled', 'published'] as const) {
      event = transitionEvent(event, to, NOW);
    }
    await events.save({ ...event, version: 1 });
    await catalog.saveTier(
      createTicketTier({
        id: tierId,
        eventId,
        organizationId: 'org_1',
        name: 'General',
        priceInPaise: 100_000,
        quantity: capacity,
        now: NOW,
      }),
    );

    const deps = {
      config,
      pricing: new PricingService({ eventCatalog: catalog }),
      inventory: new InventoryService({
        eventCatalog: catalog,
        cartReservation: carts,
        order: orders,
      }),
      repositories: { events, catalog, cartReservations: carts, orders },
    } as unknown as ServiceDeps;
    const service = new CheckoutService(deps);

    const hold = async (userId: string) => {
      const { pricing } = await service.quote({
        actor: actor(userId),
        eventId,
        lines: [{ tierId, quantity: 1 }],
      });
      return service.createHold({
        actor: actor(userId),
        eventId,
        organizationId: 'org_1',
        lines: pricing.lines.map((l) => ({
          tierId: l.tierId,
          tierName: l.tierName,
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
        })),
        pricing,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: `key-${userId}-${run}`,
      });
    };
    return { hold, carts, eventId };
  }

  it('lets exactly one of many simultaneous buyers reserve the last seat', async () => {
    const { hold, carts, eventId } = await setup(1);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => hold(`buyer_${String(i)}`)),
    );

    const kept = results.filter((r) => r.status === 'fulfilled');
    expect(kept).toHaveLength(1);
    const live = await carts.listActiveByEvent(eventId, new Date());
    expect(live).toHaveLength(1);
  }, 120_000);

  it('never reserves more seats than exist, however many buyers race', async () => {
    const capacity = 5;
    const { hold, carts, eventId } = await setup(capacity);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => hold(`buyer_${String(i)}`)),
    );

    const kept = results.filter((r) => r.status === 'fulfilled').length;
    expect(kept).toBeLessThanOrEqual(capacity);
    expect((await carts.listActiveByEvent(eventId, new Date())).length).toBe(kept);
    // And no seat is wasted: the first `capacity` buyers' worth of demand is met.
    expect(kept).toBe(capacity);
  }, 120_000);

  it('holds up under a crowd: 60 buyers, 10 seats, three waves', async () => {
    const capacity = 10;
    const { hold, carts, eventId } = await setup(capacity);

    for (const wave of [0, 1, 2]) {
      await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => hold(`buyer_${String(wave)}_${String(i)}`)),
      );
      const live = await carts.listActiveByEvent(eventId, new Date());
      // Never above capacity at any point, and once full it stays exactly full.
      expect(live.length).toBeLessThanOrEqual(capacity);
    }
    expect((await carts.listActiveByEvent(eventId, new Date())).length).toBe(capacity);
  }, 240_000);

  it('gives distinct, increasing positions to holds for one event', async () => {
    const { hold, carts, eventId } = await setup(50);

    await Promise.all(Array.from({ length: 10 }, (_, i) => hold(`buyer_${String(i)}`)));

    const positions = (await carts.listActiveByEvent(eventId, new Date()))
      .map((h) => h.sequence)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }, 120_000);
});
