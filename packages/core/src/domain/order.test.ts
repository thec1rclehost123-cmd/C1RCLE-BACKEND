import { describe, expect, it } from 'vitest';

import { InvalidOperationError, StateTransitionError } from './errors.js';
import {
  canAdmit,
  entitlementId,
  issueEntitlements,
  remainingAdmissions,
  scanEntitlement,
  voidEntitlement,
} from './models/entitlement.js';
import {
  attachPaymentIntent,
  cancelOrder,
  createOrder,
  expireOrder,
  holdsInventory,
  isReservationExpired,
  markFailed,
  markPaid,
  totalUnits,
} from './models/order.js';
import { calculatePricing } from './models/pricing.js';

import type { TicketTier } from './models/event-catalog.js';
import type { Order } from './models/order.js';

const T0 = new Date('2026-08-14T12:00:00.000Z');

function tier(overrides: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 'tier_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    name: 'General',
    description: '',
    entryType: 'general',
    currency: 'INR',
    priceInPaise: 100_000,
    quantity: 100,
    status: 'active',
    salesStartAt: null,
    salesEndAt: null,
    minPerOrder: null,
    maxPerOrder: null,
    version: 1,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...overrides,
  };
}

function order(lines = [{ tier: tier(), quantity: 2 }], now = T0): Order {
  return createOrder({
    id: 'ord_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    userId: 'user_1',
    contact: { name: 'A. Guest', email: 'guest@example.com', phone: '9876543210' },
    pricing: calculatePricing({ lines }),
    now,
  });
}

function paidOrder(): Order {
  const withIntent = attachPaymentIntent(order(), 'order_razorpay_1', T0);
  return markPaid(withIntent, 'pay_razorpay_1', T0);
}

describe('order lifecycle', () => {
  it('freezes the pricing breakdown onto the order', () => {
    const created = order();
    expect(created.subtotalPaise).toBe(200_000);
    expect(created.grandTotalPaise).toBe(217_700);
    expect(created.status).toBe('pending');
    expect(totalUnits(created)).toBe(2);
  });

  it('holds inventory until the reservation lapses', () => {
    const created = order();
    const beforeExpiry = new Date(T0.getTime() + 9 * 60 * 1000);
    const afterExpiry = new Date(T0.getTime() + 11 * 60 * 1000);

    expect(isReservationExpired(created, beforeExpiry)).toBe(false);
    expect(holdsInventory(created, beforeExpiry)).toBe(true);
    expect(isReservationExpired(created, afterExpiry)).toBe(true);
    expect(holdsInventory(created, afterExpiry)).toBe(false);
  });

  it('refuses to attach an intent to a lapsed reservation', () => {
    const created = order();
    const afterExpiry = new Date(T0.getTime() + 11 * 60 * 1000);
    expect(() => attachPaymentIntent(created, 'order_razorpay_1', afterExpiry)).toThrow(/expired/);
  });

  it('refuses a second, different payment intent', () => {
    const withIntent = attachPaymentIntent(order(), 'order_razorpay_1', T0);
    expect(() => attachPaymentIntent(withIntent, 'order_razorpay_2', T0)).toThrow(
      InvalidOperationError,
    );
  });

  it('treats re-attaching the same intent as a no-op', () => {
    const withIntent = attachPaymentIntent(order(), 'order_razorpay_1', T0);
    const again = attachPaymentIntent(withIntent, 'order_razorpay_1', T0);
    expect(again).toBe(withIntent);
    expect(again.version).toBe(withIntent.version);
  });

  it('a paid order still holds its inventory past the reservation window', () => {
    const paid = paidOrder();
    const longAfter = new Date(T0.getTime() + 60 * 60 * 1000);
    // The hold expiring must never release a seat someone paid for.
    expect(holdsInventory(paid, longAfter)).toBe(true);
  });

  it('refuses to pay a cancelled order', () => {
    const cancelled = cancelOrder(order(), 'changed my mind', T0);
    expect(() => markPaid(cancelled, 'pay_1', T0)).toThrow(StateTransitionError);
  });

  it('does not allow a failed order to be retried in place', () => {
    const withIntent = attachPaymentIntent(order(), 'order_razorpay_1', T0);
    const failed = markFailed(withIntent, 'card declined', T0);
    // A retry is a NEW order — reusing this one makes the payment id ambiguous.
    expect(() => markPaid(failed, 'pay_1', T0)).toThrow(StateTransitionError);
  });

  it('expiry records why, and is idempotent', () => {
    const expired = expireOrder(order(), T0);
    expect(expired.status).toBe('expired');
    expect(expired.failureReason).toMatch(/expired/i);
    expect(expireOrder(expired, T0)).toBe(expired);
  });
});

/**
 * The webhook/redirect race is the single highest-risk path in checkout: both
 * arrive, in either order, for every successful payment.
 */
describe('the two confirmation paths race', () => {
  it('applies the second confirmation as a no-op, whichever arrives second', () => {
    const withIntent = attachPaymentIntent(order(), 'order_razorpay_1', T0);

    const firstPath = markPaid(withIntent, 'pay_razorpay_1', T0);
    const secondPath = markPaid(firstPath, 'pay_razorpay_1', new Date(T0.getTime() + 1_000));

    expect(secondPath).toBe(firstPath);
    // Critically, the version does NOT bump — the second path must not fail an
    // optimistic-lock check just for being second.
    expect(secondPath.version).toBe(firstPath.version);
    expect(secondPath.paidAt).toBe(firstPath.paidAt);
  });

  it('refuses two DIFFERENT payments against one order', () => {
    const paid = paidOrder();
    // Not a race — two captures. A human needs to see this.
    expect(() => markPaid(paid, 'pay_razorpay_DIFFERENT', T0)).toThrow(/different payment id/);
  });
});

describe('entitlement issuance', () => {
  it('refuses to issue for an unpaid order', () => {
    expect(() => issueEntitlements({ order: order(), now: T0 })).toThrow(/only for a paid order/);
  });

  it('issues one entitlement per unit with deterministic ids', () => {
    const issued = issueEntitlements({ order: paidOrder(), now: T0 });

    expect(issued).toHaveLength(2);
    expect(issued.map((entitlement) => entitlement.id)).toEqual([
      entitlementId('ord_1', 'tier_1', 0),
      entitlementId('ord_1', 'tier_1', 1),
    ]);
    expect(issued[0]?.id).toBe('ENT-ord_1-tier_1-0');
  });

  it('is idempotent: a re-run produces identical ids', () => {
    const paid = paidOrder();
    const first = issueEntitlements({ order: paid, now: T0 });
    const second = issueEntitlements({ order: paid, now: new Date(T0.getTime() + 5_000) });

    // This is what makes a retried fulfilment safe — the ids collide at the
    // storage layer instead of minting a second set of tickets.
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
  });

  it('a couple ticket is ONE entitlement admitting two, not two entitlements', () => {
    const coupleTier = tier({ id: 'tier_couple', name: 'Couple', priceInPaise: 180_000 });
    const paid = markPaid(
      attachPaymentIntent(order([{ tier: coupleTier, quantity: 1 }]), 'order_1', T0),
      'pay_1',
      T0,
    );

    const issued = issueEntitlements({
      order: paid,
      admitsPerUnit: { tier_couple: 2 },
      now: T0,
    });

    // Two entitlements would let the pair split across different doors, which
    // is exactly what a couple ticket is priced not to allow.
    expect(issued).toHaveLength(1);
    expect(issued[0]?.scanCountAllowed).toBe(2);
  });
});

describe('scanning', () => {
  function coupleEntitlement() {
    const coupleTier = tier({ id: 'tier_couple', name: 'Couple' });
    const paid = markPaid(
      attachPaymentIntent(order([{ tier: coupleTier, quantity: 1 }]), 'order_1', T0),
      'pay_1',
      T0,
    );
    const [entitlement] = issueEntitlements({
      order: paid,
      admitsPerUnit: { tier_couple: 2 },
      now: T0,
    });
    if (!entitlement) throw new Error('expected one entitlement');
    return entitlement;
  }

  it('admits one person per scan, so the second guest is not stranded', () => {
    const entitlement = coupleEntitlement();

    const afterFirst = scanEntitlement(entitlement, T0);
    expect(afterFirst.scanCount).toBe(1);
    expect(afterFirst.status).toBe('valid');
    expect(remainingAdmissions(afterFirst)).toBe(1);
    expect(canAdmit(afterFirst)).toBe(true);

    const afterSecond = scanEntitlement(afterFirst, T0);
    expect(afterSecond.scanCount).toBe(2);
    expect(afterSecond.status).toBe('redeemed');
    expect(canAdmit(afterSecond)).toBe(false);
  });

  it('refuses a third scan on a two-person ticket', () => {
    let entitlement = coupleEntitlement();
    entitlement = scanEntitlement(entitlement, T0);
    entitlement = scanEntitlement(entitlement, T0);
    expect(() => scanEntitlement(entitlement, T0)).toThrow(/already been fully used/);
  });

  it('records every scan for the door audit trail', () => {
    const entitlement = scanEntitlement(coupleEntitlement(), T0);
    expect(entitlement.scannedAt).toEqual([T0.toISOString()]);
  });

  it('refuses to scan a voided ticket', () => {
    const voided = voidEntitlement(coupleEntitlement(), T0);
    expect(() => scanEntitlement(voided, T0)).toThrow(/voided/);
    expect(remainingAdmissions(voided)).toBe(0);
  });

  it('can void a ticket that was already used — a refund after entry', () => {
    let entitlement = coupleEntitlement();
    entitlement = scanEntitlement(entitlement, T0);
    entitlement = scanEntitlement(entitlement, T0);
    expect(entitlement.status).toBe('redeemed');
    expect(voidEntitlement(entitlement, T0).status).toBe('void');
  });
});
