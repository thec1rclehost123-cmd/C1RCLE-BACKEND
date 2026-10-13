import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from '../errors.js';

import {
  activeTaxRule,
  computeTaxPaise,
  createTaxRuleDraft,
  enableTaxRule,
  indiaDate,
  retireTaxRule,
} from './tax-rule.js';

import type { TaxRule, TaxRuleDraftInput } from './tax-rule.js';

const NOW = new Date('2026-10-11T10:00:00.000Z');

const draft = (overrides: Partial<TaxRuleDraftInput> = {}): TaxRule =>
  createTaxRuleDraft({
    id: 'rule_1',
    kind: 'convenience_fee_gst',
    rateBps: 1800,
    basis: 'convenience_fee',
    effectiveFrom: '2026-04-01',
    createdBy: 'admin_author',
    now: NOW,
    ...overrides,
  });

const enable = (rule: TaxRule, sameKind: TaxRule[] = [], enabledBy = 'admin_checker') =>
  enableTaxRule(rule, { enabledBy, approvalRef: 'CA letter 2026-10-05', sameKind, now: NOW });

describe('createTaxRuleDraft', () => {
  it('starts as a draft that does nothing', () => {
    expect(draft()).toMatchObject({
      status: 'draft',
      approvalRef: null,
      enabledBy: null,
      effectiveTo: null,
      version: 1,
    });
  });

  it('rejects rates that are not whole basis points between 0 and 100%', () => {
    for (const rateBps of [-1, 10_001, 18.5, Number.NaN]) {
      expect(() => draft({ rateBps })).toThrow(InvalidOperationError);
    }
    expect(draft({ rateBps: 0 }).rateBps).toBe(0);
    expect(draft({ rateBps: 10_000 }).rateBps).toBe(10_000);
  });

  it('rejects dates that are malformed, impossible, or out of order', () => {
    for (const effectiveFrom of ['2026-4-1', '2026-02-30', 'tomorrow', '']) {
      expect(() => draft({ effectiveFrom })).toThrow(InvalidOperationError);
    }
    expect(() => draft({ effectiveFrom: '2026-04-01', effectiveTo: '2026-03-31' })).toThrow(
      /before/,
    );
    expect(draft({ effectiveFrom: '2026-04-01', effectiveTo: '2026-04-01' }).effectiveTo).toBe(
      '2026-04-01',
    );
  });

  it('rejects an unknown kind or basis', () => {
    expect(() => draft({ kind: 'cess' as never })).toThrow(/kind/);
    expect(() => draft({ basis: 'vibes' as never })).toThrow(/basis/);
  });
});

describe('enableTaxRule', () => {
  it('enables a draft and records who and on what advice', () => {
    const enabled = enable(draft());

    expect(enabled).toMatchObject({
      status: 'enabled',
      approvalRef: 'CA letter 2026-10-05',
      enabledBy: 'admin_checker',
      enabledAt: NOW.toISOString(),
      version: 2,
    });
  });

  it('refuses without a reference to written advice', () => {
    for (const approvalRef of ['', '   ', 'ok']) {
      expect(() =>
        enableTaxRule(draft(), { enabledBy: 'admin_checker', approvalRef, sameKind: [], now: NOW }),
      ).toThrow(/written advice/);
    }
  });

  it('refuses when the enabler is the author', () => {
    expect(() => enable(draft(), [], 'admin_author')).toThrow(/someone other than its author/);
  });

  it('refuses a rule that is not a draft', () => {
    expect(() => enable(enable(draft()))).toThrow(/draft/);
  });

  it('refuses to overlap another enabled rule of the same kind', () => {
    const existing = enable(
      draft({ id: 'rule_old', effectiveFrom: '2026-04-01', effectiveTo: '2027-03-31' }),
    );

    const overlapping = draft({ id: 'rule_new', effectiveFrom: '2027-03-31' });
    expect(() => enable(overlapping, [existing])).toThrow(/already covers/);

    const open = draft({ id: 'rule_open', effectiveFrom: '2025-01-01' });
    expect(() => enable(open, [existing])).toThrow(/already covers/);
  });

  it('allows back-to-back ranges, and ignores drafts, retired rules and other rules', () => {
    const existing = enable(
      draft({ id: 'rule_old', effectiveFrom: '2026-04-01', effectiveTo: '2027-03-31' }),
    );
    const next = draft({ id: 'rule_new', effectiveFrom: '2027-04-01' });

    expect(enable(next, [existing]).status).toBe('enabled');
    expect(enable(next, [draft({ id: 'rule_draft' })]).status).toBe('enabled');
    expect(enable(next, [retireTaxRule(existing, 'a', NOW)]).status).toBe('enabled');
  });
});

describe('retireTaxRule', () => {
  it('retires only an enabled rule and keeps the record', () => {
    const retired = retireTaxRule(enable(draft()), 'admin_x', NOW);

    expect(retired).toMatchObject({
      status: 'retired',
      retiredBy: 'admin_x',
      approvalRef: 'CA letter 2026-10-05',
    });
    expect(() => retireTaxRule(draft(), 'admin_x', NOW)).toThrow(/enabled/);
    expect(() => retireTaxRule(retired, 'admin_x', NOW)).toThrow(/enabled/);
  });
});

describe('activeTaxRule', () => {
  const bounded = enable(
    draft({ id: 'bounded', effectiveFrom: '2026-04-01', effectiveTo: '2026-12-31' }),
  );

  it('is null by default: no rules means no tax', () => {
    expect(activeTaxRule([], 'convenience_fee_gst', '2026-10-11')).toBeNull();
  });

  it('finds the rule only inside its dates, inclusive at both ends', () => {
    expect(activeTaxRule([bounded], 'convenience_fee_gst', '2026-03-31')).toBeNull();
    expect(activeTaxRule([bounded], 'convenience_fee_gst', '2026-04-01')?.id).toBe('bounded');
    expect(activeTaxRule([bounded], 'convenience_fee_gst', '2026-12-31')?.id).toBe('bounded');
    expect(activeTaxRule([bounded], 'convenience_fee_gst', '2027-01-01')).toBeNull();
  });

  it('ignores drafts, retired rules and other kinds', () => {
    const rules = [
      draft({ id: 'd', effectiveFrom: '2026-01-01' }),
      retireTaxRule(bounded, 'x', NOW),
      enable(draft({ id: 'other', kind: 'tds_194o', basis: 'net_payable_to_seller' })),
    ];

    expect(activeTaxRule(rules, 'convenience_fee_gst', '2026-10-11')).toBeNull();
    expect(activeTaxRule(rules, 'tds_194o', '2026-10-11')?.id).toBe('other');
  });

  it('refuses to guess if corrupted data has two enabled rules for one day', () => {
    const twin = { ...bounded, id: 'twin' };

    expect(() => activeTaxRule([bounded, twin], 'convenience_fee_gst', '2026-10-11')).toThrow(
      /More than one/,
    );
  });

  it('applies the rate in force on a past date, not today’s', () => {
    const old = enable(
      draft({ id: 'old', rateBps: 1200, effectiveFrom: '2025-04-01', effectiveTo: '2026-03-31' }),
    );
    const current = enable(draft({ id: 'current', rateBps: 1800, effectiveFrom: '2026-04-01' }), [
      old,
    ]);

    expect(activeTaxRule([old, current], 'convenience_fee_gst', '2025-12-01')?.rateBps).toBe(1200);
    expect(activeTaxRule([old, current], 'convenience_fee_gst', '2026-10-11')?.rateBps).toBe(1800);
  });
});

describe('computeTaxPaise', () => {
  it('rounds half up in integer arithmetic', () => {
    expect(computeTaxPaise({ rateBps: 1800 }, 10_000)).toBe(1_800);
    expect(computeTaxPaise({ rateBps: 1800 }, 3)).toBe(1); // 0.54 -> 1
    expect(computeTaxPaise({ rateBps: 1800 }, 2)).toBe(0); // 0.36 -> 0
    expect(computeTaxPaise({ rateBps: 5000 }, 1)).toBe(1); // 0.5 -> 1
    expect(computeTaxPaise({ rateBps: 0 }, 99_999)).toBe(0);
  });

  it('refuses a basis that is not a non-negative whole number of paise', () => {
    for (const basis of [-1, 1.5, Number.NaN]) {
      expect(() => computeTaxPaise({ rateBps: 1800 }, basis)).toThrow(InvalidOperationError);
    }
  });
});

describe('indiaDate', () => {
  it('uses the India calendar day, which runs ahead of UTC', () => {
    expect(indiaDate(new Date('2026-10-11T18:29:59.000Z'))).toBe('2026-10-11');
    expect(indiaDate(new Date('2026-10-11T18:30:00.000Z'))).toBe('2026-10-12');
  });
});
