import { InvalidOperationError } from '../errors.js';

import type { LedgerSettlementSplit } from './ledger.js';

/**
 * ─── Settlement engine (payments plan, DP-01) ────────────────────────────────
 *
 * Splits one paid order into who is owed what. Pure, integer paise, no floats
 * on the money path (rates are basis points, 100 bps = 1%).
 *
 *   commission    = round(subtotal × commissionBps / 10000)   platform's cut of ticket revenue
 *   promoter      = min(promoterAmount, subtotal − commission) paid first, out of ticket revenue
 *   distributable = subtotal − commission − promoter
 *   venue         = round(distributable × venueBps / 10000)
 *   host          = distributable − venue                      absorbs the rounding paisa
 *   platform      = customer fees + GST + commission
 *
 * where `subtotal` is the DISCOUNTED ticket subtotal (a promo discount reduces
 * revenue before fees). The legs always sum to the grand total
 * (subtotal + customer fees + GST), and none is ever negative.
 *
 * This replaces `computeSettlementSplit`, which applied a plan percentage
 * (15/12/10%) to the grand total *including* the customer's fees and GST —
 * i.e. it charged the platform's cut on money that was never ticket revenue.
 * The commission rate now defaults to 0, so the platform earns the customer fee
 * and GST until plans carry a commission.
 */
export interface SettlementInput {
  /** Discounted ticket subtotal, paise (before customer fees and GST). */
  subtotalPaise: number;
  /** Customer convenience fees plus GST on them, paise. */
  customerFeesPaise: number;
  /** Platform commission on ticket revenue, basis points (0 until plans set one). */
  commissionBps: number;
  /** The venue's share of what remains after commission and promoter, basis points. */
  venueBps: number;
  /** Promoter commission in paise, or null when the sale has no promoter. */
  promoterAmountPaise: number | null;
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidOperationError(`${name} must be a non-negative integer`);
  }
}

function assertBps(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new InvalidOperationError(`${name} must be an integer between 0 and 10000`);
  }
}

export function computeSettlementLegs(input: SettlementInput): LedgerSettlementSplit {
  assertNonNegativeInt(input.subtotalPaise, 'subtotalPaise');
  assertNonNegativeInt(input.customerFeesPaise, 'customerFeesPaise');
  assertBps(input.commissionBps, 'commissionBps');
  assertBps(input.venueBps, 'venueBps');
  if (input.promoterAmountPaise !== null) {
    assertNonNegativeInt(input.promoterAmountPaise, 'promoterAmountPaise');
  }

  const commission = Math.round((input.subtotalPaise * input.commissionBps) / 10_000);
  const afterCommission = input.subtotalPaise - commission;
  // Paid first, and never more than the ticket revenue left after commission:
  // an over-generous promoter term shrinks the venue and host shares instead of
  // driving them negative.
  const promoter = Math.min(input.promoterAmountPaise ?? 0, afterCommission);
  const distributable = afterCommission - promoter;
  const venueShare = Math.round((distributable * input.venueBps) / 10_000);

  return {
    platformFee: input.customerFeesPaise + commission,
    venueShare,
    promoterCommission: promoter,
    hostPayout: distributable - venueShare,
  };
}
