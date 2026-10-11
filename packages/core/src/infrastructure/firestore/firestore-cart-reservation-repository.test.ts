import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';

import { FirestoreCartReservationRepository } from './firestore-cart-reservation-repository.js';

import type { DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * A minimal Firestore stand-in, faithful to the one guarantee `bindProviderOrder`
 * relies on: a transaction commits only if nothing it READ was written since, and
 * is otherwise retried from the top. Without that, two concurrent attempts could
 * both read "unbound" and both write — and the first-writer-wins rule would be a
 * convenient fiction. (It does not model queries or batches; only what is used.)
 */
class FakeFirestore {
  docs = new Map<string, DocumentData>();
  private writes = new Map<string, number>();
  /** How many times a transaction body was started, retries included. */
  transactionRuns = 0;

  collection(name: string) {
    return {
      doc: (id: string) => {
        const path = `${name}/${id}`;
        return {
          path,
          get: async () => {
            const data = this.docs.get(path);
            return { data: () => (data ? { ...data } : undefined) };
          },
        };
      },
    };
  }

  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (;;) {
      this.transactionRuns += 1;
      const reads = new Map<string, number>();
      const pending = new Map<string, DocumentData>();
      const tx = {
        get: async (ref: { path: string }) => {
          reads.set(ref.path, this.writes.get(ref.path) ?? 0);
          // Yield so a concurrent transaction can interleave between read and commit.
          await Promise.resolve();
          const data = this.docs.get(ref.path);
          return { data: () => (data ? { ...data } : undefined) };
        },
        set: (ref: { path: string }, data: DocumentData) => {
          pending.set(ref.path, data);
        },
      };
      const result = await fn(tx);
      const stale = [...reads].some(([path, seen]) => (this.writes.get(path) ?? 0) !== seen);
      if (stale) continue; // Firestore retries a transaction whose reads were invalidated
      for (const [path, data] of pending) {
        this.docs.set(path, data);
        this.writes.set(path, (this.writes.get(path) ?? 0) + 1);
      }
      return result;
    }
  }
}

const pricing = {
  currency: 'INR',
  subtotalPaise: 1000,
  discountPaise: 0,
  discountedSubtotalPaise: 1000,
  platformFeePaise: 50,
  paymentFeePaise: 25,
  gstPaise: 14,
  grandTotalPaise: 1089,
} as never;

const hold = (id = 'HOLD-1') =>
  createCartReservation({
    id,
    eventId: 'evt_1',
    organizationId: 'org_1',
    userId: 'user_1',
    lines: [{ tierId: 't', tierName: 'GA', quantity: 1, unitPricePaise: 1000 }],
    pricing,
    appliedPromoCode: null,
    attribution: null,
    idempotencyKey: 'k1',
  });

function setup() {
  const fake = new FakeFirestore();
  const repo = new FirestoreCartReservationRepository(fake as unknown as Firestore);
  const seed = (h = hold()) => {
    fake.docs.set(`v2_cart_reservations/${h.id}`, {
      ...h,
      providerOrderId: undefined, // a hold written before the field existed
    });
  };
  return { fake, repo, seed };
}

describe('FirestoreCartReservationRepository.bindProviderOrder', () => {
  it('binds the first provider order and persists it', async () => {
    const { fake, repo, seed } = setup();
    seed();

    expect(await repo.bindProviderOrder('HOLD-1', 'order_A')).toBe('order_A');
    expect(fake.docs.get('v2_cart_reservations/HOLD-1')?.providerOrderId).toBe('order_A');
    expect((await repo.getById('HOLD-1'))?.providerOrderId).toBe('order_A');
  });

  it('is first-writer-wins and does not rewrite an already-bound hold', async () => {
    const { fake, repo, seed } = setup();
    seed();
    await repo.bindProviderOrder('HOLD-1', 'order_A');
    const before = fake.docs.get('v2_cart_reservations/HOLD-1');

    expect(await repo.bindProviderOrder('HOLD-1', 'order_B')).toBe('order_A');
    expect(fake.docs.get('v2_cart_reservations/HOLD-1')).toEqual(before);
  });

  it('returns null for a hold that does not exist and creates nothing', async () => {
    const { fake, repo } = setup();
    expect(await repo.bindProviderOrder('HOLD-nope', 'order_A')).toBeNull();
    expect(fake.docs.size).toBe(0);
  });

  it('two racing attempts converge on a single provider order', async () => {
    const { fake, repo, seed } = setup();
    seed();

    const [a, b] = await Promise.all([
      repo.bindProviderOrder('HOLD-1', 'order_A'),
      repo.bindProviderOrder('HOLD-1', 'order_B'),
    ]);

    // Both callers are told the same winner, and it is what was stored.
    expect(a).toBe(b);
    expect(['order_A', 'order_B']).toContain(a);
    expect(fake.docs.get('v2_cart_reservations/HOLD-1')?.providerOrderId).toBe(a);
    // The loser's transaction was retried, not silently double-written.
    expect(fake.transactionRuns).toBeGreaterThan(2);
  });

  it('reads a hold stored without the field as unbound, not as an error', async () => {
    const { repo, seed } = setup();
    seed();
    expect((await repo.getById('HOLD-1'))?.providerOrderId).toBeNull();
  });
});
