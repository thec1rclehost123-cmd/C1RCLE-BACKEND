import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  applyPercent,
  calculatePricing,
  GST_PERCENT,
  PAYMENT_FEE_PERCENT,
  PLATFORM_FEE_PERCENT,
  partnerGrossPaise,
  platformRevenuePaise,
} from './models/pricing.js';

import type { PromoCode, TicketTier } from './models/event-catalog.js';

function tier(overrides: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 'tier_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    name: 'General',
    description: '',
    entryType: 'general',
    currency: 'INR',
    priceInPaise: 100_000, // ₹1000
    quantity: 100,
    status: 'active',
    salesStartAt: null,
    salesEndAt: null,
    minPerOrder: null,
    maxPerOrder: null,
    version: 1,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function promo(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: 'promo_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    code: 'SAVE10',
    name: 'SAVE10',
    type: 'public',
    discountType: 'percent',
    discountValue: 10,
    tierIds: [],
    maxRedemptions: null,
    maxPerUser: null,
    redemptionCount: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    version: 1,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyPercent', () => {
  it('stays in integer arithmetic for fractional percentages', () => {
    // 2.5% of ₹8.00. In float, 800 * 0.025 = 20.000000000000004.
    expect(applyPercent(800, 2.5)).toBe(20);
  });

  it('rounds half up, as v1 did', () => {
    // 5% of 1050 paise = 52.5 → 53.
    expect(applyPercent(1050, 5)).toBe(53);
  });

  it('never returns a fraction', () => {
    for (const amount of [1, 7, 33, 99, 12_345, 999_999]) {
      for (const percent of [2.5, 5, 18]) {
        expect(Number.isInteger(applyPercent(amount, percent))).toBe(true);
      }
    }
  });
});

describe('calculatePricing', () => {
  it('computes the v1 formula end to end', () => {
    const result = calculatePricing({ lines: [{ tier: tier(), quantity: 2 }] });

    expect(result.subtotalPaise).toBe(200_000);
    expect(result.discountPaise).toBe(0);
    expect(result.discountedSubtotalPaise).toBe(200_000);
    expect(result.platformFeePaise).toBe(10_000); // 5%
    expect(result.paymentFeePaise).toBe(5_000); // 2.5%
    expect(result.gstPaise).toBe(2_700); // 18% of 15_000
    expect(result.grandTotalPaise).toBe(217_700);
  });

  it('charges GST on the fees only, never on the ticket price', () => {
    const result = calculatePricing({ lines: [{ tier: tier(), quantity: 1 }] });
    const feeTotal = result.platformFeePaise + result.paymentFeePaise;
    expect(result.gstPaise).toBe(Math.round((feeTotal * GST_PERCENT) / 100));
    // 18% of the ₹75 in fees = ₹13.50. Charging GST on the ₹1000 ticket
    // instead would make this 18_000.
    expect(result.gstPaise).toBe(1_350);
    expect(result.gstPaise).not.toBe(applyPercent(result.discountedSubtotalPaise, GST_PERCENT));
  });

  it('applies fees to the DISCOUNTED subtotal, not the original', () => {
    const undiscounted = calculatePricing({ lines: [{ tier: tier(), quantity: 1 }] });
    const discounted = calculatePricing({
      lines: [{ tier: tier(), quantity: 1 }],
      promo: promo({ discountValue: 50 }),
    });

    expect(discounted.discountPaise).toBe(50_000);
    expect(discounted.discountedSubtotalPaise).toBe(50_000);
    // Half the ticket value ⇒ half the fees. Charging the pre-discount fee
    // would leave these equal.
    expect(discounted.platformFeePaise).toBe(undiscounted.platformFeePaise / 2);
  });

  it('caps a fixed promo at the eligible subtotal rather than going negative', () => {
    const result = calculatePricing({
      lines: [{ tier: tier({ priceInPaise: 30_000 }), quantity: 1 }],
      promo: promo({ discountType: 'fixed', discountValue: 50_000 }),
    });

    expect(result.discountPaise).toBe(30_000);
    expect(result.discountedSubtotalPaise).toBe(0);
    expect(result.grandTotalPaise).toBe(0);
  });

  it('discounts only the tiers a scoped promo names', () => {
    const general = tier({ id: 'tier_general', priceInPaise: 100_000 });
    const vip = tier({ id: 'tier_vip', name: 'VIP', priceInPaise: 300_000 });

    const result = calculatePricing({
      lines: [
        { tier: general, quantity: 1 },
        { tier: vip, quantity: 1 },
      ],
      promo: promo({ discountValue: 10, tierIds: ['tier_vip'] }),
    });

    // 10% of the VIP line only — not of the ₹4000 cart.
    expect(result.discountPaise).toBe(30_000);
  });

  it('reports no applied code when the promo discounts nothing', () => {
    const result = calculatePricing({
      lines: [{ tier: tier({ id: 'tier_general' }), quantity: 1 }],
      promo: promo({ tierIds: ['tier_vip_not_in_cart'] }),
    });

    expect(result.discountPaise).toBe(0);
    expect(result.appliedPromoCode).toBeNull();
  });

  it('always reconciles: parts sum to the grand total', () => {
    // Prices chosen to force rounding in every term.
    for (const priceInPaise of [1, 33, 777, 1_050, 9_999, 123_457]) {
      for (const quantity of [1, 3, 7]) {
        const result = calculatePricing({ lines: [{ tier: tier({ priceInPaise }), quantity }] });
        expect(result.grandTotalPaise).toBe(
          result.discountedSubtotalPaise +
            result.platformFeePaise +
            result.paymentFeePaise +
            result.gstPaise,
        );
        expect(Number.isInteger(result.grandTotalPaise)).toBe(true);
      }
    }
  });

  it('refuses a mixed-currency cart', () => {
    expect(() =>
      calculatePricing({
        lines: [
          { tier: tier(), quantity: 1 },
          { tier: tier({ id: 'tier_2', currency: 'USD' }), quantity: 1 },
        ],
      }),
    ).toThrow(InvalidOperationError);
  });

  it('enforces the tier per-order bounds', () => {
    expect(() =>
      calculatePricing({ lines: [{ tier: tier({ maxPerOrder: 4 }), quantity: 5 }] }),
    ).toThrow(/maximum of 4/);
    expect(() =>
      calculatePricing({ lines: [{ tier: tier({ minPerOrder: 2 }), quantity: 1 }] }),
    ).toThrow(/minimum of 2/);
  });

  it('refuses a fractional or non-positive quantity', () => {
    expect(() => calculatePricing({ lines: [{ tier: tier(), quantity: 1.5 }] })).toThrow(
      InvalidOperationError,
    );
    expect(() => calculatePricing({ lines: [{ tier: tier(), quantity: 0 }] })).toThrow(
      InvalidOperationError,
    );
  });

  it('refuses an empty cart', () => {
    expect(() => calculatePricing({ lines: [] })).toThrow(InvalidOperationError);
  });

  it('captures the unit price at quote time', () => {
    const quoted = tier({ priceInPaise: 100_000 });
    const result = calculatePricing({ lines: [{ tier: quoted, quantity: 1 }] });
    // A later tier edit must not be able to reach back into this quote.
    expect(result.lines[0]?.unitPricePaise).toBe(100_000);
  });
});

describe('settlement inputs', () => {
  it('excludes GST from platform revenue — it passes through to the tax authority', () => {
    const result = calculatePricing({ lines: [{ tier: tier(), quantity: 1 }] });
    expect(platformRevenuePaise(result)).toBe(result.platformFeePaise);
    expect(platformRevenuePaise(result)).not.toBe(result.platformFeePaise + result.gstPaise);
  });

  it('reports the partner gross as the discounted ticket value', () => {
    const result = calculatePricing({
      lines: [{ tier: tier(), quantity: 2 }],
      promo: promo({ discountValue: 10 }),
    });
    expect(partnerGrossPaise(result)).toBe(180_000);
  });

  it('keeps the fee rates at their contractual values', () => {
    // A silent rate change is a pricing incident; pin them.
    expect(PLATFORM_FEE_PERCENT).toBe(5);
    expect(PAYMENT_FEE_PERCENT).toBe(2.5);
    expect(GST_PERCENT).toBe(18);
  });
});
