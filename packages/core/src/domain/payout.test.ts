import { describe, expect, it } from 'vitest';

import {
  MINIMUM_PAYOUT_PAISE,
  beginProcessing,
  createPayout,
  markPayoutFailed,
  markPayoutPaid,
} from './models/payout.js';

import type { PayoutCreateInput } from './models/payout.js';

function input(overrides: Partial<PayoutCreateInput> = {}): PayoutCreateInput {
  return {
    organizationId: 'org_1',
    bankAccountId: 'bank_1',
    amount: 50_000,
    requestedBy: 'user_1',
    now: new Date('2026-09-07T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createPayout', () => {
  it('creates a requested payout', () => {
    const p = createPayout(input());
    expect(p.status).toBe('requested');
    expect(p.version).toBe(1);
  });

  it('rejects an amount below the ₹100 minimum', () => {
    expect(() => createPayout(input({ amount: MINIMUM_PAYOUT_PAISE - 1 }))).toThrow(
      /below the minimum/,
    );
  });

  it('accepts exactly the minimum', () => {
    expect(() => createPayout(input({ amount: MINIMUM_PAYOUT_PAISE }))).not.toThrow();
  });
});

describe('payout FSM', () => {
  it('requested -> processing -> paid is legal', () => {
    const requested = createPayout(input());
    const processing = beginProcessing(requested);
    expect(processing.status).toBe('processing');
    const paid = markPayoutPaid(processing);
    expect(paid.status).toBe('paid');
    expect(paid.processedAt).not.toBeNull();
  });

  it('cannot begin processing a payout that is already processing', () => {
    const processing = beginProcessing(createPayout(input()));
    expect(() => beginProcessing(processing)).toThrow(/not requested/);
  });

  it('cannot mark paid a payout still in requested state', () => {
    const requested = createPayout(input());
    expect(() => markPayoutPaid(requested)).toThrow(/not processing/);
  });

  it('can fail from requested or processing, not from paid', () => {
    const requested = createPayout(input());
    expect(() => markPayoutFailed(requested, 'bank rejected')).not.toThrow();

    const paid = markPayoutPaid(beginProcessing(createPayout(input())));
    expect(() => markPayoutFailed(paid, 'too late')).toThrow(/already paid/);
  });
});
