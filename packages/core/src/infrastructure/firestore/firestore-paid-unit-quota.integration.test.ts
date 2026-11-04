import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { MemoryFinancialJournalRepository } from '../memory/memory-financial-journal-repository.js';
import { MemoryLeaderboardRepository } from '../memory/memory-leaderboard-repository.js';
import { MemoryLedgerRepository } from '../memory/memory-ledger-repository.js';
import { MemoryOutboxStore } from '../memory/memory-outbox-store.js';
import {
  MemoryEventCatalogRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
  MemoryPromoRedemptionRepository,
} from '../memory/memory-repositories.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEntitlementRepository } from './firestore-entitlement-repository.js';

import type { ServiceDeps, ActorContext } from '../../application/context.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore active paid-unit quota', () => {
  it('serializes competing six-unit holds and allows released capacity to be retried', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const userId = `m5-quota-user-${suffix}`;
    const eventId = `m5-quota-event-${suffix}`;
    const organizationId = `m5-quota-org-${suffix}`;
    const tierId = `m5-quota-tier-${suffix}`;
    const actor: ActorContext = {
      userId,
      organizationId,
      role: 'owner',
      capabilities: [],
    };
    const now = new Date();
    const eventRepo = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const orders = new MemoryOrderRepository();
    const carts = new FirestoreCartReservationRepository(db);
    const entitlements = new FirestoreEntitlementRepository(db);
    const event = createEvent({
      id: eventId,
      organizationId,
      venueId: `m5-quota-venue-${suffix}`,
      title: 'M5 disposable quota scenario',
      startAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      now,
    });
    const published = transitionEvent(
      transitionEvent(transitionEvent(event, 'review', now), 'scheduled', now),
      'published',
      now,
    );

    try {
      await eventRepo.save({ ...published, version: 1 });
      await catalog.saveTier(
        createTicketTier({
          id: tierId,
          eventId,
          organizationId,
          name: 'M5 quota tier',
          priceInPaise: 10_000,
          quantity: 50,
          now,
        }),
      );
      const config = createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'demo-c1rcle' },
        clock: { now: () => new Date() },
      });
      const deps = {
        config,
        outbox: new MemoryOutboxStore(),
        pricing: new (await import('../../application/pricing/pricing-service.js')).PricingService({
          eventCatalog: catalog,
        }),
        inventory: new (
          await import('../../application/inventory/inventory-service.js')
        ).InventoryService({
          eventCatalog: catalog,
          cartReservation: carts,
          order: orders,
        }),
        repositories: {
          events: eventRepo,
          catalog,
          cartReservations: carts,
          orders,
          entitlements,
          ledger: new MemoryLedgerRepository(),
          financialJournals: new MemoryFinancialJournalRepository(),
          leaderboard: new MemoryLeaderboardRepository(),
          promoRedemptions: new MemoryPromoRedemptionRepository(),
        },
      } as unknown as ServiceDeps;
      const { CheckoutService } = await import('../../application/checkout/checkout-service.js');
      const service = new CheckoutService(deps);

      const createHold = async (key: string, quantity: number): Promise<CartReservation> => {
        const quote = await service.quote({
          actor,
          eventId,
          lines: [{ tierId, quantity }],
        });
        const lines: CartReservation['lines'] = quote.pricing.lines.map((line) => ({
          tierId: line.tierId,
          tierName: line.tierName,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
        }));
        return service.createHold({
          actor,
          eventId,
          organizationId,
          lines,
          pricing: quote.pricing,
          appliedPromoCode: quote.pricing.appliedPromoCode,
          attribution: null,
          idempotencyKey: key,
        });
      };

      const competing = await Promise.allSettled([
        createHold(`six-a-${suffix}`, 6),
        createHold(`six-b-${suffix}`, 6),
      ]);
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const winningSixUnitHold = competing.find((result) => result.status === 'fulfilled');
      if (winningSixUnitHold?.status !== 'fulfilled') throw new Error('Expected one quota hold');

      const paidEntitlement: Entitlement = {
        id: `m5-quota-entitlement-${suffix}`,
        orderId: `m5-quota-order-${suffix}`,
        eventId,
        organizationId,
        tierId,
        tierName: 'M5 quota tier',
        userId,
        unitKind: 'paid',
        currentHolderUserId: userId,
        credentialVersion: 1,
        pendingTransferId: null,
        holderName: 'Disposable quota fixture',
        status: 'valid',
        scanCountAllowed: 3,
        scanCount: 0,
        scannedAt: [],
        refundLock: null,
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await entitlements.saveMany([paidEntitlement]);

      // Purchased admissions and live holds share the same event-wide cap.
      const totalTen = await createHold(`one-${suffix}`, 1);
      expect(totalTen.status).toBe('active');
      await expect(createHold(`eleven-${suffix}`, 1)).rejects.toThrow(/maximum of 10 paid/);

      await carts.release(totalTen.id);
      const afterRelease = await createHold(`released-capacity-${suffix}`, 1);
      expect(afterRelease.status).toBe('active');

      // A voided/refunded entitlement no longer consumes active purchase allowance.
      await entitlements.saveMany([{ ...paidEntitlement, status: 'void', version: 2 }]);
      await carts.release(winningSixUnitHold.value.id);
      const afterRefund = await createHold(`after-refund-${suffix}`, 6);
      expect(afterRefund.status).toBe('active');

      // Expired Firestore holds stop consuming allowance even before cleanup runs.
      await db
        .collection('v2_cart_reservations')
        .doc(afterRefund.id)
        .update({
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
      const afterExpiry = await createHold(`after-expiry-${suffix}`, 9);
      expect(afterExpiry.status).toBe('active');
      await expect(createHold(`over-expiry-cap-${suffix}`, 1)).rejects.toThrow(
        /maximum of 10 paid/,
      );
    } finally {
      const remaining = await db
        .collection('v2_cart_reservations')
        .where('eventId', '==', eventId)
        .get();
      await Promise.all(remaining.docs.map((doc) => doc.ref.delete()));
      const remainingEntitlements = await db
        .collection('v2_entitlements')
        .where('eventId', '==', eventId)
        .get();
      await Promise.all(remainingEntitlements.docs.map((doc) => doc.ref.delete()));
      await db.collection('v2_hold_sequences').doc(eventId).delete();
      await db.terminate();
    }
  }, 30_000);
});
