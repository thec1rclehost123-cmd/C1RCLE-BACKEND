import { newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { Order } from './order.js';

/**
 * ─── Provider payment record (reconciliation) ────────────────────────────────
 *
 * What the PAYMENT PROVIDER says happened to one payment: how much it captured,
 * what it kept as its own fee (and tax on that fee), what it refunded, and what
 * was disputed. It is deliberately separate from the settlement ledger:
 *
 *   - the ledger answers "what does each partner get"; this answers "what did
 *     the provider actually do", so the two can be compared;
 *   - it carries no policy. Who bears a refund, a chargeback or the provider's
 *     fee is a finance decision, and recording a fact must not decide it;
 *   - nothing here changes a balance, so it can ship before that decision.
 *
 * Facts arrive by webhook, in any order and possibly more than once, so every
 * update is keyed by the provider's own ids (a refund id, a dispute id) and
 * re-applying an event changes nothing.
 */

export type ProviderDisputeStatus = 'open' | 'under_review' | 'won' | 'lost' | 'closed';

export interface ProviderDispute {
  amountPaise: number;
  status: ProviderDisputeStatus;
}

export interface ProviderPayment extends VersionedEntity {
  /** The provider's payment id (Razorpay `pay_...`). */
  id: EntityId;
  provider: 'razorpay';
  /** The provider's order id, once known. */
  providerOrderId: string | null;
  /** Our order, once the capture has been tied to one. */
  orderId: EntityId | null;
  currency: string;
  /** Zero until the provider reports the capture. */
  capturedPaise: number;
  /** The provider's own fee on this payment, in paise. */
  feePaise: number;
  /** Tax the provider charged on its fee, in paise. */
  taxOnFeePaise: number;
  capturedAt: string | null;
  /** Provider refund id -> refunded paise. Only refunds the provider has processed. */
  refunds: Record<string, number>;
  /** Provider dispute id -> amount and current status. */
  disputes: Record<string, ProviderDispute>;
}

export type ProviderPaymentEvent =
  | {
      type: 'captured';
      paymentId: string;
      providerOrderId: string | null;
      /** Our order id when the capture has been fulfilled; null otherwise. */
      orderId: EntityId | null;
      amountPaise: number;
      currency: string;
      feePaise: number;
      taxOnFeePaise: number;
      occurredAt: string;
    }
  | {
      type: 'refund_processed';
      paymentId: string;
      refundId: string;
      amountPaise: number;
      currency: string;
    }
  | {
      type: 'dispute';
      paymentId: string;
      disputeId: string;
      amountPaise: number;
      currency: string;
      status: ProviderDisputeStatus;
    };

/** A dispute only moves forward: a late "open" must not undo a final outcome. */
const DISPUTE_RANK: Record<ProviderDisputeStatus, number> = {
  open: 0,
  under_review: 1,
  won: 2,
  lost: 2,
  closed: 2,
};

function blank(paymentId: string, currency: string, now: Date): ProviderPayment {
  return {
    id: paymentId,
    provider: 'razorpay',
    providerOrderId: null,
    orderId: null,
    currency,
    capturedPaise: 0,
    feePaise: 0,
    taxOnFeePaise: 0,
    capturedAt: null,
    refunds: {},
    disputes: {},
    ...newVersionedEntity(now),
  };
}

/**
 * Applies one provider event to the current record (or starts one). Returns the
 * SAME object when the event teaches us nothing new, so the caller can skip the
 * write: replays and duplicates are free.
 */
export function applyProviderPaymentEvent(
  existing: ProviderPayment | null,
  event: ProviderPaymentEvent,
  now: Date,
): ProviderPayment {
  const base = existing ?? blank(event.paymentId, event.currency, now);
  let next: ProviderPayment = base;

  switch (event.type) {
    case 'captured':
      next = {
        ...base,
        // A refund or dispute can arrive before the capture was recorded; the
        // capture then fills in the currency and amounts without discarding them.
        currency: event.currency,
        providerOrderId: event.providerOrderId ?? base.providerOrderId,
        orderId: event.orderId ?? base.orderId,
        capturedPaise: event.amountPaise,
        feePaise: event.feePaise,
        taxOnFeePaise: event.taxOnFeePaise,
        capturedAt: base.capturedAt ?? event.occurredAt,
      };
      break;
    case 'refund_processed':
      if (base.refunds[event.refundId] !== event.amountPaise) {
        next = { ...base, refunds: { ...base.refunds, [event.refundId]: event.amountPaise } };
      }
      break;
    case 'dispute': {
      const known = base.disputes[event.disputeId];
      const advances =
        known === undefined || DISPUTE_RANK[event.status] >= DISPUTE_RANK[known.status];
      const changed =
        known === undefined ||
        known.status !== event.status ||
        known.amountPaise !== event.amountPaise;
      if (advances && changed) {
        next = {
          ...base,
          disputes: {
            ...base.disputes,
            [event.disputeId]: { amountPaise: event.amountPaise, status: event.status },
          },
        };
      }
      break;
    }
  }

  const unchanged =
    existing !== null && JSON.stringify(stripMeta(next)) === JSON.stringify(stripMeta(existing));
  if (unchanged) return existing;
  return existing === null
    ? next
    : { ...next, version: existing.version + 1, updatedAt: now.toISOString() };
}

function stripMeta(payment: ProviderPayment): Omit<ProviderPayment, 'version' | 'updatedAt'> {
  const { version: _version, updatedAt: _updatedAt, ...rest } = payment;
  return rest;
}

export function refundedPaise(payment: ProviderPayment): number {
  return Object.values(payment.refunds).reduce((sum, amount) => sum + amount, 0);
}

/** Disputed money the provider has taken back for good. */
export function lostDisputePaise(payment: ProviderPayment): number {
  return Object.values(payment.disputes)
    .filter((dispute) => dispute.status === 'lost')
    .reduce((sum, dispute) => sum + dispute.amountPaise, 0);
}

export function hasOpenDispute(payment: ProviderPayment): boolean {
  return Object.values(payment.disputes).some(
    (dispute) => dispute.status === 'open' || dispute.status === 'under_review',
  );
}

/**
 * What the provider will actually pay out for this payment: the capture, less
 * its own fee and the tax on it, refunds, and disputes it has taken back.
 */
export function providerNetPaise(payment: ProviderPayment): number {
  return (
    payment.capturedPaise -
    payment.feePaise -
    payment.taxOnFeePaise -
    refundedPaise(payment) -
    lostDisputePaise(payment)
  );
}

export type ReconciliationFinding =
  | { kind: 'provider_record_missing' }
  | { kind: 'amount_mismatch'; ourPaise: number; providerPaise: number }
  | { kind: 'currency_mismatch'; ours: string; provider: string }
  | { kind: 'refund_mismatch'; ourPaise: number; providerPaise: number }
  | { kind: 'open_dispute' };

export interface ReconciliationResult {
  orderId: EntityId;
  paymentId: string | null;
  /** True only when there is nothing to look at. */
  reconciled: boolean;
  findings: ReconciliationFinding[];
  /** The provider's net for this payment; null when there is no provider record. */
  providerNetPaise: number | null;
}

/**
 * Compares one of our orders with the provider's record of its payment. Only
 * facts are compared: an order and its payment must agree on the amount, the
 * currency and what has been refunded, and no dispute may be open.
 */
export function reconcileOrderWithProvider(
  order: Pick<Order, 'id' | 'paymentId' | 'grandTotalPaise' | 'currency' | 'refundedPaise'>,
  payment: ProviderPayment | null,
): ReconciliationResult {
  const findings: ReconciliationFinding[] = [];
  if (payment === null) {
    findings.push({ kind: 'provider_record_missing' });
    return {
      orderId: order.id,
      paymentId: order.paymentId,
      reconciled: false,
      findings,
      providerNetPaise: null,
    };
  }
  if (payment.capturedPaise !== order.grandTotalPaise) {
    findings.push({
      kind: 'amount_mismatch',
      ourPaise: order.grandTotalPaise,
      providerPaise: payment.capturedPaise,
    });
  }
  if (payment.currency !== order.currency) {
    findings.push({ kind: 'currency_mismatch', ours: order.currency, provider: payment.currency });
  }
  if (refundedPaise(payment) !== order.refundedPaise) {
    findings.push({
      kind: 'refund_mismatch',
      ourPaise: order.refundedPaise,
      providerPaise: refundedPaise(payment),
    });
  }
  if (hasOpenDispute(payment)) findings.push({ kind: 'open_dispute' });

  return {
    orderId: order.id,
    paymentId: payment.id,
    reconciled: findings.length === 0,
    findings,
    providerNetPaise: providerNetPaise(payment),
  };
}
