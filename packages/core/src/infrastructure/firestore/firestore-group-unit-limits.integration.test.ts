import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';
import { FirestoreOrderRepository } from './firestore-order-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

describe.runIf(EMULATOR)('Firestore per-person group unit accounting', () => {
  it('counts each attendee in paid orders and active holds', async () => {
    const db = new Firestore({ projectId: 'demo-c1rcle' });
    const suffix = randomUUID();
    const userId = `m5-group-user-${suffix}`;
    const eventId = `m5-group-event-${suffix}`;
    const tierId = `m5-group-tier-${suffix}`;
    const orderId = `m5-group-order-${suffix}`;
    const holdId = `m5-group-hold-${suffix}`;
    const now = new Date();
    const orderRef = db.collection('v2_orders').doc(orderId);
    const holdRef = db.collection('v2_cart_reservations').doc(holdId);
    const sequenceRef = db.collection('v2_hold_sequences').doc(eventId);

    try {
      await orderRef.set({
        id: orderId,
        eventId,
        organizationId: `m5-group-org-${suffix}`,
        userId,
        contact: { name: 'Disposable', email: '', phone: '' },
        status: 'paid',
        lines: [
          {
            tierId,
            tierName: 'Group',
            quantity: 2,
            unitPricePaise: 1000,
            subtotalPaise: 2000,
            guestCount: 3,
            admissionMode: 'per_person',
          },
        ],
        currency: 'INR',
        subtotalPaise: 2000,
        discountPaise: 0,
        discountFundingOwner: null,
        discountedSubtotalPaise: 2000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 2000,
        appliedPromoCode: null,
        attribution: null,
        paymentIntentId: `m5-group-intent-${suffix}`,
        paymentId: `m5-group-payment-${suffix}`,
        paidAt: now.toISOString(),
        reservationExpiresAt: now.toISOString(),
        failureReason: null,
        eventCancellation: null,
        refundedPaise: 0,
        appliedRefundRequestIds: [],
        version: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });

      const hold = createCartReservation({
        id: holdId,
        eventId,
        organizationId: `m5-group-org-${suffix}`,
        userId,
        lines: [
          {
            tierId,
            tierName: 'Group',
            quantity: 1,
            unitPricePaise: 1000,
            guestCount: 3,
            admissionMode: 'per_person',
          },
        ],
        pricing: {
          lines: [],
          subtotalPaise: 1000,
          discountPaise: 0,
          discountedSubtotalPaise: 1000,
          platformFeePaise: 0,
          paymentFeePaise: 0,
          gstPaise: 0,
          grandTotalPaise: 1000,
          appliedPromoCode: null,
          currency: 'INR',
        },
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: `m5-group-key-${suffix}`,
        now,
      });
      await new FirestoreCartReservationRepository(db).create(hold);

      expect(
        await new FirestoreOrderRepository(db).countPaidQuantityByUserAndEvent(
          userId,
          eventId,
          tierId,
        ),
      ).toBe(6);
      expect(
        await new FirestoreCartReservationRepository(db).countActiveQuantity(
          userId,
          eventId,
          tierId,
          now,
        ),
      ).toBe(3);
    } finally {
      await Promise.all([orderRef.delete(), holdRef.delete(), sequenceRef.delete()]);
      await db.terminate();
    }
  }, 30_000);
});
