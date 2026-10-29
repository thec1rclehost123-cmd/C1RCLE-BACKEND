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
import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';

import type { ActorContext, ServiceDeps } from '../../application/context.js';
import type { Entitlement } from '../../domain/models/entitlement.js';

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

  it('finds orders by immutable Promoter attribution using the nested single-field index', async () => {
    const promoterId = `m4-promoter-${randomUUID()}`;
    const orderId = `m4-order-${randomUUID()}`;
    const eventId = `m4-event-${randomUUID()}`;
    const now = new Date().toISOString();
    await db
      .collection('v2_orders')
      .doc(orderId)
      .set({
        id: orderId,
        bookingReference: `M4-${randomUUID().slice(0, 8)}`,
        eventId,
        organizationId: `m4-host-${randomUUID()}`,
        userId: `m4-guest-${randomUUID()}`,
        contact: { name: 'Fixture', email: 'fixture@example.test', phone: '' },
        status: 'paid',
        lines: [{ tierId: 'm4-tier', quantity: 2, unitPricePaise: 22_500, subtotalPaise: 45_000 }],
        currency: 'INR',
        subtotalPaise: 45_000,
        discountPaise: 0,
        discountFundingOwner: null,
        discountedSubtotalPaise: 45_000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 45_000,
        appliedPromoCode: null,
        attribution: {
          promoterId,
          referralLinkId: 'm4-link',
          assignmentId: 'm4-assignment',
          assignmentVersion: 1,
          termsSnapshot: { version: 1, ratePercent: 10, flatPaise: 0 },
          eligibleTierIds: null,
          commissionPolicyVersion: 'commission-v1',
          commercialPolicyVersion: 'commercial-v1',
          code: 'M4CODE',
          attributedAt: now,
          attributionSignature: 'test-signature',
          promoterCommissionPaise: 4_500,
        },
        paymentIntentId: null,
        paymentId: null,
        paidAt: now,
        reservationExpiresAt: now,
        failureReason: null,
        eventCancellation: null,
        refundedPaise: 0,
        appliedRefundRequestIds: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

    const page = await new FirestoreOrderRepository(db).listByPromoter(promoterId, {
      limit: 10,
      cursor: null,
    });
    expect(page.total).toBe(1);
    expect(page.items.map((order) => order.id)).toEqual([orderId]);
    expect(page.items[0]?.attribution?.promoterId).toBe(promoterId);

    const eventScopedPage = await new FirestoreOrderRepository(db).listByPromoterForEvent(
      promoterId,
      eventId,
      { limit: 10, cursor: null },
    );
    expect(eventScopedPage.total).toBe(1);
    expect(eventScopedPage.items.map((order) => order.id)).toEqual([orderId]);

    const otherEventPage = await new FirestoreOrderRepository(db).listByPromoterForEvent(
      promoterId,
      'm4-event-other',
      { limit: 10, cursor: null },
    );
    expect(otherEventPage.total).toBe(0);
  }, 45_000);

  /** One published event with a single seat, and a first buyer whose hold has already lapsed. */
  async function lapsedHoldForTheLastSeat() {
    const run = randomUUID().slice(0, 8);
    const eventId = `evt_${run}`;
    const tierId = `tier_${run}`;
    const catalog = new FirestoreEventCatalogRepository(db);
    const carts = new FirestoreCartReservationRepository(db);
    const orders = new FirestoreOrderRepository(db);
    const entitlements = new FirestoreEntitlementRepository(db);
    const repositories = {
      ...buildRepositories({ STORAGE_DRIVER: 'memory', FIRESTORE_PROJECT_ID: 'demo-c1rcle' }),
      catalog,
      cartReservations: carts,
      orders,
      entitlements,
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
    return {
      run,
      eventId,
      tierId,
      carts,
      orders,
      entitlements,
      lapsedHold: lapsed,
      hold,
      lateCapture,
      refund,
      slowOrderWrite,
    };
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

  it('refunds a late capture that would exceed the purchaser event-wide paid-unit cap', async () => {
    const ctx = await lapsedHoldForTheLastSeat();
    const existingPaidEntitlement: Entitlement = {
      id: `m5-late-quota-entitlement-${ctx.run}`,
      orderId: `m5-late-quota-order-${ctx.run}`,
      eventId: ctx.eventId,
      organizationId: 'org_1',
      tierId: ctx.tierId,
      tierName: 'General',
      userId: 'buyer_a',
      unitKind: 'paid',
      currentHolderUserId: 'buyer_a',
      credentialVersion: 1,
      pendingTransferId: null,
      holderName: 'Existing paid unit fixture',
      status: 'valid',
      scanCountAllowed: 10,
      scanCount: 0,
      scannedAt: [],
      refundLock: null,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await ctx.entitlements.saveMany([existingPaidEntitlement]);

    try {
      await expect(ctx.lateCapture()).rejects.toBeInstanceOf(PaymentRefundedError);
      expect(ctx.refund).toHaveBeenCalledTimes(1);
      expect(ctx.refund.mock.calls[0]?.[0]).toMatchObject({
        paymentId: `pay_${ctx.run}`,
        idempotencyKey: `autorefund:pay_${ctx.run}`,
      });
      expect(await ctx.orders.getByPaymentId(`pay_${ctx.run}`)).toBeNull();
      expect(
        await ctx.entitlements.countActivePaidUnitsByUserAndEvent('buyer_a', ctx.eventId),
      ).toBe(10);
      const releasedHold = await ctx.carts.getById(ctx.lapsedHold.id);
      expect(releasedHold?.status).toBe('released');
    } finally {
      await db.collection('v2_entitlements').doc(existingPaidEntitlement.id).delete();
    }
  }, 120_000);
});
