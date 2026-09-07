import { describe, expect, it } from 'vitest';

import {
  applyCredit,
  applyDebit,
  applyRefund,
  canWalletDebit,
  computeTerminationTime,
  createCoverWallet,
  freezeWallet,
  isWalletActive,
  isWalletFrozen,
  isWalletTerminated,
  unfreezeWallet,
} from './models/cover-wallet.js';

import type { CoverWallet, CoverWalletCreateInput } from './models/cover-wallet.js';

const T0 = new Date('2026-09-01T18:00:00.000Z');

function input(overrides: Partial<CoverWalletCreateInput> = {}): CoverWalletCreateInput {
  return {
    userId: 'user_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    openingBalance: 500_000,
    now: T0,
    ...overrides,
  };
}

function wallet(overrides: Partial<CoverWallet> = {}): CoverWallet {
  return { ...createCoverWallet(input()), ...overrides };
}

describe('createCoverWallet', () => {
  it('opens active with balance and totalCredits both set to the opening balance', () => {
    const w = createCoverWallet(input());
    expect(w.status).toBe('active');
    expect(w.balance).toBe(500_000);
    expect(w.openingBalance).toBe(500_000);
    expect(w.totalCredits).toBe(500_000);
    expect(w.totalDebits).toBe(0);
    expect(w.totalRefunds).toBe(0);
    expect(w.terminatedAt).toBeNull();
  });

  it('defaults metadata to an empty object', () => {
    expect(createCoverWallet(input()).metadata).toEqual({});
  });
});

describe('computeTerminationTime', () => {
  it('computes next-day 05:00 IST (UTC+5:30 = 23:30 UTC the previous night)', () => {
    // 2026-09-01T18:00:00Z = 2026-09-01T23:30 IST -> next day 05:00 IST
    // = 2026-09-02T05:00 IST = 2026-09-01T23:30:00Z.
    const result = computeTerminationTime(T0);
    expect(result).toBe('2026-09-01T23:30:00.000Z');
  });

  it('always lands on a date strictly after the input, never same-day', () => {
    const earlyMorning = new Date('2026-09-01T01:00:00.000Z'); // 06:30 IST
    const result = new Date(computeTerminationTime(earlyMorning));
    expect(result.getTime()).toBeGreaterThan(earlyMorning.getTime());
  });
});

describe('status predicates', () => {
  it('isWalletActive / isWalletTerminated / isWalletFrozen partition the status enum', () => {
    expect(isWalletActive(wallet({ status: 'active' }))).toBe(true);
    expect(isWalletFrozen(wallet({ status: 'frozen' }))).toBe(true);
    expect(isWalletTerminated(wallet({ status: 'terminated' }))).toBe(true);
    expect(isWalletTerminated(wallet({ status: 'closed' }))).toBe(true);
    expect(isWalletActive(wallet({ status: 'frozen' }))).toBe(false);
    expect(isWalletTerminated(wallet({ status: 'active' }))).toBe(false);
  });
});

describe('freezeWallet / unfreezeWallet', () => {
  it('freezes an active wallet and bumps its version', () => {
    const active = wallet({ status: 'active' });
    const frozen = freezeWallet(active, T0);
    expect(frozen.status).toBe('frozen');
    expect(frozen.version).toBe(active.version + 1);
  });

  it('rejects freezing a wallet that is already frozen, terminated, or closed', () => {
    expect(() => freezeWallet(wallet({ status: 'frozen' }), T0)).toThrow(/not active/);
    expect(() => freezeWallet(wallet({ status: 'terminated' }), T0)).toThrow(/not active/);
    expect(() => freezeWallet(wallet({ status: 'closed' }), T0)).toThrow(/not active/);
  });

  it('unfreezes a frozen wallet back to active', () => {
    const frozen = wallet({ status: 'frozen' });
    const active = unfreezeWallet(frozen, T0);
    expect(active.status).toBe('active');
    expect(active.version).toBe(frozen.version + 1);
  });

  it('rejects unfreezing a wallet that is not frozen', () => {
    expect(() => unfreezeWallet(wallet({ status: 'active' }), T0)).toThrow(/not frozen/);
    expect(() => unfreezeWallet(wallet({ status: 'terminated' }), T0)).toThrow(/not frozen/);
  });
});

describe('canWalletDebit', () => {
  it('is true when active and the balance covers the amount', () => {
    expect(canWalletDebit(wallet({ status: 'active', balance: 1000 }), 500)).toBe(true);
  });

  it('is false when the balance is short', () => {
    expect(canWalletDebit(wallet({ status: 'active', balance: 100 }), 500)).toBe(false);
  });

  it('is false while frozen, even with sufficient balance', () => {
    expect(canWalletDebit(wallet({ status: 'frozen', balance: 1000 }), 500)).toBe(false);
  });
});

describe('applyCredit', () => {
  it('increases balance and totalCredits, stamps lastTxnAt/lastCreditAt', () => {
    const before = wallet({ status: 'active', balance: 1000, totalCredits: 1000 });
    const after = applyCredit(before, {
      walletId: before.id,
      amount: 500,
      referenceId: null,
      referenceType: null,
      operatorUid: null,
      operatorName: null,
      description: null,
      idempotencyKey: 'idem-1',
      now: T0,
    });
    expect(after.balance).toBe(1500);
    expect(after.totalCredits).toBe(1500);
    expect(after.lastTxnAt).toBe(T0.toISOString());
    expect(after.lastCreditAt).toBe(T0.toISOString());
  });

  it('rejects crediting a frozen wallet', () => {
    const frozen = wallet({ status: 'frozen' });
    expect(() =>
      applyCredit(frozen, {
        walletId: frozen.id,
        amount: 100,
        referenceId: null,
        referenceType: null,
        operatorUid: null,
        operatorName: null,
        description: null,
        idempotencyKey: 'idem-1',
        now: T0,
      }),
    ).toThrow('Wallet is not active');
  });
});

describe('applyDebit', () => {
  function debit(w: CoverWallet, amount: number, deviceId: string | null = null) {
    return applyDebit(w, {
      walletId: w.id,
      amount,
      referenceId: null,
      referenceType: null,
      operatorUid: null,
      operatorName: null,
      description: null,
      idempotencyKey: 'idem-1',
      deviceId,
      now: T0,
    });
  }

  it('decreases balance and increases totalDebits when balance stays positive', () => {
    const before = wallet({ status: 'active', balance: 1000, totalDebits: 0 });
    const after = debit(before, 300);
    expect(after.balance).toBe(700);
    expect(after.totalDebits).toBe(300);
    expect(after.status).toBe('active');
    expect(after.terminatedAt).toBeNull();
  });

  it('auto-terminates the wallet when a debit exactly depletes the balance', () => {
    const before = wallet({ status: 'active', balance: 300 });
    const after = debit(before, 300);
    expect(after.balance).toBe(0);
    expect(after.status).toBe('terminated');
    expect(after.terminatedAt).toBe(T0.toISOString());
    expect(after.terminationReason).toBe('balance_depleted');
  });

  it('rejects a debit larger than the balance', () => {
    const before = wallet({ status: 'active', balance: 100 });
    expect(() => debit(before, 500)).toThrow('Insufficient balance');
  });

  it('rejects debiting a frozen wallet', () => {
    const frozen = wallet({ status: 'frozen', balance: 1000 });
    expect(() => debit(frozen, 100)).toThrow('Wallet is not active');
  });
});

describe('applyRefund', () => {
  it('increases balance and totalRefunds without touching totalDebits', () => {
    const before = wallet({ status: 'active', balance: 700, totalDebits: 300, totalRefunds: 0 });
    const after = applyRefund(before, 300, T0);
    expect(after.balance).toBe(1000);
    expect(after.totalRefunds).toBe(300);
    expect(after.totalDebits).toBe(300);
  });

  it('rejects refunding a non-active wallet', () => {
    const terminated = wallet({ status: 'terminated' });
    expect(() => applyRefund(terminated, 100, T0)).toThrow('Wallet is not active');
  });
});
