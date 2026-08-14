import { InvalidOperationError } from '../errors.js';

import type { EntityId } from '../identity.js';
import type { PromoCode, TicketTier } from './event-catalog.js';

/**
 * ─── Pricing engine (Phase 4) ────────────────────────────────────────────────
 *
 * Ported from v1 `pricing-engine.calculatePricing`. This is the one file in the
 * codebase where an off-by-one is money, so a few rules are absolute:
 *
 *  1. **Everything is integer paise.** No floats anywhere, not even
 *     intermediately. A percentage is applied as `round(amount * pct / 100)`,
 *     never `amount * 0.05`.
 *  2. **GST applies to fees only, not to the ticket price.** This is v1's
 *     behaviour and it is a tax position, not a formatting choice — changing it
 *     silently would misreport tax.
 *  3. **The order of operations is fixed:** subtotal → discount → fees on the
 *     *discounted* subtotal → GST on the fees. Applying fees before the
 *     discount would overcharge every promo user.
 *  4. **The breakdown always reconciles.** `grandTotal` is the sum of its
 *     stated parts; `assertReconciles` proves it rather than trusting it.
 *
 * Nothing here reads a clock, a database or a config. Rates are constants
 * because they are contractual, and a rate that can drift per environment is a
 * rate that will eventually differ between the quote and the charge.
 */

/** Platform commission, percent of the discounted subtotal (v1: 5%). */
export const PLATFORM_FEE_PERCENT = 5;
/** Payment-gateway fee, percent of the discounted subtotal (v1: 2.5%). */
export const PAYMENT_FEE_PERCENT = 2.5;
/** GST, percent — applied to the fees only (v1: 18%). */
export const GST_PERCENT = 18;

/**
 * Applies a percentage to an integer paise amount, in integer arithmetic.
 *
 * `percent` may carry one decimal place (2.5%), so it is scaled by 10 before
 * dividing — `Math.round(amount * 25 / 1000)` rather than `amount * 0.025`,
 * which would introduce a binary-float error on amounts as small as ₹8.
 *
 * Half-up at exactly .5, matching v1's `Math.round`.
 */
export function applyPercent(paise: number, percent: number): number {
  const scaledPercent = Math.round(percent * 10);
  return Math.round((paise * scaledPercent) / 1000);
}

/** One line of the order: a tier and how many of it. */
export interface PricingLineInput {
  tier: TicketTier;
  quantity: number;
}

export interface PricingLine {
  tierId: EntityId;
  tierName: string;
  quantity: number;
  /** The tier's price at quote time, captured so a later edit cannot rewrite it. */
  unitPricePaise: number;
  subtotalPaise: number;
}

export interface PricingBreakdown {
  lines: PricingLine[];
  /** Σ(unit × qty), before any discount. */
  subtotalPaise: number;
  discountPaise: number;
  /** `subtotal - discount`, never below zero. */
  discountedSubtotalPaise: number;
  platformFeePaise: number;
  paymentFeePaise: number;
  /** GST on (platform + payment) fees only — not on the ticket price. */
  gstPaise: number;
  grandTotalPaise: number;
  /** The promo actually applied, if any. Null when none applied. */
  appliedPromoCode: string | null;
  currency: string;
}

export interface CalculatePricingInput {
  lines: PricingLineInput[];
  /** Already validated as redeemable by the caller; this only does the maths. */
  promo?: PromoCode | null;
  /** ISO 4217. All lines must agree — a mixed-currency cart is not a cart. */
  currency?: string;
}

export function calculatePricing(input: CalculatePricingInput): PricingBreakdown {
  if (input.lines.length === 0) {
    throw new InvalidOperationError('An order must contain at least one line');
  }

  const currency = input.currency ?? input.lines[0]?.tier.currency ?? 'INR';
  const lines: PricingLine[] = input.lines.map(({ tier, quantity }) => {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new InvalidOperationError(`Quantity for ${tier.name} must be a positive whole number`);
    }
    if (tier.currency !== currency) {
      // Summing paise across currencies produces a number that means nothing.
      throw new InvalidOperationError('All lines in an order must share one currency');
    }
    if (tier.minPerOrder !== null && quantity < tier.minPerOrder) {
      throw new InvalidOperationError(
        `${tier.name} has a minimum of ${tier.minPerOrder} per order`,
      );
    }
    if (tier.maxPerOrder !== null && quantity > tier.maxPerOrder) {
      throw new InvalidOperationError(
        `${tier.name} has a maximum of ${tier.maxPerOrder} per order`,
      );
    }
    return {
      tierId: tier.id,
      tierName: tier.name,
      quantity,
      unitPricePaise: tier.priceInPaise,
      subtotalPaise: tier.priceInPaise * quantity,
    };
  });

  const subtotalPaise = lines.reduce((sum, line) => sum + line.subtotalPaise, 0);
  const discountPaise = input.promo ? discountFor(input.promo, lines, subtotalPaise) : 0;
  const discountedSubtotalPaise = Math.max(0, subtotalPaise - discountPaise);

  // Fees are charged on what the guest actually pays for tickets, not on the
  // pre-discount figure — otherwise a promo costs the guest less but the
  // platform still bills fees as though it had not applied.
  const platformFeePaise = applyPercent(discountedSubtotalPaise, PLATFORM_FEE_PERCENT);
  const paymentFeePaise = applyPercent(discountedSubtotalPaise, PAYMENT_FEE_PERCENT);
  const gstPaise = applyPercent(platformFeePaise + paymentFeePaise, GST_PERCENT);

  const breakdown: PricingBreakdown = {
    lines,
    subtotalPaise,
    discountPaise,
    discountedSubtotalPaise,
    platformFeePaise,
    paymentFeePaise,
    gstPaise,
    grandTotalPaise: discountedSubtotalPaise + platformFeePaise + paymentFeePaise + gstPaise,
    appliedPromoCode: input.promo && discountPaise > 0 ? input.promo.code : null,
    currency,
  };
  assertReconciles(breakdown);
  return breakdown;
}

/**
 * A promo scoped to specific tiers discounts only those lines. v1's semantics:
 * an empty `tierIds` means "all tiers".
 *
 * A percent promo is applied to the eligible subtotal; a fixed promo is capped
 * at that same figure, so a ₹500-off code on a ₹300 eligible line discounts
 * ₹300 and not a paisa more — a negative subtotal would become a refund the
 * platform never agreed to.
 */
function discountFor(promo: PromoCode, lines: PricingLine[], subtotalPaise: number): number {
  const eligibleSubtotal =
    promo.tierIds.length === 0
      ? subtotalPaise
      : lines
          .filter((line) => promo.tierIds.includes(line.tierId))
          .reduce((sum, line) => sum + line.subtotalPaise, 0);

  if (eligibleSubtotal === 0) return 0;

  const raw =
    promo.discountType === 'percent'
      ? applyPercent(eligibleSubtotal, promo.discountValue)
      : promo.discountValue;

  return Math.min(Math.max(0, raw), eligibleSubtotal);
}

/**
 * Proves the breakdown adds up. Called on every calculation rather than only
 * in tests: a breakdown whose parts do not sum to its total is a number the
 * guest will be charged, and failing loudly here is strictly better than
 * reconciling it in Phase 6 against a bank statement.
 */
export function assertReconciles(breakdown: PricingBreakdown): void {
  const lineSum = breakdown.lines.reduce((sum, line) => sum + line.subtotalPaise, 0);
  if (lineSum !== breakdown.subtotalPaise) {
    throw new InvalidOperationError('Pricing does not reconcile: lines do not sum to the subtotal');
  }
  const expectedTotal =
    breakdown.discountedSubtotalPaise +
    breakdown.platformFeePaise +
    breakdown.paymentFeePaise +
    breakdown.gstPaise;
  if (expectedTotal !== breakdown.grandTotalPaise) {
    throw new InvalidOperationError('Pricing does not reconcile: parts do not sum to grand total');
  }
  if (breakdown.grandTotalPaise < 0) {
    throw new InvalidOperationError('Pricing does not reconcile: negative grand total');
  }
}

/**
 * What the platform keeps from this order, for Phase 6 settlement.
 *
 * GST is deliberately excluded: it is collected on behalf of the tax
 * authority and passes straight through — counting it as revenue would
 * overstate every payout calculation downstream.
 */
export function platformRevenuePaise(breakdown: PricingBreakdown): number {
  return breakdown.platformFeePaise;
}

/** What is owed to the partner before commission: the discounted ticket value. */
export function partnerGrossPaise(breakdown: PricingBreakdown): number {
  return breakdown.discountedSubtotalPaise;
}
