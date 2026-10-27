import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CheckoutService } from '../../application/checkout/checkout-service.js';
import { SYSTEM_ACTOR } from '../../application/context.js';
import { InventoryService } from '../../application/inventory/inventory-service.js';
import { PricingService } from '../../application/pricing/pricing-service.js';
import { createCoreConfig } from '../../config/index.js';
import { PaymentRefundedError } from '../../domain/errors.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { MemoryPaymentProvider } from '../../domain/ports/payment-provider.js';
import { MemoryOutboxStore } from '../memory/memory-outbox-store.js';
import { buildRepositories } from '../utils.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';

import type { ActorContext, ServiceDeps } from '../../application/context.js';

/**
 * ─── A payment that lands after its hold expired, against a REAL Firestore ───
 * The buyer was inside Razorpay's window when the 10-minute hold lapsed, and
 * meanwhile someone else may have taken the seat. Honouring the late payment must
 * go through the same ordered check as a fresh hold, or a late payer and a new
 * buyer racing for the last seat both get it.
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 pnpm --filter @c1rcle/core exec \
 *     vitest run firestore-late-capture
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

describe.runIf(EMULATOR)('late payment vs a new buyer (Firestore emulator)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = new Firestore({ projectId: 'demo-c1rcle' });
  });

  /** One published event with a single seat, and a first buyer whose hold has already lapsed. */
  async function lapsedHoldForTheLastSeat() {
    const run = randomUUID().slice(0, 8);
    const eventId = `evt_${run}`;
    const tierId = `tier_${run}`;
    const catalog = new FirestoreEventCatalogRepository(db);
    const carts = new FirestoreCartReservationRepository(db);
    const orders = new FirestoreOrderRepository(db);
    const repositories = {
      ...buildRepositories({ STORAGE_DRIVER: 'memory', FIRESTORE_PROJECT_ID: 'demo-c1rcle' }),
      catalog,
      cartReservations: carts,
      orders,
    };

    let event = createEvent({
      id: eventId,
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Late Night',
      startAt: '2027-01-01T18:00:00.000Z',
    });
    for (const to of ['review', 'scheduled', 'published'] as const) {
      event = transitionEvent(event, to, NOW);
    }
    await repositories.events.save({ ...event, version: 1 });
    await catalog.saveTier(
      createTicketTier({
        id: tierId,
        eventId,
        organizationId: 'org_1',
        name: 'General',
        priceInPaise: 100_000,
        quantity: 1,
        now: NOW,
      }),
    );

    const provider = new MemoryPaymentProvider('whsec_test');
    const refund = vi.spyOn(provider, 'refundPayment');
    const deps = {
      config,
      outbox: new MemoryOutboxStore(),
      paymentProvider: provider,
      pricing: new PricingService({ eventCatalog: catalog }),
      inventory: new InventoryService({
        eventCatalog: catalog,
        cartReservation: carts,
        order: orders,
      }),
      repositories,
    } as unknown as ServiceDeps;
    const service = new CheckoutService(deps);

    const hold = async (userId: string, ttlMs?: number) => {
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
        ...(ttlMs === undefined ? {} : { reservationTtlMs: ttlMs }),
      });
    };

    // Buyer A takes the seat with a hold that is already over, and has paid.
    const lapsed = await hold('buyer_a', 1);
    await carts.bindProviderOrder(lapsed.id, `order_${run}`);
    provider.simulateCapture(`pay_${run}`, lapsed.pricing.grandTotalPaise, `order_${run}`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lateCapture = () =>
      service.confirmPayment({
        actor: SYSTEM_ACTOR,
        paymentId: `pay_${run}`,
        paymentIntentId: `order_${run}`,
        holdId: lapsed.id,
        _idempotencyKey: `pay_${run}`,
      });
    // Widens the gap between "there is room" and "the order is saved" so a rival can
    // arrive inside it every time. That gap is where a late payer and a new buyer
    // can each be told the seat is free, and it exists however the check is written.
    const slowOrderWrite = () => {
      const original = orders.save.bind(orders);
      vi.spyOn(orders, 'save').mockImplementation(async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return original(...args);
      });
    };
    return { run, eventId, carts, orders, hold, lateCapture, refund, slowOrderWrite };
  }

  /** Seats actually promised: paid orders plus live holds. */
  async function seatsPromised(ctx: Awaited<ReturnType<typeof lapsedHoldForTheLastSeat>>) {
    const live = await ctx.carts.listActiveByEvent(ctx.eventId, new Date());
    const paid = await ctx.orders.listByEvent(ctx.eventId, { limit: 50, cursor: null });
    return (
      live.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.quantity, 0), 0) +
      paid.items
        .filter((o) => o.status === 'paid')
        .reduce((n, o) => n + o.lines.reduce((m, l) => m + l.quantity, 0), 0)
    );
  }

  it('honours a late payment when nobody else wants the seat', async () => {
    const ctx = await lapsedHoldForTheLastSeat();

    const result = await ctx.lateCapture();

    expect(result.order.status).toBe('paid');
    expect(ctx.refund).not.toHaveBeenCalled();
    expect(await seatsPromised(ctx)).toBe(1);
  }, 120_000);

  it('refunds a late payment when a new buyer already holds the seat', async () => {
    const ctx = await lapsedHoldForTheLastSeat();
    await ctx.hold('buyer_c');

    await expect(ctx.lateCapture()).rejects.toBeInstanceOf(PaymentRefundedError);

    expect(ctx.refund).toHaveBeenCalledTimes(1);
    expect(await seatsPromised(ctx)).toBe(1);
  }, 120_000);

  it('never gives the last seat to both a late payer and a new buyer racing for it', async () => {
    for (let round = 0; round < 8; round += 1) {
      const ctx = await lapsedHoldForTheLastSeat();

      await Promise.allSettled([ctx.lateCapture(), ctx.hold('buyer_c')]);

      // Whoever lost must not be left holding a seat or paying for nothing.
      expect(await seatsPromised(ctx)).toBeLessThanOrEqual(1);
    }
  }, 240_000);

  it('does not give the seat to a new buyer who arrives while a late payment is being honoured', async () => {
    const ctx = await lapsedHoldForTheLastSeat();
    ctx.slowOrderWrite();

    const late = ctx.lateCapture();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rival = await ctx.hold('buyer_c').then(
      () => 'kept' as const,
      () => 'turned_away' as const,
    );
    const lateOutcome = await late.then(
      () => 'honoured' as const,
      () => 'refunded' as const,
    );

    // Exactly one of them gets the seat; the other is turned away or refunded.
    expect([rival, lateOutcome].sort()).not.toEqual(['honoured', 'kept']);
    expect(await seatsPromised(ctx)).toBe(1);
  }, 120_000);

  it('refunds once and only once when the same late payment is delivered twice', async () => {
    const ctx = await lapsedHoldForTheLastSeat();
    await ctx.hold('buyer_c');

    await Promise.allSettled([ctx.lateCapture(), ctx.lateCapture()]);

    const keys = new Set(ctx.refund.mock.calls.map(([request]) => request.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(await seatsPromised(ctx)).toBe(1);
  }, 120_000);
});
