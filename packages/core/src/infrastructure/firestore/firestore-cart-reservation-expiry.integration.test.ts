import { randomUUID } from 'node:crypto';

import { Firestore, Query } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const now = new Date('2026-11-05T12:00:00.000Z');

function fixture() {
  if (!EMULATOR || !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR))
    throw new Error('Expiry regressions require a loopback Firestore emulator');
  const db = new Firestore({ projectId: `demo-m4-expiry-${randomUUID().slice(0, 8)}` });
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
    now: new Date(now.getTime() - 2000),
  });
  return { db, hold, repository: new FirestoreCartReservationRepository(db) };
}

async function cleanup(f: ReturnType<typeof fixture>) {
  await f.db.recursiveDelete(f.db.collection('v2_cart_reservations'));
  await f.db.recursiveDelete(f.db.collection('v2_hold_sequences'));
  await f.db.terminate();
}

describe.runIf(EMULATOR)('M4 expiry candidates are conditionally released', () => {
  it.each(['converted', 'revived'] as const)(
    'preserves a hold %s after the sweep selected its stale snapshot',
    async (winner) => {
      const f = fixture();
      await f.repository.create(f.hold);
      await f.repository.bindProviderOrder(f.hold.id, 'order_local');
      let interleaved = false;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Rebound to each real query with .call(this) below.
      const originalGet = Query.prototype.get;
      // The query and competing transition both use the real Emulator. Pause only
      // after its snapshot exists, making the old scan/write race deterministic.
      const selected = vi.spyOn(Query.prototype, 'get').mockImplementation(async function (
        this: Query,
      ) {
        const snapshot = await originalGet.call(this);
        if (!interleaved && snapshot.docs.some((doc) => doc.id === f.hold.id)) {
          interleaved = true;
          if (winner === 'converted') await f.repository.convertToOrder(f.hold.id, 'ORD-local');
          else
            await f.repository.reactivate(f.hold.id, new Date(now.getTime() + 60000).toISOString());
        }
        return snapshot;
      });
      try {
        expect(await f.repository.cleanupExpired(now)).toBe(0);
        expect(interleaved).toBe(true);
        const stored = await f.repository.getById(f.hold.id);
        expect(stored).toMatchObject({
          status: winner === 'converted' ? 'converted' : 'active',
          providerOrderId: 'order_local',
        });
        if (winner === 'converted') expect(stored?.convertedOrderId).toBe('ORD-local');
        else {
          expect(stored?.expiresAt).toBe(new Date(now.getTime() + 60000).toISOString());
          expect(stored?.sequence).toBe(2);
        }
      } finally {
        selected.mockRestore();
        await cleanup(f);
      }
    },
  );

  it('releases an expired active hold once and leaves future and converted holds intact', async () => {
    const f = fixture();
    try {
      await f.repository.create(f.hold);
      const future = {
        ...f.hold,
        id: `HOLD-${randomUUID()}`,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(now.getTime() + 60000).toISOString(),
      };
      const converted = { ...f.hold, id: `HOLD-${randomUUID()}`, idempotencyKey: randomUUID() };
      await f.repository.create(future);
      await f.repository.create(converted);
      await f.repository.convertToOrder(converted.id, 'ORD-already-paid');
      expect(await f.repository.cleanupExpired(now)).toBe(1);
      expect(await f.repository.cleanupExpired(now)).toBe(0);
      expect((await f.repository.getById(f.hold.id))?.status).toBe('released');
      expect((await f.repository.getById(future.id))?.status).toBe('active');
      expect(await f.repository.getById(converted.id)).toMatchObject({
        status: 'converted',
        convertedOrderId: 'ORD-already-paid',
      });
    } finally {
      await cleanup(f);
    }
  });
});
