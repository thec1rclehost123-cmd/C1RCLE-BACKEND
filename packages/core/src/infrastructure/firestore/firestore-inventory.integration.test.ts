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
import type { Order } from '../../domain/models/order.js';

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
  async function setup(capacity: number, maxPerUser: number | null = null) {
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
        ...(maxPerUser === null ? {} : { maxPerUser }),
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

    const hold = async (userId: string, key = `key-${userId}`) => {
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
        // Unique per run: the emulator keeps its data between runs, and a repeated key
        // would replay the previous run's hold instead of creating a new one.
        idempotencyKey: `${key}-${run}`,
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

  it('holds one buyer to their per-user cap however many requests they fire at once', async () => {
    const cap = 2;
    const { hold, carts, eventId } = await setup(100, cap);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => hold('same_buyer', `parallel-${String(i)}`)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(cap);
    const live = await carts.listActiveByEvent(eventId, new Date());
    expect(live.filter((h) => h.userId === 'same_buyer')).toHaveLength(cap);
  }, 120_000);

  it('does not let one buyer’s cap use up another buyer’s allowance', async () => {
    const { hold } = await setup(100, 1);

    const results = await Promise.allSettled(
      ['buyer_x', 'buyer_y', 'buyer_z'].flatMap((id) => [hold(id, `${id}-1`), hold(id, `${id}-2`)]),
    );

    // Three buyers, a cap of one each: three holds in total, one per buyer.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  }, 120_000);

  describe('listSeatClaims', () => {
    const order = (
      eventId: string,
      id: string,
      status: Order['status'],
      tierId: string,
      quantity: number,
    ) =>
      ({
        id,
        eventId,
        organizationId: 'org_1',
        userId: `user_${id}`,
        contact: { name: 'A', email: 'a@b.c', phone: '' },
        status,
        lines: [
          { tierId, tierName: 'G', quantity, unitPricePaise: 1000, subtotalPaise: 1000 * quantity },
        ],
        currency: 'INR',
        subtotalPaise: 1000 * quantity,
        discountPaise: 0,
        discountedSubtotalPaise: 1000 * quantity,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 1000 * quantity,
        appliedPromoCode: null,
        attribution: null,
        paymentIntentId: 'o',
        paymentId: `p_${id}`,
        paidAt: new Date().toISOString(),
        reservationExpiresAt: new Date().toISOString(),
        failureReason: null,
        refundedPaise: 0,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as Order;

    it('returns only the status and tier lines of this event’s orders', async () => {
      const run = randomUUID().slice(0, 8);
      const orders = new FirestoreOrderRepository(db);
      await orders.save(order(`evt_a_${run}`, `a1_${run}`, 'paid', 'tier_x', 2));
      await orders.save(order(`evt_a_${run}`, `a2_${run}`, 'refund_requested', 'tier_x', 3));
      await orders.save(order(`evt_a_${run}`, `a3_${run}`, 'refunded', 'tier_y', 1));
      await orders.save(order(`evt_b_${run}`, `b1_${run}`, 'paid', 'tier_x', 9));

      const claims = await orders.listSeatClaims(`evt_a_${run}`);

      expect(claims).toHaveLength(3);
      expect(claims.map((c) => c.status).sort()).toEqual(['paid', 'refund_requested', 'refunded']);
      expect(claims.flatMap((c) => c.lines).sort((x, y) => x.quantity - y.quantity)).toEqual([
        { tierId: 'tier_y', quantity: 1 },
        { tierId: 'tier_x', quantity: 2 },
        { tierId: 'tier_x', quantity: 3 },
      ]);
      // A projection: nothing else about the order comes back.
      expect(Object.keys(claims[0] ?? {}).sort()).toEqual(['lines', 'status']);
    }, 60_000);

    it('lets inventory count paid and refund-held seats, but not refunded ones', async () => {
      const run = randomUUID().slice(0, 8);
      const eventId = `evt_c_${run}`;
      const tierId = `tier_c_${run}`;
      const catalog = new FirestoreEventCatalogRepository(db);
      const orders = new FirestoreOrderRepository(db);
      const carts = new FirestoreCartReservationRepository(db);
      await catalog.saveTier(
        createTicketTier({
          id: tierId,
          eventId,
          organizationId: 'org_1',
          name: 'G',
          priceInPaise: 1000,
          quantity: 20,
          now: NOW,
        }),
      );
      await orders.save(order(eventId, `c1_${run}`, 'paid', tierId, 4));
      await orders.save(order(eventId, `c2_${run}`, 'refund_requested', tierId, 3));
      await orders.save(order(eventId, `c3_${run}`, 'refunded', tierId, 5));
      const inventory = new InventoryService({
        eventCatalog: catalog,
        cartReservation: carts,
        order: orders,
      });

      expect(await inventory.getAvailableQuantity(eventId, tierId)).toBe(20 - 4 - 3);
    }, 60_000);
  });
});
