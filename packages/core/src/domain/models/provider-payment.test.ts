import { describe, expect, it } from 'vitest';

import {
  applyProviderPaymentEvent,
  hasOpenDispute,
  lostDisputePaise,
  providerNetPaise,
  reconcileOrderWithProvider,
  refundedPaise,
} from './provider-payment.js';

import type { ProviderPayment, ProviderPaymentEvent } from './provider-payment.js';

const T0 = new Date('2026-10-11T10:00:00.000Z');
const T1 = new Date('2026-10-11T11:00:00.000Z');

const captured = (overrides: Partial<Extract<ProviderPaymentEvent, { type: 'captured' }>> = {}) =>
  ({
    type: 'captured',
    paymentId: 'pay_1',
    providerOrderId: 'order_p1',
    orderId: null,
    correlated: true,
    amountPaise: 118_000,
    currency: 'INR',
    feePaise: 2_360,
    taxOnFeePaise: 425,
    occurredAt: T0.toISOString(),
    ...overrides,
  }) satisfies ProviderPaymentEvent;

const refund = (refundId: string, amountPaise: number): ProviderPaymentEvent => ({
  type: 'refund_processed',
  paymentId: 'pay_1',
  refundId,
  amountPaise,
  currency: 'INR',
});

const dispute = (
  status: Extract<ProviderPaymentEvent, { type: 'dispute' }>['status'],
  disputeId = 'disp_1',
  amountPaise = 118_000,
): ProviderPaymentEvent => ({
  type: 'dispute',
  paymentId: 'pay_1',
  disputeId,
  amountPaise,
  currency: 'INR',
  status,
  amountDeductedPaise: status === 'lost' ? amountPaise : 0,
  reasonCode: 'test_reason',
  reasonDescription: null,
  respondBy: null,
  phase: 'chargeback',
  evidenceState: 'none',
  providerOccurredAt: T0.toISOString(),
});

function build(...events: ProviderPaymentEvent[]): ProviderPayment {
  let record: ProviderPayment | null = null;
  for (const event of events) record = applyProviderPaymentEvent(record, event, T1);
  if (!record) throw new Error('no events');
  return record;
}

describe('applyProviderPaymentEvent', () => {
  it('starts a record from a capture and keeps the provider’s fee and tax', () => {
    const record = build(captured());

    expect(record).toMatchObject({
      id: 'pay_1',
      provider: 'razorpay',
      providerOrderId: 'order_p1',
      processingState: 'processing',
      capturedPaise: 118_000,
      feePaise: 2_360,
      taxOnFeePaise: 425,
      version: 1,
    });
  });

  it('returns the SAME object for a replayed event, so the caller skips the write', () => {
    const first = applyProviderPaymentEvent(null, captured(), T0);

    expect(applyProviderPaymentEvent(first, captured(), T1)).toBe(first);

    const withRefund = applyProviderPaymentEvent(first, refund('rfnd_1', 5_000), T1);
    expect(applyProviderPaymentEvent(withRefund, refund('rfnd_1', 5_000), T1)).toBe(withRefund);
  });

  it('bumps the version only when something actually changed', () => {
    const first = applyProviderPaymentEvent(null, captured(), T0);
    const second = applyProviderPaymentEvent(first, refund('rfnd_1', 5_000), T1);

    expect(second.version).toBe(2);
    expect(second.updatedAt).toBe(T1.toISOString());
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('ties a capture to our order later without losing what is already known', () => {
    const record = build(captured(), captured({ orderId: 'ord_9' }));

    expect(record.orderId).toBe('ord_9');
    expect(record.version).toBe(2);
    // A later capture event with no order never clears it.
    expect(applyProviderPaymentEvent(record, captured({ orderId: null }), T1).orderId).toBe(
      'ord_9',
    );
  });

  it('accepts a refund that arrives BEFORE the capture, and the capture then fills the rest in', () => {
    const record = build(refund('rfnd_1', 5_000), captured());

    expect(record.capturedPaise).toBe(118_000);
    expect(refundedPaise(record)).toBe(5_000);
    expect(record.feePaise).toBe(2_360);
  });

  it('adds up several partial refunds, each counted once', () => {
    const record = build(
      captured(),
      refund('rfnd_1', 5_000),
      refund('rfnd_2', 7_000),
      refund('rfnd_1', 5_000),
    );

    expect(refundedPaise(record)).toBe(12_000);
    expect(Object.keys(record.refunds)).toEqual(['rfnd_1', 'rfnd_2']);
  });

  it('records a full refund as a durable terminal processing state', () => {
    const record = build(captured(), refund('rfnd_full', 118_000));

    expect(record.processingState).toBe('refunded');
  });

  it('moves a dispute forward only: a late "open" cannot undo a final outcome', () => {
    const lost = build(captured(), dispute('open'), dispute('under_review'), dispute('lost'));

    expect(lost.disputes.disp_1?.status).toBe('lost');
    expect(applyProviderPaymentEvent(lost, dispute('open'), T1)).toBe(lost);
    expect(applyProviderPaymentEvent(lost, dispute('under_review'), T1)).toBe(lost);
  });

  it('tracks several disputes on one payment separately', () => {
    const record = build(
      captured(),
      dispute('lost', 'disp_1', 10_000),
      dispute('won', 'disp_2', 20_000),
    );

    expect(lostDisputePaise(record)).toBe(10_000);
    expect(hasOpenDispute(record)).toBe(false);
  });

  it('does not mutate the record it was given', () => {
    const first = applyProviderPaymentEvent(null, captured(), T0);
    const snapshot = structuredClone(first);

    applyProviderPaymentEvent(first, refund('rfnd_1', 1), T1);

    expect(first).toEqual(snapshot);
  });
});

describe('providerNetPaise', () => {
  it('is the capture less the provider’s fee, the tax on it, refunds and lost disputes', () => {
    const record = build(captured(), refund('rfnd_1', 5_000), dispute('lost', 'disp_1', 3_000));

    expect(providerNetPaise(record)).toBe(118_000 - 2_360 - 425 - 5_000 - 3_000);
  });

  it('does not count a dispute that is still open or was won', () => {
    const record = build(
      captured(),
      dispute('open', 'disp_1', 9_000),
      dispute('won', 'disp_2', 9_000),
    );

    expect(providerNetPaise(record)).toBe(118_000 - 2_360 - 425);
  });
});

describe('reconcileOrderWithProvider', () => {
  const order = {
    id: 'ord_9',
    paymentId: 'pay_1',
    grandTotalPaise: 118_000,
    currency: 'INR',
    refundedPaise: 0,
  };

  it('reconciles when amount, currency and refunds agree and nothing is disputed', () => {
    const result = reconcileOrderWithProvider(order, build(captured({ orderId: 'ord_9' })));

    expect(result).toEqual({
      orderId: 'ord_9',
      paymentId: 'pay_1',
      reconciled: true,
      findings: [],
      providerNetPaise: 118_000 - 2_360 - 425,
    });
  });

  it('reports a missing provider record rather than assuming agreement', () => {
    expect(reconcileOrderWithProvider(order, null)).toMatchObject({
      reconciled: false,
      findings: [{ kind: 'provider_record_missing' }],
      providerNetPaise: null,
    });
  });

  it('reports an amount mismatch with both figures', () => {
    const result = reconcileOrderWithProvider(
      { ...order, grandTotalPaise: 100_000 },
      build(captured()),
    );

    expect(result.findings).toContainEqual({
      kind: 'amount_mismatch',
      ourPaise: 100_000,
      providerPaise: 118_000,
    });
  });

  it('reports a refund the provider made that our order does not show', () => {
    const result = reconcileOrderWithProvider(order, build(captured(), refund('rfnd_1', 5_000)));

    expect(result.reconciled).toBe(false);
    expect(result.findings).toContainEqual({
      kind: 'refund_mismatch',
      ourPaise: 0,
      providerPaise: 5_000,
    });
  });

  it('reports a currency mismatch and an open dispute', () => {
    const result = reconcileOrderWithProvider(
      { ...order, currency: 'USD' },
      build(captured(), dispute('under_review')),
    );

    expect(result.findings).toEqual(
      expect.arrayContaining([
        { kind: 'currency_mismatch', ours: 'USD', provider: 'INR' },
        { kind: 'open_dispute' },
      ]),
    );
  });
});
