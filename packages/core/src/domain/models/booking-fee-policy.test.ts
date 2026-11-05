import { describe, expect, it } from 'vitest';

import { createTicketTier } from './event-catalog.js';
import { calculatePricing } from './pricing.js';

const tier = createTicketTier({
  id: 'm4-fee-tier',
  eventId: 'm4-event',
  organizationId: 'm4-host',
  name: 'Admission',
  priceInPaise: 10000,
  quantity: 10,
});
const policy = () => ({
  version: 'm4-controlled-test-v2',
  label: 'Controlled non-production test policy',
  payer: 'guest' as const,
  environment: 'test' as const,
  platformFeeBasisPoints: 1000,
  paymentFeeBasisPoints: 100,
  feeTaxBasisPoints: 0,
  guestRefund: 'admission_only' as const,
  organizerRefund: 'full_paid' as const,
});

describe('authoritative booking fee policy', () => {
  it('prices from the selected server policy and returns its complete audit snapshot', () => {
    const input = { lines: [{ tier, quantity: 1 }], feePolicy: policy() };
    expect(calculatePricing(input)).toMatchObject({
      platformFeePaise: 1000,
      paymentFeePaise: 100,
      gstPaise: 0,
      grandTotalPaise: 11100,
      feePolicy: policy(),
    });
  });

  it('freezes a copy so later commercial edits cannot change a sold snapshot', () => {
    const selected = policy();
    const input = { lines: [{ tier, quantity: 1 }], feePolicy: selected };
    const sold = calculatePricing(input);
    selected.platformFeeBasisPoints = 2000;
    expect(sold).toMatchObject({
      platformFeePaise: 1000,
      feePolicy: { platformFeeBasisPoints: 1000 },
    });
  });

  it('rejects invalid fractional rates rather than silently using old constants', () => {
    const input = {
      lines: [{ tier, quantity: 1 }],
      feePolicy: {
        ...policy(),
        platformFeeBasisPoints: 10.5,
      },
    };
    expect(() => calculatePricing(input)).toThrow();
  });

  it('labels the existing default rates explicitly as a non-production test policy', () => {
    expect(calculatePricing({ lines: [{ tier, quantity: 1 }] })).toMatchObject({
      platformFeePaise: 500,
      paymentFeePaise: 250,
      gstPaise: 135,
      feePolicy: { environment: 'test', payer: 'guest', version: 'm4-nonproduction-test-v1' },
    });
  });
});
