import { randomUUID } from 'node:crypto';

import { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const now = new Date('2026-11-05T12:00:00.000Z');

function fixture() {
  if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
    throw new Error('Expiry regressions require a loopback Firestore emulator');
  const db = new Firestore({ projectId: `demo-m4-claim-${randomUUID().slice(0, 8)}` });
  const hold = createCartReservation({
    id: `HOLD-${randomUUID()}`,
    eventId: `EVT-${randomUUID()}`,
    organizationId: 'ORG-local',
    userId: 'USR-local',
    lines: [{ tierId: 'TIER-local', tierName: 'General', quantity: 1, unitPricePaise: 1000 }],
    pricing: {
      currency: 'INR',
      lines: [
        {
          tierId: 'TIER-local',
          tierName: 'General',
          quantity: 1,
          unitPricePaise: 1000,
          subtotalPaise: 1000,
        },
      ],
      appliedPromoCode: null,
      subtotalPaise: 1000,
      discountPaise: 0,
      discountedSubtotalPaise: 1000,
      platformFeePaise: 50,
      paymentFeePaise: 25,
      gstPaise: 14,
      grandTotalPaise: 1089,
    },
    appliedPromoCode: null,
    attribution: null,
    idempotencyKey: randomUUID(),
    reservationTtlMs: 1000,
    now,
  });
  return { db, hold, repository: new FirestoreCartReservationRepository(db) };
}

async function cleanup(f: ReturnType<typeof fixture>) {
  await f.db.recursiveDelete(f.db.collection('v2_cart_reservations'));
  await f.db.recursiveDelete(f.db.collection('v2_hold_sequences'));
  await f.db.terminate();
}

describe.runIf(EMULATOR)('M4 durable provider order creation claim', () => {
  it('permits one creator across repository instances and preserves the original snapshot', async () => {
    const f = fixture();
    try {
      await f.repository.create(f.hold);
      const second = new FirestoreCartReservationRepository(f.db);
      const results = await Promise.all([
        f.repository.claimProviderOrderCreation(f.hold.id, 'stable-receipt', now),
        second.claimProviderOrderCreation(f.hold.id, 'stable-receipt', now),
      ]);
      expect(results.filter((result) => result?.claimed)).toHaveLength(1);
      expect(results.map((result) => result?.hold.providerOrderCreation)).toEqual([
        expect.objectContaining({
          receipt: 'stable-receipt',
          amountPaise: 1089,
          currency: 'INR',
          holdId: f.hold.id,
        }),
        expect.objectContaining({
          receipt: 'stable-receipt',
          amountPaise: 1089,
          currency: 'INR',
          holdId: f.hold.id,
        }),
      ]);
      await f.repository.markProviderOrderRequiresSupport(f.hold.id, 'stable-receipt');
      const restarted = await second.claimProviderOrderCreation(f.hold.id, 'different-key', now);
      expect(restarted?.claimed).toBe(false);
      expect(restarted?.hold.providerOrderCreation).toMatchObject({
        receipt: 'stable-receipt',
        state: 'requires_support',
      });
      await second.bindProviderOrder(f.hold.id, 'order-recovered');
      expect((await f.repository.getById(f.hold.id))?.providerOrderCreation?.state).toBe('bound');
    } finally {
      await cleanup(f);
    }
  });
  it('does not claim an expired hold', async () => {
    const f = fixture();
    try {
      await f.repository.create(f.hold);
      await expect(
        f.repository.claimProviderOrderCreation(
          f.hold.id,
          'receipt',
          new Date(now.getTime() + 2000),
        ),
      ).rejects.toThrow();
      expect((await f.repository.getById(f.hold.id))?.providerOrderCreation).toBeNull();
    } finally {
      await cleanup(f);
    }
  });
});
