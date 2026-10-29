import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { CheckoutService } from '../../application/checkout/checkout-service.js';
import { InventoryService } from '../../application/inventory/inventory-service.js';
import { PricingService } from '../../application/pricing/pricing-service.js';
import { createCoreConfig } from '../../config/index.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';
import { MemoryOutboxStore } from '../memory/memory-outbox-store.js';
import {
  MemoryEntitlementRepository,
  MemoryEventRepository,
  MemoryOrderRepository,
} from '../memory/memory-repositories.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreEventCatalogRepository } from './firestore-event-catalog-repository.js';

import type { ActorContext, ServiceDeps } from '../../application/context.js';
import type { CartReservation } from '../../domain/models/cart-reservation.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore ticket add-on inventory', () => {
  it('allows only one concurrent hold for the final add-on unit', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const eventId = `addon-event-${suffix}`;
    const organizationId = `addon-org-${suffix}`;
    const tierId = `addon-tier-${suffix}`;
    const addonId = `addon-sku-${suffix}`;
    const now = new Date();
    const events = new MemoryEventRepository();
    const catalog = new FirestoreEventCatalogRepository(db);
    const carts = new FirestoreCartReservationRepository(db);
    const orders = new MemoryOrderRepository();
    const entitlements = new MemoryEntitlementRepository();
    let event = createEvent({
      id: eventId,
      organizationId,
      venueId: `addon-venue-${suffix}`,
      title: 'Disposable add-on inventory scenario',
      startAt: new Date(now.getTime() + 86_400_000).toISOString(),
      now,
    });
    for (const status of ['review', 'scheduled', 'published'] as const) {
      event = transitionEvent(event, status, now);
    }

    try {
      await events.save({ ...event, version: 1 });
      await catalog.saveTier(
        createTicketTier({
          id: tierId,
          eventId,
          organizationId,
          name: 'General',
          priceInPaise: 10_000,
          quantity: 5,
          now,
        }),
      );
      await catalog.saveTicketAddon(
        createTicketAddon({
          id: addonId,
          eventId,
          organizationId,
          name: 'Parking pass',
          kind: 'parking',
          priceInPaise: 5_000,
          quantity: 1,
          now,
        }),
      );

      const config = createCoreConfig({
        redis: { url: 'redis://localhost:6379' },
        firestore: { projectId: 'demo-c1rcle' },
        features: { m5TicketAddonsEnabled: true },
      });
      const deps = {
        config,
        outbox: new MemoryOutboxStore(),
        pricing: new PricingService({ eventCatalog: catalog }),
        inventory: new InventoryService({
          eventCatalog: catalog,
          cartReservation: carts,
          order: orders,
        }),
        repositories: { events, catalog, cartReservations: carts, orders, entitlements },
      } as unknown as ServiceDeps;
      const checkout = new CheckoutService(deps);
      const hold = async (userId: string): Promise<CartReservation> => {
        const actor: ActorContext = {
          userId,
          organizationId,
          role: 'owner',
          capabilities: [],
        };
        const quote = await checkout.quote({
          actor,
          eventId,
          lines: [{ tierId, quantity: 1, ticketAddons: [{ addonId, quantityPerEntitlement: 1 }] }],
        });
        return checkout.createHold({
          actor,
          eventId,
          organizationId,
          lines: quote.pricing.lines.map((line) => ({
            tierId: line.tierId,
            tierName: line.tierName,
            quantity: line.quantity,
            unitPricePaise: line.unitPricePaise,
            admissionUnitPricePaise: line.admissionUnitPricePaise,
            coverUnitPricePaise: line.coverUnitPricePaise,
            ticketAddons: line.ticketAddons,
          })),
          pricing: quote.pricing,
          appliedPromoCode: null,
          attribution: null,
          idempotencyKey: `addon-hold-${userId}`,
        });
      };

      const competing = await Promise.allSettled([
        hold(`addon-user-a-${suffix}`),
        hold(`addon-user-b-${suffix}`),
      ]);
      expect(
        competing.filter((result) => result.status === 'fulfilled'),
        competing
          .map((result) =>
            result.status === 'rejected'
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : result.status,
          )
          .join('; '),
      ).toHaveLength(1);
      expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(1);
    } finally {
      const remaining = await db
        .collection('v2_cart_reservations')
        .where('eventId', '==', eventId)
        .get();
      await Promise.all(remaining.docs.map((doc) => doc.ref.delete()));
      await db.collection('v2_event_ticket_addons').doc(addonId).delete();
      await db.collection('v2_event_catalog_tiers').doc(tierId).delete();
      await db.collection('v2_hold_sequences').doc(eventId).delete();
      await db.terminate();
    }
  }, 30_000);
});
