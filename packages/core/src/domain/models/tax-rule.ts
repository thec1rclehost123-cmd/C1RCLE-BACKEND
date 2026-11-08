import { InvalidOperationError } from '../errors.js';
import { newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Tax rules ───────────────────────────────────────────────────────────────
 *
 * A place to hold tax rates that is NOT the source code. Whether GST applies to
 * a ticket, whether TDS under s.194-O or GST TCS under s.52 applies to this
 * business model, and at what rate, are legal and accounting conclusions. They
 * are not engineering facts, and until a chartered accountant has confirmed
 * them in writing the system must not assume any of them.
 *
 * So the default is NO RULES, and no rule can take effect without:
 *   - a reference to the written advice that supports it (`approvalRef`);
 *   - a second person: whoever drafts a rule cannot enable it;
 *   - an effective date range, with no two enabled rules of one kind
 *     overlapping, so the rate for any given day is never ambiguous.
 * An enabled rule is never edited. A change is a new rule and a retirement of
 * the old one, so the rate that applied on any past date stays reconstructible.
 *
 * Nothing in pricing or settlement reads these yet; looking one up when none is
 * enabled returns `null`, which means "no tax is applied".
 */

export const TAX_RULE_KINDS = [
  /** GST on the ticket price itself (exemption / rate depends on the price band). */
  'ticket_gst',
  /** GST on the convenience / platform fee charged to the buyer. */
  'convenience_fee_gst',
  /** TDS under s.194-O of the Income-tax Act, on sellers' payouts. */
  'tds_194o',
  /** GST TCS under s.52 of the CGST Act, on net taxable supplies. */
  'gst_tcs_s52',
] as const;
export type TaxRuleKind = (typeof TAX_RULE_KINDS)[number];

/** What the rate is applied to. Recorded with the rule so it is never guessed later. */
export const TAX_BASES = [
  'ticket_price',
  'convenience_fee',
  'gross_sales',
  'net_payable_to_seller',
] as const;
export type TaxBasis = (typeof TAX_BASES)[number];

export type TaxRuleStatus = 'draft' | 'enabled' | 'retired';

export interface TaxRule extends VersionedEntity {
  id: EntityId;
  kind: TaxRuleKind;
  /** Basis points: 1800 = 18%. Whole numbers, so no floating-point rate. */
  rateBps: number;
  basis: TaxBasis;
  /** First day the rule applies, `YYYY-MM-DD` (India date). */
  effectiveFrom: string;
  /** Last day the rule applies, inclusive; null while open-ended. */
  effectiveTo: string | null;
  status: TaxRuleStatus;
  /** Reference to the written CA / legal advice that supports this rule. */
  approvalRef: string | null;
  notes: string;
  createdBy: EntityId;
  enabledBy: EntityId | null;
  enabledAt: string | null;
  retiredBy: EntityId | null;
  retiredAt: string | null;
}

export interface TaxRuleDraftInput {
  id: EntityId;
  kind: TaxRuleKind;
  rateBps: number;
  basis: TaxBasis;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string;
  createdBy: EntityId;
  now: Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertRealDate(value: string, label: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !DATE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InvalidOperationError(`${label} must be a real date in YYYY-MM-DD form`);
  }
}

/** The India calendar date (IST, UTC+5:30) of an instant, as `YYYY-MM-DD`. */
export function indiaDate(now: Date): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Starts a rule as a draft. A draft has no effect on anything. */
export function createTaxRuleDraft(input: TaxRuleDraftInput): TaxRule {
  if (!TAX_RULE_KINDS.includes(input.kind)) {
    throw new InvalidOperationError(`Unknown tax rule kind: ${input.kind}`);
  }
  if (!TAX_BASES.includes(input.basis)) {
    throw new InvalidOperationError(`Unknown tax basis: ${input.basis}`);
  }
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000) {
    throw new InvalidOperationError('Rate must be a whole number of basis points from 0 to 10000');
  }
  assertRealDate(input.effectiveFrom, 'Effective-from date');
  const effectiveTo = input.effectiveTo ?? null;
  if (effectiveTo !== null) {
    assertRealDate(effectiveTo, 'Effective-to date');
    if (effectiveTo < input.effectiveFrom) {
      throw new InvalidOperationError('Effective-to date cannot be before the effective-from date');
    }
  }
  return {
    id: input.id,
    kind: input.kind,
    rateBps: input.rateBps,
    basis: input.basis,
    effectiveFrom: input.effectiveFrom,
    effectiveTo,
    status: 'draft',
    approvalRef: null,
    notes: input.notes ?? '',
    createdBy: input.createdBy,
    enabledBy: null,
    enabledAt: null,
    retiredBy: null,
    retiredAt: null,
    ...newVersionedEntity(input.now),
  };
}

/** True when two rules' date ranges share at least one day (open end = forever). */
function overlaps(a: TaxRule, b: TaxRule): boolean {
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}

const MIN_APPROVAL_REF = 5;

/**
 * Turns a draft on. Refuses without a reference to written advice, when the
 * enabler is the author, and when another enabled rule of the same kind already
 * covers any of the same days.
 */
export function enableTaxRule(
  rule: TaxRule,
  input: {
    enabledBy: EntityId;
    approvalRef: string;
    /** Every other rule of this kind, whatever its status. */
    sameKind: readonly TaxRule[];
    now: Date;
  },
): TaxRule {
  if (rule.status !== 'draft') {
    throw new InvalidOperationError(
      `Only a draft rule can be enabled (this one is ${rule.status})`,
    );
  }
  const approvalRef = input.approvalRef.trim();
  if (approvalRef.length < MIN_APPROVAL_REF) {
    throw new InvalidOperationError(
      'Enabling a tax rule needs a reference to the written advice that supports it',
    );
  }
  if (input.enabledBy === rule.createdBy) {
    throw new InvalidOperationError('A tax rule must be enabled by someone other than its author');
  }
  const clash = input.sameKind.find(
    (other) => other.id !== rule.id && other.status === 'enabled' && overlaps(rule, other),
  );
  if (clash) {
    throw new InvalidOperationError(
      `Rule ${clash.id} (${clash.effectiveFrom} to ${clash.effectiveTo ?? 'open'}) already covers these dates; retire it first`,
    );
  }
  return {
    ...rule,
    status: 'enabled',
    approvalRef,
    enabledBy: input.enabledBy,
    enabledAt: input.now.toISOString(),
    version: rule.version + 1,
    updatedAt: input.now.toISOString(),
  };
}

/** Takes an enabled rule out of use. The record stays, for the audit trail. */
export function retireTaxRule(rule: TaxRule, retiredBy: EntityId, now: Date): TaxRule {
  if (rule.status !== 'enabled') {
    throw new InvalidOperationError(
      `Only an enabled rule can be retired (this one is ${rule.status})`,
    );
  }
  return {
    ...rule,
    status: 'retired',
    retiredBy,
    retiredAt: now.toISOString(),
    version: rule.version + 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * The one enabled rule of `kind` that covers `onDate` (India date), or null.
 * Null is the default and means "apply no tax of this kind". Two matches can
 * only come from corrupted data; refusing to guess beats applying either.
 */
export function activeTaxRule(
  rules: readonly TaxRule[],
  kind: TaxRuleKind,
  onDate: string,
): TaxRule | null {
  const matches = rules.filter(
    (rule) =>
      rule.kind === kind &&
      rule.status === 'enabled' &&
      rule.effectiveFrom <= onDate &&
      (rule.effectiveTo === null || onDate <= rule.effectiveTo),
  );
  if (matches.length > 1) {
    throw new InvalidOperationError(
      `More than one enabled ${kind} rule covers ${onDate}: ${matches.map((rule) => rule.id).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}

/** Tax on a whole-paise basis, rounded half up, in integer arithmetic. */
export function computeTaxPaise(rule: Pick<TaxRule, 'rateBps'>, basisPaise: number): number {
  if (!Number.isInteger(basisPaise) || basisPaise < 0) {
    throw new InvalidOperationError('Tax basis must be a non-negative whole number of paise');
  }
  return Math.floor((basisPaise * rule.rateBps + 5_000) / 10_000);
}
