import { describe, expect, it } from 'vitest';

import {
  createReconciliation,
  resolveReconciliation,
} from './models/cover-wallet-reconciliation.js';

import type { CoverWalletReconciliationCreateInput } from './models/cover-wallet-reconciliation.js';

const T0 = new Date('2026-09-01T18:00:00.000Z');

function input(
  overrides: Partial<CoverWalletReconciliationCreateInput> = {},
): CoverWalletReconciliationCreateInput {
  return {
    eventId: 'evt_1',
    organizationId: 'org_1',
    venueId: 'ven_1',
    reconciliationDate: '2026-09-01',
    walletId: 'wal_1',
    userId: 'user_1',
    expectedBalance: 500_000,
    actualBalance: 500_000,
    periodCredits: 500_000,
    periodDebits: 0,
    periodRefunds: 0,
    periodTxnCount: 1,
    discrepancies: [],
    now: T0,
    ...overrides,
  };
}

describe('createReconciliation', () => {
  it('starts pending with a computed discrepancy of actual - expected', () => {
    const rec = createReconciliation(input({ expectedBalance: 500_000, actualBalance: 480_000 }));
    expect(rec.status).toBe('pending');
    expect(rec.discrepancy).toBe(-20_000);
    expect(rec.resolvedBy).toBeNull();
    expect(rec.resolvedAt).toBeNull();
  });

  it('reports zero discrepancy when actual matches expected exactly', () => {
    const rec = createReconciliation(input({ expectedBalance: 500_000, actualBalance: 500_000 }));
    expect(rec.discrepancy).toBe(0);
  });

  it('derives a deterministic id from (eventId, reconciliationDate) — same inputs, same id', () => {
    const a = createReconciliation(input());
    const b = createReconciliation(input());
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(`REC-evt_1-20260901`);
  });

  it('produces a different id for a different reconciliation date on the same event', () => {
    const a = createReconciliation(input({ reconciliationDate: '2026-09-01' }));
    const b = createReconciliation(input({ reconciliationDate: '2026-09-02' }));
    expect(a.id).not.toBe(b.id);
  });

  it('truncates a long eventId in the id so opaqueIdSchema’s 64-char cap is never exceeded', () => {
    const longEventId = 'evt_' + 'a'.repeat(60);
    const rec = createReconciliation(input({ eventId: longEventId }));
    expect(rec.id.length).toBeLessThanOrEqual(64);
  });

  it('carries the discrepancy list through unchanged', () => {
    const discrepancies = [
      {
        type: 'balance_mismatch' as const,
        walletId: 'wal_1',
        userId: 'user_1',
        expectedAmount: 500_000,
        actualAmount: 480_000,
        transactionId: null,
        description: 'drift',
      },
    ];
    const rec = createReconciliation(input({ discrepancies }));
    expect(rec.discrepancies).toEqual(discrepancies);
  });
});

describe('resolveReconciliation', () => {
  it('marks a pending reconciliation resolved with the resolver, timestamp, and notes', () => {
    const pending = createReconciliation(input());
    const resolved = resolveReconciliation(pending, 'staff_1', 'confirmed manual top-up', T0);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe('staff_1');
    expect(resolved.resolvedAt).toBe(T0.toISOString());
    expect(resolved.resolutionNotes).toBe('confirmed manual top-up');
    expect(resolved.version).toBe(pending.version + 1);
  });
});
