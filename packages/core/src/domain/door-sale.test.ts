import { describe, expect, it } from 'vitest';

import { createDoorSale } from './models/door-sale.js';

import type { DoorSaleCreateInput } from './models/door-sale.js';

const T0 = new Date('2026-09-01T18:00:00.000Z');

function input(overrides: Partial<DoorSaleCreateInput> = {}): DoorSaleCreateInput {
  return {
    eventId: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    category: 'walkin',
    guestName: 'Ada Lovelace',
    guestPhone: null,
    guestAge: null,
    gender: null,
    contact: null,
    totalGuests: 2,
    tableNumber: null,
    gate: null,
    paymentMode: 'cash',
    amountPaise: 50_000,
    createdBy: 'staff_1',
    createdByName: 'Staff One',
    idempotencyKey: 'idem-1',
    now: T0,
    ...overrides,
  };
}

describe('createDoorSale', () => {
  it('defaults to an active, fully-collected sale with no void/refund state', () => {
    const sale = createDoorSale(input());
    expect(sale.status).toBe('active');
    expect(sale.paymentStatus).toBe('collected');
    expect(sale.paymentRef).toBeNull();
    expect(sale.voidedAt).toBeNull();
    expect(sale.voidedBy).toBeNull();
    expect(sale.voidReason).toBeNull();
    expect(sale.refundedAmountPaise).toBeNull();
    expect(sale.refundedAt).toBeNull();
    expect(sale.refundedBy).toBeNull();
    expect(sale.version).toBe(1);
  });

  it('carries through category, guest, and payment fields unchanged', () => {
    const sale = createDoorSale(input({ category: 'dinein', tableNumber: 'T12', totalGuests: 4 }));
    expect(sale.category).toBe('dinein');
    expect(sale.tableNumber).toBe('T12');
    expect(sale.totalGuests).toBe(4);
    expect(sale.amountPaise).toBe(50_000);
    expect(sale.idempotencyKey).toBe('idem-1');
  });

  it('scopes the id to the venue when one is given', () => {
    const sale = createDoorSale(input({ venueId: 'ven_42' }));
    expect(sale.id).toMatch(/^DS-ven_42-/);
  });

  it('falls back to "unknown" in the id when venueId is null', () => {
    const sale = createDoorSale(input({ venueId: null }));
    expect(sale.id).toMatch(/^DS-unknown-/);
    expect(sale.venueId).toBeNull();
  });
});
