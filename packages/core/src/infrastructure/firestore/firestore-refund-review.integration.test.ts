import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it } from 'vitest';

import { InventoryService } from '../../application/inventory/inventory-service.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { applyOrderRefund, createOrder, lockOrderForRefund } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { createSupportTicket } from '../../domain/models/support-ticket.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';
import { FirestoreSupportTicketRepository } from './firestore-support-ticket-repository.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
describe.runIf(emulator)('refund review and exact inventory release (Firestore)', () => {
  const db = new Firestore({ projectId: 'demo-c1rcle' });
  const support = new FirestoreSupportTicketRepository(db);
  const orders = new FirestoreOrderRepository(db);
  const catalog = new FirestoreEventCatalogRepository(db);
  const inventory = new InventoryService({
    eventCatalog: catalog,
    order: orders,
    cartReservation: new FirestoreCartReservationRepository(db),
  });
  const created: { collection: string; id: string }[] = [];
  afterAll(async () => {
    await Promise.all(created.map((row) => db.collection(row.collection).doc(row.id).delete()));
    await db.terminate();
  });
  it('creates a deterministic support review once and preserves later Admin progress on replay', async () => {
    const id = `SUP-REF-${randomUUID()}`;
    created.push({ collection: 'v2_support_tickets', id });
    const ticket = {
      ...createSupportTicket({
        id,
        subject: 'Refund request',
        description: 'Riya cannot attend',
        category: 'billing',
        priority: 'medium',
        requester: { userId: 'purchaser', email: null, organizationId: null },
      }),
      refundReview: {
        orderId: 'order',
        entitlementIds: ['riya'],
        eventVersion: 2,
        policyKind: 'organizer_reviewed',
        requestedAt: new Date().toISOString(),
      },
    };
    const outcomes = await Promise.all([
      support.createIfAbsent(ticket),
      support.createIfAbsent(ticket),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await support.save({ ...ticket, status: 'in_progress', version: ticket.version + 1 });
    expect(await support.createIfAbsent(ticket)).toBe(false);
    expect(await support.getById(id)).toMatchObject({
      status: 'in_progress',
      refundReview: { entitlementIds: ['riya'] },
    });
  });
  it('persists a settled scoped release exactly once without rewriting commercial quantities', async () => {
    const now = new Date();
    const suffix = randomUUID();
    const tier = createTicketTier({
      id: `tier-${suffix}`,
      eventId: `event-${suffix}`,
      organizationId: 'host',
      name: 'General',
      quantity: 2,
      priceInPaise: 50_000,
      now,
    });
    await catalog.saveTier(tier);
    created.push({ collection: 'v2_event_catalog_tiers', id: tier.id });
    const createdOrder = createOrder({
      id: `order-${suffix}`,
      eventId: tier.eventId,
      organizationId: 'host',
      userId: 'purchaser',
      contact: { name: 'Purchaser', email: '', phone: '' },
      pricing: calculatePricing({ lines: [{ tier, quantity: 2, pricingPhaseId: null }] }),
      now,
    });
    const order = { ...createdOrder, status: 'paid' as const };
    created.push({ collection: 'v2_orders', id: order.id });
    await orders.save(order);
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(0);
    const locked = lockOrderForRefund(order, now);
    await orders.save(locked);
    const released = applyOrderRefund(locked, 50_000, now, 'refund-riya', [
      { entitlementId: 'riya', tierId: tier.id, pricingPhaseId: null },
    ]);
    await orders.save(released);
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(1);
    expect(
      applyOrderRefund(released, 50_000, now, 'refund-riya', [
        { entitlementId: 'riya', tierId: tier.id, pricingPhaseId: null },
      ]),
    ).toBe(released);
    expect((await orders.getById(order.id))?.lines[0]?.quantity).toBe(2);
    expect((await orders.getById(order.id))?.refundedTicketClaims).toEqual([
      {
        refundRequestId: 'refund-riya',
        entitlementId: 'riya',
        tierId: tier.id,
        pricingPhaseId: null,
      },
    ]);
    expect(await inventory.getAvailableQuantity(tier.eventId, tier.id)).toBe(1);
  });
});
