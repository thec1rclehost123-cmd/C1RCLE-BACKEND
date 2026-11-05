import { describe, expect, it } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { createDispute } from '../../domain/models/dispute.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent } from '../../domain/models/event.js';
import {
  DEFAULT_ACCOUNTING_POLICY,
  M4_ACCOUNTING_POLICY,
} from '../../domain/models/financial-journal.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';
import { createOrder } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';
import { MemoryDisputeRepository } from '../../infrastructure/memory/memory-dispute-repository.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryJournalTransitionRepository } from '../../infrastructure/memory/memory-journal-transition-repository.js';
import { MemoryLedgerRepository } from '../../infrastructure/memory/memory-ledger-repository.js';
import { MemoryPayoutRepository } from '../../infrastructure/memory/memory-payout-repository.js';
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';
import { MemoryReconciliationRepository } from '../../infrastructure/memory/memory-reconciliation-repository.js';
import { MemoryRefundRequestRepository } from '../../infrastructure/memory/memory-refund-request-repository.js';
import {
  MemoryEventRepository,
  MemoryOrderRepository,
} from '../../infrastructure/memory/memory-repositories.js';

import { createFinanceService } from './finance-service.js';
import { FinancialPostingService } from './financial-posting-service.js';

import type { ReconciliationDiscrepancy } from '../../domain/models/reconciliation.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const ORG = 'org-settlement';
const actor = {
  userId: 'host-user',
  organizationId: ORG,
  role: 'owner' as const,
  capabilities: [],
};
async function fixture() {
  const ledger = new MemoryLedgerRepository();
  const financialJournals = new MemoryFinancialJournalRepository();
  const journalTransition = new MemoryJournalTransitionRepository();
  journalTransition.state = {
    ...journalTransition.state,
    phase: 'journal_reads',
    readModel: 'financial_journal_v2',
  };
  const events = new MemoryEventRepository();
  const orders = new MemoryOrderRepository();
  const refundRequests = new MemoryRefundRequestRepository();
  const providerPayments = new MemoryProviderPaymentRepository();
  const disputes = new MemoryDisputeRepository();
  const reconciliations = new MemoryReconciliationRepository();
  const deps = {
    ledger,
    financialJournals,
    journalTransition,
    events,
    payouts: new MemoryPayoutRepository(),
    reconciliations,
    financialExposure: { orders, refundRequests, providerPayments, disputes },
    config: createCoreConfig({
      firestore: { projectId: 'test-project' },
      redis: { url: 'redis://localhost:6379' },
      clock: { now: () => NOW },
    }),
  };
  const finance = createFinanceService(deps);
  async function sale(id: string, elapsedHours = 72, amount = 10001, legacyPolicy = false) {
    const end = NOW.getTime() - elapsedHours * 3600000;
    const event = {
      ...createEvent({
        id: `event-${id}`,
        organizationId: ORG,
        venueId: 'venue-settlement',
        title: id,
        startAt: new Date(end - 4 * 3600000).toISOString(),
        endAt: new Date(end).toISOString(),
        now: NOW,
      }),
      status: 'ended' as const,
    };
    await events.save(event);
    const tier = createTicketTier({
      id: `tier-${id}`,
      eventId: event.id,
      organizationId: ORG,
      name: 'Entry',
      quantity: 10,
      priceInPaise: amount,
      now: NOW,
    });
    const order = {
      ...createOrder({
        id,
        eventId: event.id,
        organizationId: ORG,
        userId: 'buyer',
        contact: { name: 'Buyer', email: '', phone: '' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 1 }] }),
        now: NOW,
      }),
      status: 'paid' as const,
      paymentId: `pay-${id}`,
    };
    await orders.save(order);
    await providerPayments.save(
      applyProviderPaymentEvent(
        null,
        {
          type: 'captured',
          paymentId: order.paymentId,
          providerOrderId: `provider-${id}`,
          orderId: id,
          correlated: true,
          amountPaise: order.grandTotalPaise,
          currency: 'INR',
          feePaise: 0,
          taxOnFeePaise: 0,
          occurredAt: NOW.toISOString(),
        },
        NOW,
      ),
    );
    await new FinancialPostingService(financialJournals).postTicketSale({
      organizationId: ORG,
      orderId: id,
      eventId: event.id,
      paymentId: order.paymentId,
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: amount,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: amount,
      gstPaise: order.gstPaise,
      platformFeePaise: order.platformFeePaise,
      paymentFeePaise: order.paymentFeePaise,
      allocation: {
        platformPaise: 0,
        hostOrganizationId: ORG,
        hostPaise: amount,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      policy: legacyPolicy
        ? {
            ...DEFAULT_ACCOUNTING_POLICY,
            settlementDelayDays: 0,
            reserveBasisPoints: 1000,
            requiresEventCompletion: false,
          }
        : M4_ACCOUNTING_POLICY,
      postedAt: NOW,
    });
    return { event, order, amount };
  }
  const balance = () => finance.getBalances(ORG, actor);
  function mismatch(
    id: string,
    orderId: string | null,
    amountPaise: number | null,
  ): ReconciliationDiscrepancy {
    return {
      id,
      runId: 'run-settlement',
      kind: 'amount_mismatch',
      state: 'finance_review',
      organizationId: ORG,
      orderId,
      paymentId: null,
      payoutId: null,
      amountPaise,
      currency: 'INR',
      evidence: {},
      repair: 'recheck_evidence',
      resolutionReason: null,
      resolvedBy: null,
      resolvedAt: null,
      version: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
  }
  return { ...deps, finance, sale, balance, mismatch };
}

describe('M4 staged Host settlement from authoritative event end', () => {
  it.each([
    { hours: 23.999, eligible: 0, pending: 10001, reserve: 0 },
    { hours: 24, eligible: 7500, pending: 0, reserve: 2501 },
    { hours: 71.999, eligible: 7500, pending: 0, reserve: 2501 },
    { hours: 72, eligible: 10001, pending: 0, reserve: 0 },
    { hours: 240, eligible: 10001, pending: 0, reserve: 0 },
  ])(
    'releases at exact +24/+72 boundaries ($hours hours)',
    async ({ hours, eligible, pending, reserve }) => {
      const f = await fixture();
      await f.sale('boundary', hours);
      expect(await f.balance()).toMatchObject({
        availablePaise: eligible,
        pendingPaise: pending,
        holds: { reservePaise: reserve },
      });
    },
  );

  it('uses the M3 start+6h fallback and ignores journal posting time', async () => {
    const f = await fixture();
    const { event } = await f.sale('fallback', 24);
    f.events.events.set(event.id, {
      ...event,
      startAt: new Date(NOW.getTime() - 30 * 3600000).toISOString(),
      endAt: null,
    });
    expect(await f.balance()).toMatchObject({ availablePaise: 7500 });
  });

  it.each(['postponed', 'cancelled', 'draft'] as const)(
    'withholds old scheduled proceeds for %s events',
    async (status) => {
      const f = await fixture();
      const { event } = await f.sale('lifecycle');
      f.events.events.set(event.id, { ...event, status });
      expect(await f.balance()).toMatchObject({
        availablePaise: 0,
        ...(status === 'cancelled'
          ? { holds: { cancellationPaise: 10001 } }
          : { pendingPaise: 10001 }),
      });
    },
  );

  it('fails closed for missing events and invalid schedules without affecting another healthy event', async () => {
    const f = await fixture();
    const absent = await f.sale('absent');
    const invalid = await f.sale('invalid');
    await f.sale('healthy');
    f.events.events.delete(absent.event.id);
    f.events.events.set(invalid.event.id, { ...invalid.event, endAt: invalid.event.startAt });
    expect(await f.balance()).toMatchObject({ availablePaise: 10001, pendingPaise: 20002 });
  });

  it('applies current staged policy to historical snapshots without rewriting journals or permanent reserves', async () => {
    const f = await fixture();
    await f.sale('legacy-policy', 24, 10001, true);
    const before = await f.financialJournals.findByOrderId('legacy-policy');
    expect(await f.balance()).toMatchObject({
      availablePaise: 7500,
      holds: { reservePaise: 2501 },
    });
    expect(await f.financialJournals.findByOrderId('legacy-policy')).toEqual(before);
  });

  it('holds only pending refund exposure and preserves unrelated eligible proceeds', async () => {
    const f = await fixture();
    const { order } = await f.sale('refund');
    await f.sale('healthy');
    await f.financialExposure.refundRequests.save(
      createRefundRequest({
        id: 'pending-refund',
        orderId: order.id,
        organizationId: ORG,
        amountPaise: 3000,
        requestedBy: 'admin',
        reason: 'Pending review',
        hasRedeemedEntitlement: false,
        now: NOW,
      }),
    );
    expect(await f.balance()).toMatchObject({
      availablePaise: 17002,
      holds: { refundPaise: 3000 },
    });
  });

  it('holds an orphan refund lock to its order instead of all events', async () => {
    const f = await fixture();
    const { order } = await f.sale('orphan');
    await f.sale('healthy');
    f.financialExposure.orders.orders.set(order.id, { ...order, status: 'refund_requested' });
    expect(await f.balance()).toMatchObject({
      availablePaise: 10001,
      holds: { refundPaise: 10001 },
    });
  });

  it('bounds Partner dispute and unresolved reconciliation exposure and deduplicates repeated run findings', async () => {
    const f = await fixture();
    const { order } = await f.sale('risk');
    await f.sale('healthy');
    await f.financialExposure.disputes.create(
      createDispute({
        organizationId: ORG,
        orderId: order.id,
        ledgerEntryId: 'source-line',
        raisedBy: 'partner',
        reason: 'Business dispute',
        amount: 2000,
        now: NOW,
      }),
    );
    await f.reconciliations.createDiscrepancies([
      f.mismatch('run-one', order.id, 3000),
      f.mismatch('run-two', order.id, 3000),
    ]);
    expect(await f.balance()).toMatchObject({
      availablePaise: 15002,
      holds: { disputePaise: 2000, reconciliationPaise: 3000 },
    });
  });

  it('keeps unknown-amount reconciliation confined to a known order', async () => {
    const f = await fixture();
    const { order } = await f.sale('risk');
    await f.sale('healthy');
    await f.reconciliations.createDiscrepancies([f.mismatch('unknown-amount', order.id, null)]);
    expect(await f.balance()).toMatchObject({
      availablePaise: 10001,
      holds: { reconciliationPaise: 10001 },
    });
  });

  it('holds captured proceeds while fulfillment is pending without freezing completed sales', async () => {
    const f = await fixture();
    const { order } = await f.sale('pending-fulfillment');
    await f.sale('completed');
    await f.financialExposure.orders.save({
      ...order,
      version: order.version + 1,
      fulfillmentState: 'pending',
    });
    expect(await f.balance()).toMatchObject({
      availablePaise: 10001,
      holds: { providerUncertaintyPaise: 10001 },
    });
  });

  it('holds uncertain provider state without freezing unrelated sales', async () => {
    const f = await fixture();
    const { order } = await f.sale('uncertain');
    await f.sale('healthy');
    const payment = await f.financialExposure.providerPayments.findByPaymentId(order.paymentId);
    if (!payment) throw new Error('Captured fixture payment missing');
    f.financialExposure.providerPayments.payments.set(payment.id, {
      ...payment,
      processingState: 'requires_support',
    });
    expect(await f.balance()).toMatchObject({
      availablePaise: 10001,
      holds: { providerUncertaintyPaise: 10001 },
    });
  });

  it('holds unposted provider dispute exposure separately from Partner disputes', async () => {
    const f = await fixture();
    const { order } = await f.sale('chargeback');
    await f.sale('healthy');
    const payment = await f.financialExposure.providerPayments.findByPaymentId(order.paymentId);
    if (!payment) throw new Error('Captured fixture payment missing');
    f.financialExposure.providerPayments.payments.set(payment.id, {
      ...payment,
      disputes: {
        'provider-dispute': {
          amountPaise: 4000,
          amountDeductedPaise: 0,
          status: 'under_review',
          reasonCode: null,
          reasonDescription: null,
          respondBy: null,
          phase: 'chargeback',
          evidenceState: 'none',
          providerOccurredAt: null,
        },
      },
    });
    expect(await f.balance()).toMatchObject({
      availablePaise: 16002,
      holds: { disputePaise: 4000 },
    });
  });

  it('retains processed provider refund exposure until internal refund convergence', async () => {
    const f = await fixture();
    const { order } = await f.sale('provider-refund');
    await f.sale('healthy');
    const payment = await f.financialExposure.providerPayments.findByPaymentId(order.paymentId);
    if (!payment) throw new Error('Captured fixture payment missing');
    f.financialExposure.providerPayments.payments.set(payment.id, {
      ...payment,
      refunds: { 'processed-refund': 2500 },
    });
    expect(await f.balance()).toMatchObject({
      availablePaise: 17502,
      holds: { providerUncertaintyPaise: 2500 },
    });
  });

  it('uses a replacement schedule rather than the original elapsed settlement clock', async () => {
    const f = await fixture();
    const { event } = await f.sale('rescheduled');
    f.events.events.set(event.id, {
      ...event,
      status: 'published',
      startAt: new Date(NOW.getTime() + 3600000).toISOString(),
      endAt: new Date(NOW.getTime() + 5 * 3600000).toISOString(),
    });
    expect(await f.balance()).toMatchObject({ availablePaise: 0, pendingPaise: 10001 });
  });

  it('deducts prior payout reservation journals once from maximum staged eligibility', async () => {
    const f = await fixture();
    await f.sale('reserved', 24);
    const posting = new FinancialPostingService(f.financialJournals);
    await f.financialJournals.postBatch([
      posting.buildPayoutReservation({
        organizationId: ORG,
        payoutId: 'payout-already-reserved',
        amountPaise: 1000,
        policy: M4_ACCOUNTING_POLICY,
        postedAt: NOW,
      }),
    ]);
    expect(await f.balance()).toMatchObject({
      availablePaise: 6500,
      holds: { reservePaise: 2501 },
    });
  });

  it('withholds a mismatched captured payment from the affected order', async () => {
    const f = await fixture();
    const { order } = await f.sale('mismatch');
    await f.sale('healthy');
    const payment = await f.financialExposure.providerPayments.findByPaymentId(order.paymentId);
    if (!payment) throw new Error('Captured fixture payment missing');
    f.financialExposure.providerPayments.payments.set(payment.id, {
      ...payment,
      capturedPaise: payment.capturedPaise - 1,
    });
    expect(await f.balance()).toMatchObject({
      availablePaise: 10001,
      holds: { providerUncertaintyPaise: 10001 },
    });
  });

  it('fails closed for a reconciliation risk whose payment cannot be attributed', async () => {
    const f = await fixture();
    await f.sale('healthy');
    await f.reconciliations.createDiscrepancies([
      { ...f.mismatch('unattributed', null, 3000), paymentId: 'missing-payment' },
    ]);
    expect(await f.balance()).toMatchObject({
      availablePaise: 7001,
      holds: { reconciliationPaise: 3000 },
    });
  });

  it('fails closed without authoritative exposure repositories', async () => {
    const f = await fixture();
    await f.sale('unwired');
    const { financialExposure: _exposure, ...unwired } = f;
    expect(await createFinanceService(unwired).getBalances(ORG, actor)).toMatchObject({
      availablePaise: 0,
      holds: { providerUncertaintyPaise: 10001 },
    });
  });

  it('keeps legacy read-model balances unavailable until the governed journal transition', async () => {
    const f = await fixture();
    f.journalTransition.state = {
      ...f.journalTransition.state,
      readModel: 'legacy_ledger_v1',
      phase: 'legacy_reads',
    };
    await f.ledger.createBatch([
      createLedgerEntry({
        id: 'legacy',
        organizationId: ORG,
        orderId: 'legacy',
        eventId: 'missing',
        entryType: 'host_payout',
        amount: 10001,
        status: 'settled',
        idempotencyKey: 'legacy',
        now: NOW,
      }),
    ]);
    expect(await f.balance()).toMatchObject({
      availablePaise: 0,
      pendingPaise: 10001,
      readModel: 'legacy_ledger_v1',
      settlementUnavailableReason: expect.stringContaining('controlled journal transition'),
    });
  });
});
