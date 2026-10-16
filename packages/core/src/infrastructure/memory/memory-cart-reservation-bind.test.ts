import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';

import { MemoryCartReservationRepository } from './memory-repositories.js';

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

const hold = () =>
  createCartReservation({
    id: 'HOLD-1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    userId: 'user_1',
    lines: [{ tierId: 't', tierName: 'GA', quantity: 1, unitPricePaise: 1000 }],
    pricing,
    appliedPromoCode: null,
    attribution: null,
    idempotencyKey: 'k1',
  });

describe('CartReservationRepository.bindProviderOrder', () => {
  it('starts unbound and binds the first provider order', async () => {
    const repo = new MemoryCartReservationRepository();
    await repo.create(hold());
    expect((await repo.getById('HOLD-1'))?.providerOrderId).toBeNull();

    expect(await repo.bindProviderOrder('HOLD-1', 'order_A')).toBe('order_A');
    expect((await repo.getById('HOLD-1'))?.providerOrderId).toBe('order_A');
  });

  it('is first-writer-wins: a later bind returns the original order and changes nothing', async () => {
    const repo = new MemoryCartReservationRepository();
    await repo.create(hold());
    await repo.bindProviderOrder('HOLD-1', 'order_A');

    expect(await repo.bindProviderOrder('HOLD-1', 'order_B')).toBe('order_A');
    expect(await repo.bindProviderOrder('HOLD-1', 'order_A')).toBe('order_A');
    expect((await repo.getById('HOLD-1'))?.providerOrderId).toBe('order_A');
  });

  it('returns null for an unknown hold', async () => {
    const repo = new MemoryCartReservationRepository();
    expect(await repo.bindProviderOrder('HOLD-nope', 'order_A')).toBeNull();
  });
});
