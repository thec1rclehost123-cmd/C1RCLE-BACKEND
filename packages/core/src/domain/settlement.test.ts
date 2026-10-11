import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import { computeSettlementLegs } from './models/settlement.js';

const sum = (l: ReturnType<typeof computeSettlementLegs>) =>
  l.platformFee + l.venueShare + l.promoterCommission + l.hostPayout;

describe('computeSettlementLegs', () => {
  it('reproduces the worked example from the payments design (host-owned 80/20, promoter ₹100, no commission)', () => {
    // ₹1,000 of tickets → fees ₹50 + ₹25, GST ₹13.50 on them → ₹1,088.50 paid.
    const legs = computeSettlementLegs({
      subtotalPaise: 100_000,
      customerFeesPaise: 7_500 + 1_350,
      commissionBps: 0,
      venueBps: 2_000,
      promoterAmountPaise: 10_000,
    });
    expect(legs).toEqual({
      platformFee: 8_850, // ₹88.50 = customer fees + GST
      promoterCommission: 10_000, // ₹100
      venueShare: 18_000, // 20% of ₹900
      hostPayout: 72_000, // ₹720
    });
    expect(sum(legs)).toBe(108_850);
  });

  it('charges commission on the ticket subtotal, not on fees or GST', () => {
    const legs = computeSettlementLegs({
      subtotalPaise: 100_000,
      customerFeesPaise: 8_850,
      commissionBps: 1_000, // 10% of ₹1,000 = ₹100
      venueBps: 0,
      promoterAmountPaise: null,
    });
    expect(legs.platformFee).toBe(8_850 + 10_000);
    expect(legs.hostPayout).toBe(90_000);
    expect(sum(legs)).toBe(100_000 + 8_850);
  });

  it('pays the promoter first, which shrinks both the venue and host shares', () => {
    const without = computeSettlementLegs({
      subtotalPaise: 100_000,
      customerFeesPaise: 0,
      commissionBps: 0,
      venueBps: 5_000,
      promoterAmountPaise: null,
    });
    const withPromoter = computeSettlementLegs({
      subtotalPaise: 100_000,
      customerFeesPaise: 0,
      commissionBps: 0,
      venueBps: 5_000,
      promoterAmountPaise: 20_000,
    });
    expect(without.venueShare).toBe(50_000);
    expect(withPromoter.venueShare).toBe(40_000);
    expect(withPromoter.hostPayout).toBe(40_000);
  });

  it('caps a promoter above the ticket revenue instead of going negative', () => {
    const legs = computeSettlementLegs({
      subtotalPaise: 10_000,
      customerFeesPaise: 885,
      commissionBps: 1_000,
      venueBps: 3_000,
      promoterAmountPaise: 50_000,
    });
    expect(legs.promoterCommission).toBe(9_000); // subtotal − commission
    expect(legs.venueShare).toBe(0);
    expect(legs.hostPayout).toBe(0);
    expect(sum(legs)).toBe(10_885);
  });

  it('gives the host the rounding paisa, never lets the legs drift off the total', () => {
    const legs = computeSettlementLegs({
      subtotalPaise: 10_001,
      customerFeesPaise: 0,
      commissionBps: 0,
      venueBps: 3_333,
      promoterAmountPaise: null,
    });
    expect(legs.venueShare).toBe(Math.round((10_001 * 3_333) / 10_000));
    expect(legs.venueShare + legs.hostPayout).toBe(10_001);
  });

  it('pays everything to the host when there is no venue share', () => {
    const legs = computeSettlementLegs({
      subtotalPaise: 12_345,
      customerFeesPaise: 100,
      commissionBps: 0,
      venueBps: 0,
      promoterAmountPaise: null,
    });
    expect(legs).toEqual({
      platformFee: 100,
      venueShare: 0,
      promoterCommission: 0,
      hostPayout: 12_345,
    });
  });

  it('handles a fully discounted (free) order', () => {
    const legs = computeSettlementLegs({
      subtotalPaise: 0,
      customerFeesPaise: 0,
      commissionBps: 1_000,
      venueBps: 2_000,
      promoterAmountPaise: 500,
    });
    expect(legs).toEqual({ platformFee: 0, venueShare: 0, promoterCommission: 0, hostPayout: 0 });
  });

  it('keeps every leg non-negative and the sum exact across many random splits', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 12345;
    const rnd = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed % (max + 1);
    };
    for (let i = 0; i < 5_000; i++) {
      const subtotalPaise = rnd(5_000_000);
      const customerFeesPaise = rnd(500_000);
      const input = {
        subtotalPaise,
        customerFeesPaise,
        commissionBps: rnd(10_000),
        venueBps: rnd(10_000),
        promoterAmountPaise: rnd(1) === 0 ? null : rnd(6_000_000),
      };
      const legs = computeSettlementLegs(input);
      expect(Object.values(legs).every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
      expect(sum(legs)).toBe(subtotalPaise + customerFeesPaise);
    }
  });

  it.each([
    ['a fractional subtotal', { subtotalPaise: 10.5 }],
    ['a negative subtotal', { subtotalPaise: -1 }],
    ['commission over 100%', { commissionBps: 10_001 }],
    ['a negative venue share', { venueBps: -5 }],
    ['a fractional promoter amount', { promoterAmountPaise: 1.5 }],
  ])('rejects %s', (_label, overrides) => {
    expect(() =>
      computeSettlementLegs({
        subtotalPaise: 1_000,
        customerFeesPaise: 0,
        commissionBps: 0,
        venueBps: 0,
        promoterAmountPaise: null,
        ...overrides,
      }),
    ).toThrow(InvalidOperationError);
  });
});
