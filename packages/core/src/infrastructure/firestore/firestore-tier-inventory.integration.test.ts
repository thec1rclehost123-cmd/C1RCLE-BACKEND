import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';

import { InventoryService } from '../../application/inventory/inventory-service.js';
import { createCartReservation } from '../../domain/models/cart-reservation.js';
import { createTicketTier, updateTicketTier } from '../../domain/models/event-catalog.js';
import { calculatePricing } from '../../domain/models/pricing.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(emulator)('M3 tier inventory and phase allocations (Firestore)', () => {
  const db = new Firestore({ projectId: 'demo-c1rcle' });
  const catalog = new FirestoreEventCatalogRepository(db);
  const carts = new FirestoreCartReservationRepository(db);
  const orders = new FirestoreOrderRepository(db);
  const inventory = new InventoryService({
    eventCatalog: catalog,
    cartReservation: carts,
    order: orders,
  });
  const created: { collection: string; id: string }[] = [];
  afterAll(async () => {
    await Promise.all(created.map((row) => db.collection(row.collection).doc(row.id).delete()));
    await db.terminate();
  });
  async function setup(quantity = 20) {
    const now = new Date();
    const suffix = randomUUID();
    const tier = createTicketTier({
      id: `tier-${suffix}`,
      eventId: `evt-${suffix}`,
      organizationId: 'org-m3',
      name: 'General',
      quantity,
      priceInPaise: 50_000,
      now,
      pricingPhases: [
        {
          id: 'early',
          name: 'Early Bird',
          priceInPaise: 25_000,
          quantity: 1,
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2099-01-01T00:00:00.000Z',
        },
      ],
    });
    await catalog.saveTier(tier);
    created.push(
      { collection: 'v2_event_catalog_tiers', id: tier.id },
      { collection: 'v2_hold_sequences', id: tier.eventId },
    );
    const hold = async (quantity: number, pricingPhaseId?: string) => {
      const id = `HOLD-${randomUUID()}`;
      created.push({ collection: 'v2_cart_reservations', id });
      const pricing = calculatePricing({
        lines: [{ tier, quantity, pricingPhaseId: pricingPhaseId ?? null }],
      });
      return carts.create(
        createCartReservation({
          id,
          eventId: tier.eventId,
          organizationId: tier.organizationId,
          userId: id,
          lines: pricing.lines,
          pricing,
          idempotencyKey: id,
          appliedPromoCode: null,
          attribution: null,
          now,
        }),
      );
    };
    return { tier, hold, now };
  }
  it('rejects reductions below sold plus held and preserves independent tiers', async () => {
    const { tier, hold, now } = await setup();
    await hold(3);
    const orderId = `order-${randomUUID()}`;
    created.push({ collection: 'v2_orders', id: orderId });
    await db
      .collection('v2_orders')
      .doc(orderId)
      .set({
        id: orderId,
        eventId: tier.eventId,
        status: 'paid',
        lines: [{ tierId: tier.id, quantity: 4 }],
      });
    await expect(
      catalog.updateTier(updateTicketTier(tier, { quantity: 6 }, now), { now }),
    ).rejects.toThrow('sold and actively held');
    expect((await catalog.getTierById(tier.id))?.quantity).toBe(20);
    await catalog.updateTier(updateTicketTier(tier, { quantity: 7, priceInPaise: 60_000 }, now), {
      now,
    });
    expect(await catalog.getTierById(tier.id)).toMatchObject({ quantity: 7, priceInPaise: 60_000 });
    expect((await db.collection('v2_orders').doc(orderId).get()).data()?.lines).toEqual([
      { tierId: tier.id, quantity: 4 },
    ]);
    const separate = { ...tier, id: `separate-${randomUUID()}`, quantity: 1 };
    created.push({ collection: 'v2_event_catalog_tiers', id: separate.id });
    await catalog.saveTier(separate);
    expect(await inventory.getAvailableQuantity(tier.eventId, separate.id)).toBe(1);
  });
  it('allows increases after sellout without changing sold tickets', async () => {
    const { tier, hold, now } = await setup(1);
    await hold(1);
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(0);
    await catalog.updateTier(updateTicketTier(tier, { quantity: 2 }, now), { now });
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(1);
  });
  it('keeps exactly one concurrent allocation in the final Early Bird slot', async () => {
    const { tier, hold } = await setup(20);
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const reserved = await hold(1, 'early');
        if (await inventory.firstOverbookedTier(reserved)) {
          await carts.release(reserved.id);
          return false;
        }
        return true;
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      0,
    );
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(19);
  }, 60_000);
  it('serializes concurrent hold creation against a tier reduction', async () => {
    const { tier, hold, now } = await setup(1);
    const results = await Promise.allSettled([
      catalog.updateTier(updateTicketTier(tier, { quantity: 0 }, now), { now }),
      (async () => {
        const reserved = await hold(1);
        if (await inventory.firstOverbookedTier(reserved)) {
          await carts.release(reserved.id);
          throw new Error('sold out');
        }
        return reserved;
      })(),
    ]);
    const stored = await catalog.getTierById(tier.id);
    const live = await carts.listActiveByEvent(tier.eventId, new Date());
    expect(
      live.reduce((sum, row) => sum + row.lines.reduce((n, line) => n + line.quantity, 0), 0),
    ).toBeLessThanOrEqual(stored?.quantity ?? 0);
    expect(results.filter((row) => row.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
