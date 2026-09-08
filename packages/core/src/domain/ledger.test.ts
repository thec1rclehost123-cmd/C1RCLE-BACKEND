import { describe, expect, it } from 'vitest';

import {
  computeSettlementSplit,
  createLedgerEntry,
  platformFeeRateForTier,
} from './models/ledger.js';

describe('computeSettlementSplit', () => {
  it('sums exactly to grossAmount with a promoter present', () => {
    const split = computeSettlementSplit(100_000, 0.15, 0.1, 0.05);
    expect(split.platformFee + split.venueShare + split.promoterCommission + split.hostPayout).toBe(
      100_000,
    );
    expect(split.platformFee).toBe(15_000);
    expect(split.venueShare).toBe(10_000);
    expect(split.promoterCommission).toBe(5_000);
    expect(split.hostPayout).toBe(70_000);
  });

  it('sums exactly to grossAmount with no promoter (0 commission)', () => {
    const split = computeSettlementSplit(100_000, 0.15, 0.1, null);
    expect(split.promoterCommission).toBe(0);
    expect(split.platformFee + split.venueShare + split.promoterCommission + split.hostPayout).toBe(
      100_000,
    );
  });

  it('sums exactly to grossAmount for an odd, non-round gross amount (rounding drift check)', () => {
    const split = computeSettlementSplit(133_337, 0.12, 0.08, 0.03);
    expect(split.platformFee + split.venueShare + split.promoterCommission + split.hostPayout).toBe(
      133_337,
    );
  });
});

describe('platformFeeRateForTier', () => {
  it('maps known tiers per the roadmap table', () => {
    expect(platformFeeRateForTier('basic')).toBe(0.15);
    expect(platformFeeRateForTier('silver')).toBe(0.12);
    expect(platformFeeRateForTier('diamond')).toBe(0.1);
  });

  it('defaults unknown/missing tiers to basic', () => {
    expect(platformFeeRateForTier(null)).toBe(0.15);
    expect(platformFeeRateForTier(undefined)).toBe(0.15);
    expect(platformFeeRateForTier('platinum')).toBe(0.15);
  });
});

describe('createLedgerEntry', () => {
  it('creates a pending entry with version 1', () => {
    const entry = createLedgerEntry({
      id: 'led_1',
      organizationId: 'org_1',
      orderId: 'order_1',
      eventId: 'evt_1',
      entryType: 'host_payout',
      amount: 70_000,
      status: 'pending',
      idempotencyKey: 'order_1:host_payout',
      now: new Date('2026-09-07T00:00:00.000Z'),
    });
    expect(entry.version).toBe(1);
    expect(entry.status).toBe('pending');
    expect(entry.amount).toBe(70_000);
  });
});
