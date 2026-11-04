import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createOrder } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import {
  MemoryCartReservationRepository,
  MemoryEventCatalogRepository,
  MemoryOrderRepository,
} from '../../infrastructure/memory/memory-repositories.js';

import { InventoryService } from './inventory-service.js';

function fixture(phaseQuantity: number | null = 5) {
  const now = new Date();
  const catalog = new MemoryEventCatalogRepository();
  const carts = new MemoryCartReservationRepository();
  const orders = new MemoryOrderRepository();
  const tier = createTicketTier({
    id: 'tier-phase',
    eventId: 'event-phase',
    organizationId: 'org-phase',
    name: 'General',
    quantity: 20,
    priceInPaise: 50_000,
    now,
    pricingPhases: [
      {
        id: 'early',
        name: 'Early Bird',
        priceInPaise: 25_000,
        quantity: phaseQuantity,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2099-01-01T00:00:00.000Z',
      },
    ],
  });
  void catalog.saveTier(tier);
  const inventory = new InventoryService({
    eventCatalog: catalog,
    cartReservation: carts,
    order: orders,
  });
  const pricing = (quantity: number, pricingPhaseId: string | null | undefined = 'early') =>
    calculatePricing({
      lines: [{ tier, quantity, ...(pricingPhaseId === undefined ? {} : { pricingPhaseId }) }],
    });
  const hold = (id: string, quantity = 1, phaseId: string | null = 'early') => {
    const quote = pricing(quantity, phaseId);
    return carts.create(
      createCartReservation({
        id,
        eventId: tier.eventId,
        organizationId: tier.organizationId,
        userId: id,
        lines: quote.lines,
        pricing: quote,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: id,
        now,
        reservationTtlMs: 3600_000,
      }),
    );
  };
  const sold = async (id: string, quantity: number, phaseId: string | null = 'early') => {
    const order = {
      ...createOrder({
        id,
        eventId: tier.eventId,
        organizationId: tier.organizationId,
        userId: id,
        contact: { name: id, email: '', phone: '' },
        pricing: pricing(quantity, phaseId),
        now,
      }),
      status: 'paid' as const,
    };
    await orders.save(order);
    return order;
  };
  return { catalog, carts, orders, tier, inventory, hold, sold };
}

describe('InventoryService quantity-priced allocations', () => {
  it('counts paid and refund-pending allocations plus live holds while releasing only settled ticket claims', async () => {
    const { carts, orders, tier, inventory, hold, sold } = fixture();
    const paid = await sold('order-early', 2);
    const pending = await sold('order-pending-refund', 1);
    orders.orders.set(pending.id, { ...pending, status: 'refund_requested' });
    await sold('order-base-price', 3, null);
    await sold('order-other-phase', 1, 'later');
    const unpaid = await sold('order-unpaid', 2);
    orders.orders.set(unpaid.id, { ...unpaid, status: 'pending' });
    await hold('hold-live');
    const released = await hold('hold-released', 2);
    await carts.release(released.id);
    const expired = await hold('hold-expired', 2);
    carts.reservations.set(expired.id, {
      ...expired,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });
    const converted = await hold('hold-converted', 2);
    carts.reservations.set(converted.id, {
      ...converted,
      status: 'converted',
      convertedOrderId: paid.id,
    });
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      1,
    );
    // A partial settlement leaves the commercial line immutable and releases one allocation.
    const refundClaim = { entitlementId: 'ENT-returned', tierId: tier.id, pricingPhaseId: 'early' };
    orders.orders.set(paid.id, { ...paid, refundedTicketClaims: [refundClaim, refundClaim] });
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      2,
    );
    expect((await orders.getById(paid.id))?.lines).toEqual(paid.lines);
    expect(await inventory.getTierInventory(tier.eventId, tier.id)).toEqual({
      soldQuantity: 6,
      heldQuantity: 1,
      availableQuantity: 13,
    });
    // Full settlement excludes the whole order; claim metadata must not release twice.
    orders.orders.set(paid.id, {
      ...paid,
      status: 'refunded',
      refundedTicketClaims: [refundClaim],
    });
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      3,
    );
    await carts.release('hold-live');
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      4,
    );
  });

  it('conservatively reserves legacy unsnapshotted sales but excludes known base-price sales', async () => {
    const { orders, tier, inventory, sold } = fixture(1);
    await sold('known-base', 2, null);
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      1,
    );
    const legacy = await sold('legacy-allocation', 2);
    orders.orders.set(legacy.id, {
      ...legacy,
      lines: legacy.lines.map(({ pricingPhaseId: _phase, ...line }) => line),
    });
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      0,
    );
  });

  it('keeps exactly the first buyer when simultaneous holds compete for the final phase unit', async () => {
    const { carts, tier, inventory, hold } = fixture(1);
    const candidates = await Promise.all(
      Array.from({ length: 6 }, (_, index) => hold(`racer-${index}`)),
    );
    expect(new Set(candidates.map((candidate) => candidate.sequence)).size).toBe(6);
    const decisions = await Promise.all(
      candidates.map((candidate) => inventory.firstOverbookedTier(candidate)),
    );
    expect(decisions).toEqual([null, tier.id, tier.id, tier.id, tier.id, tier.id]);
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate && decisions[index]) await carts.release(candidate.id);
    }
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      0,
    );
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(19);
    expect(await carts.listActiveByEvent(tier.eventId, new Date())).toHaveLength(1);
  });

  it('includes settled sales and older holds ahead of a new phase buyer, but not later base-price buyers', async () => {
    const { tier, inventory, hold, sold } = fixture(2);
    await sold('paid-first', 1);
    const first = await hold('first-early');
    const second = await hold('second-early');
    const base = await hold('later-base', 3, null);
    expect(await inventory.firstOverbookedTier(first)).toBeNull();
    expect(await inventory.firstOverbookedTier(second)).toBe(tier.id);
    expect(await inventory.firstOverbookedTier(base)).toBeNull();
  });

  it('supports unlimited phases without bypassing total tier stock', async () => {
    const { tier, inventory, hold } = fixture(null);
    expect(await inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    const first = await hold('unlimited-first', 10);
    const second = await hold('unlimited-second', 10);
    const excess = await hold('unlimited-excess');
    expect(await inventory.firstOverbookedTier(first)).toBeNull();
    expect(await inventory.firstOverbookedTier(second)).toBeNull();
    expect(await inventory.firstOverbookedTier(excess)).toBe(tier.id);
  });

  it('fails closed when a quoted phase or tier has disappeared', async () => {
    const { catalog, tier, inventory, hold } = fixture();
    await expect(
      inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'missing'),
    ).rejects.toThrow(/unavailable/);
    const stale = await hold('stale-phase', 1, 'removed-phase');
    expect(await inventory.firstOverbookedTier(stale)).toBe(tier.id);
    catalog.tiers.delete(tier.id);
    await expect(
      inventory.getAvailablePricingPhaseQuantity(tier.eventId, tier.id, 'early'),
    ).rejects.toThrow(/unavailable/);
    await expect(inventory.firstOverbookedTier(stale)).rejects.toThrow(/not found/);
  });
});
