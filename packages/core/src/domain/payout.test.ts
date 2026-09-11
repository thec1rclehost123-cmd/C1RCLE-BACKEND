import { describe, expect, it } from 'vitest';

import {
  MINIMUM_PAYOUT_PAISE,
  beginProcessing,
  createPayout,
  freezePayout,
  markPayoutFailed,
  markPayoutPaid,
  releasePayout,
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

describe('admin freeze/release', () => {
  it('freezes a requested payout and remembers its prior status', () => {
    const requested = createPayout(input());
    const frozen = freezePayout(requested);
    expect(frozen.status).toBe('frozen');
    expect(frozen.previousStatus).toBe('requested');
  });

  it('freezes a processing payout too', () => {
    const processing = beginProcessing(createPayout(input()));
    const frozen = freezePayout(processing);
    expect(frozen.status).toBe('frozen');
    expect(frozen.previousStatus).toBe('processing');
  });

  it('freezing an already-frozen payout is an idempotent no-op', () => {
    const frozen = freezePayout(createPayout(input()));
    const refrozen = freezePayout(frozen);
    expect(refrozen).toBe(frozen);
    expect(refrozen.version).toBe(frozen.version);
  });

  it('refuses to freeze a paid or failed payout', () => {
    const paid = markPayoutPaid(beginProcessing(createPayout(input())));
    expect(() => freezePayout(paid)).toThrow(/already paid/);

    const failed = markPayoutFailed(createPayout(input()), 'bank rejected');
    expect(() => freezePayout(failed)).toThrow(/already failed/);
  });

  it('release restores exactly the status held before freezing, never a caller-chosen one', () => {
    const processing = beginProcessing(createPayout(input()));
    const frozen = freezePayout(processing);
    const released = releasePayout(frozen);
    expect(released.status).toBe('processing');
    expect(released.previousStatus).toBeNull();
  });

  it('refuses to release a payout that was never frozen', () => {
    const requested = createPayout(input());
    expect(() => releasePayout(requested)).toThrow(/not frozen/);
  });
});
