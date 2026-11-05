import { describe, expect, it } from 'vitest';

import { createCartReservation } from '../../domain/models/cart-reservation.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createOrder, lockOrderForRefund, applyOrderRefund } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { quoteOriginalRefund } from '../../domain/models/purchase-refund-snapshot.js';
import {
  createRefundRequest,
  approveRefundRequest,
  beginRefundExecution,
  recordRefundProviderFact,
  markRefundSettled,
} from '../../domain/models/refund-request.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryReconciliationRepository } from '../../infrastructure/memory/memory-reconciliation-repository.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { ReconciliationService } from './reconciliation-service.js';

import type { CartReservation } from '../../domain/models/cart-reservation.js';
import type { Entitlement } from '../../domain/models/entitlement.js';
import type { Order } from '../../domain/models/order.js';
import type { Payout } from '../../domain/models/payout.js';
import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type { AdminRefundRequest } from '../../domain/models/refund-request.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');

function page<T>(items: T[]) {
  return { items, total: items.length, nextCursor: null };
}

function order(input: Partial<Order> & Pick<Order, 'id' | 'status'>): Order {
  const value = input.grandTotalPaise === 0 ? 0 : 1000;
  const base: Order = {
    id: input.id,
    eventId: 'event_1',
    organizationId: 'org_1',
    userId: 'user_1',
    contact: { name: 'Test', email: 'test@example.invalid', phone: '0000000000' },
    status: input.status,
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'GA',
        quantity: 1,
        unitPricePaise: value,
        subtotalPaise: value,
      },
    ],
    currency: 'INR',
    subtotalPaise: value,
    discountPaise: 0,
    discountFundingOwner: null,
    discountedSubtotalPaise: value,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: value,
    appliedPromoCode: null,
    attribution: null,
    paymentIntentId: input.paymentIntentId ?? null,
    paymentId: input.paymentId ?? null,
    paidAt: input.paidAt ?? null,
    reservationExpiresAt: NOW.toISOString(),
    failureReason: null,
    refundedPaise: 0,
    appliedRefundRequestIds: [],
    version: 1,
    createdAt: input.createdAt ?? NOW.toISOString(),
    updatedAt: input.updatedAt ?? NOW.toISOString(),
  };
  return { ...base, ...input };
}

function providerPayment(
  input: Partial<ProviderPayment> & Pick<ProviderPayment, 'id'>,
): ProviderPayment {
  return {
    id: input.id,
    provider: 'razorpay',
    providerOrderId: input.providerOrderId ?? null,
    orderId: input.orderId ?? null,
    processingState: input.processingState ?? 'fulfilled',
    currency: input.currency ?? 'INR',
    capturedPaise: input.capturedPaise ?? 1000,
    feePaise: 0,
    taxOnFeePaise: 0,
    capturedAt: NOW.toISOString(),
    refunds: input.refunds ?? {},
    disputes: input.disputes ?? {},
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function build(input: {
  orders?: Order[];
  payments?: ProviderPayment[];
  payouts?: Payout[];
  tickets?: Entitlement[];
  holds?: CartReservation[];
  refunds?: AdminRefundRequest[];
  failOrders?: boolean;
}) {
  const reconciliations = new MemoryReconciliationRepository();
  const journals = new MemoryFinancialJournalRepository();
  let id = 0;
  const deps = {
    config: { clock: { now: () => NOW }, ids: () => String(++id) },
    repositories: {
      reconciliations,
      orders: {
        listAll: async () => {
          if (input.failOrders) throw new Error('orders unavailable');
          return page(input.orders ?? []);
        },
      },
      providerPayments: { listAll: async () => page(input.payments ?? []) },
      entitlements: { listAll: async () => page(input.tickets ?? []) },
      payouts: { listByStatus: async () => page(input.payouts ?? []) },
      cartReservations: {
        getByProviderOrderId: async (id: string) =>
          input.holds?.find((hold) => hold.providerOrderId === id) ?? null,
      },
      refundRequests: {
        listByOrder: async (id: string) =>
          input.refunds?.filter((request) => request.orderId === id) ?? [],
      },
      financialJournals: journals,
    },
  } as unknown as ServiceDeps;
  return { service: new ReconciliationService(deps), reconciliations, journals };
}

describe('ReconciliationService', () => {
  it('persists a run and minimum high-risk discrepancies without payer data', async () => {
    const paid = order({ id: 'order_paid', status: 'paid', paymentId: 'pay_missing' });
    const stale = order({
      id: 'order_stale',
      status: 'awaiting_payment',
      updatedAt: '2026-10-16T10:00:00.000Z',
    });
    const orphanCapture = providerPayment({ id: 'pay_orphan', orderId: null });
    const payout = {
      id: 'payout_1',
      organizationId: 'org_1',
      amount: 5000,
      status: 'paid',
    } as Payout;
    const { service, reconciliations } = build({
      orders: [paid, stale],
      payments: [orphanCapture],
      payouts: [payout],
    });

    const run = await service.run('admin_1');
    const discrepancies = await reconciliations.listDiscrepancies({ limit: 100 });
    const kinds = new Set(discrepancies.items.map((item) => item.kind));

    expect(run).toMatchObject({ status: 'completed', requestedBy: 'admin_1' });
    expect([...kinds]).toEqual(
      expect.arrayContaining([
        'captured_payment_without_order',
        'paid_order_without_capture',
        'paid_order_without_ticket',
        'missing_journal',
        'stale_pending_payment',
        'payout_mismatch',
      ]),
    );
    expect(JSON.stringify(discrepancies.items)).not.toContain('test@example.invalid');
  });

  it('requires a reason and resolves a discrepancy idempotently', async () => {
    const { service, reconciliations } = build({
      payments: [providerPayment({ id: 'pay_orphan' })],
    });
    await service.run('admin_1');
    const item = (await reconciliations.listDiscrepancies({ limit: 10 })).items[0];
    expect(item).toBeDefined();
    if (!item) return;

    await expect(service.resolve(item.id, ' ', 'admin_2')).rejects.toThrow(
      'Resolution requires a reason',
    );
    const resolved = await service.resolve(item.id, 'Provider record reviewed', 'admin_2');
    const replay = await service.resolve(item.id, 'ignored on replay', 'admin_2');
    expect(resolved).toMatchObject({ state: 'resolved', resolvedBy: 'admin_2' });
    expect(replay).toEqual(resolved);
  });

  it('persists a failed run when a source cannot be scanned', async () => {
    const { service, reconciliations } = build({ failOrders: true });
    await expect(service.run('admin_1')).rejects.toThrow('orders unavailable');
    const runs = await reconciliations.listRuns({ limit: 10 });
    expect(runs.items[0]).toMatchObject({
      status: 'failed',
      failureReason: 'orders unavailable',
    });
  });
});

describe('M3 legitimate issuance and lifecycle reconciliation', () => {
  it.each(['RSVP-free', 'COMP-free'])(
    'does not demand a provider capture for %s zero-value issuance',
    async (id) => {
      const free = order({
        id,
        status: 'paid',
        grandTotalPaise: 0,
        lines: [
          {
            tierId: 'free-tier',
            tierName: 'Free',
            quantity: 1,
            unitPricePaise: 0,
            subtotalPaise: 0,
          },
        ],
      });
      const tickets = issueEntitlements({
        order: free,
        unitKind: id.startsWith('RSVP') ? 'free_rsvp' : 'complimentary',
        now: NOW,
      });
      const { service, reconciliations } = build({ orders: [free], tickets });
      await service.run('admin');
      expect((await reconciliations.listDiscrepancies({ limit: 100 })).items).toEqual([]);
    },
  );

  it('retains intentional cancelled RSVP void history without raising an orphan ticket', async () => {
    const paidFree = order({ id: 'RSVP-cancelled', status: 'paid', grandTotalPaise: 0 });
    const tickets = issueEntitlements({ order: paidFree, unitKind: 'free_rsvp', now: NOW }).map(
      (ticket) => ({ ...ticket, status: 'void' as const }),
    );
    const { service, reconciliations } = build({
      orders: [{ ...paidFree, status: 'cancelled' }],
      tickets,
    });
    await service.run('admin');
    expect((await reconciliations.listDiscrepancies({ limit: 100 })).items).toEqual([]);
  });

  it('counts each person issued by a group line while still detecting a missing person', async () => {
    const freeGroup = order({
      id: 'group-issued',
      status: 'paid',
      grandTotalPaise: 0,
      lines: [
        {
          tierId: 'group-tier',
          tierName: 'Group',
          quantity: 2,
          guestCount: 3,
          admissionMode: 'per_person',
          unitPricePaise: 0,
          subtotalPaise: 0,
        },
      ],
    });
    const tickets = issueEntitlements({ order: freeGroup, now: NOW });
    expect(tickets).toHaveLength(6);
    const complete = build({ orders: [freeGroup], tickets });
    await complete.service.run('admin');
    expect((await complete.reconciliations.listDiscrepancies({ limit: 100 })).items).toEqual([]);
    const incomplete = build({ orders: [freeGroup], tickets: tickets.slice(0, 5) });
    await incomplete.service.run('admin');
    expect(
      (await incomplete.reconciliations.listDiscrepancies({ limit: 100 })).items,
    ).toMatchObject([
      { kind: 'paid_order_without_ticket', evidence: { expectedTickets: 6, actualTickets: 5 } },
    ]);
  });

  it('still reports a valid ticket attached to cancelled RSVP or a genuinely missing order', async () => {
    const paidFree = order({ id: 'RSVP-invalid-history', status: 'paid', grandTotalPaise: 0 });
    const tickets = issueEntitlements({ order: paidFree, now: NOW });
    const first = tickets[0];
    if (!first) throw new Error('Issued fixture ticket missing');
    const { service, reconciliations } = build({
      orders: [{ ...paidFree, status: 'cancelled' }],
      tickets: [...tickets, { ...first, id: 'orphan', orderId: 'missing-order' }],
    });
    await service.run('admin');
    expect(
      (await reconciliations.listDiscrepancies({ limit: 100 })).items.filter(
        (item) => item.kind === 'ticket_without_paid_order',
      ),
    ).toHaveLength(2);
  });

  it.each(['refund_requested', 'refunded'] as const)(
    'checks original journals for %s positive-paid orders',
    async (status) => {
      const paid = order({ id: 'paid-original', status: 'paid', paymentId: 'pay-original' });
      const tickets = issueEntitlements({ order: paid, now: NOW });
      const f = build({
        orders: [{ ...paid, status }],
        payments: [providerPayment({ id: 'pay-original', orderId: paid.id })],
        tickets,
      });
      await f.service.run('admin');
      expect(
        (await f.reconciliations.listDiscrepancies({ limit: 100 })).items.filter(
          (item) => item.kind === 'missing_journal',
        ),
      ).toHaveLength(2);
    },
  );

  it('accepts a partial settled exact-ticket refund with original void history and detects refund drift', async () => {
    const paid = order({
      id: 'partial-paid',
      status: 'paid',
      paymentId: 'pay-partial',
      lines: [
        { tierId: 'tier_1', tierName: 'GA', quantity: 2, unitPricePaise: 500, subtotalPaise: 1000 },
      ],
      refundedPaise: 500,
    });
    const tickets = issueEntitlements({ order: paid, now: NOW }).map((ticket, index) => ({
      ...ticket,
      ...(index === 0 ? { status: 'void' as const } : {}),
    }));
    const f = build({
      orders: [paid],
      payments: [
        providerPayment({
          id: 'pay-partial',
          orderId: paid.id,
          refunds: { 'refund-partial': 500 },
        }),
      ],
      tickets,
    });
    await new FinancialPostingService(f.journals).postTicketSale({
      organizationId: paid.organizationId,
      orderId: paid.id,
      eventId: paid.eventId,
      paymentId: paid.paymentId,
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: 1000,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 1000,
      gstPaise: 0,
      platformFeePaise: 0,
      paymentFeePaise: 0,
      allocation: {
        platformPaise: 0,
        hostOrganizationId: paid.organizationId,
        hostPaise: 1000,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      postedAt: NOW,
    });
    const missingRefundJournal = await f.service.run('admin');
    expect(
      (
        await f.reconciliations.listDiscrepancies({ limit: 100, runId: missingRefundJournal.id })
      ).items.some((item) => item.kind === 'refund_mismatch'),
    ).toBe(true);
    await new FinancialPostingService(f.journals).postRefund({
      organizationId: paid.organizationId,
      orderId: paid.id,
      eventId: paid.eventId,
      paymentId: 'pay-partial',
      refundRequestId: 'request-partial',
      providerRefundId: 'refund-partial',
      amountPaise: 500,
      previouslyRefundedPaise: 0,
      postedAt: NOW,
    });
    const completed = await f.service.run('admin');
    expect(
      (await f.reconciliations.listDiscrepancies({ limit: 100, runId: completed.id })).items,
    ).toEqual([]);
    // Fresh reconciliation does not silently resolve the earlier operator-owned finding.
    expect(
      (
        await f.reconciliations.listDiscrepancies({ limit: 100, runId: missingRefundJournal.id })
      ).items.some((item) => item.state === 'finance_review'),
    ).toBe(true);
    const drift = build({
      orders: [paid],
      payments: [
        providerPayment({
          id: 'pay-partial',
          orderId: paid.id,
          refunds: { 'refund-partial': 501 },
        }),
      ],
      tickets,
    });
    await drift.service.run('admin');
    expect(
      (await drift.reconciliations.listDiscrepancies({ limit: 100 })).items.some(
        (item) => item.kind === 'refund_mismatch',
      ),
    ).toBe(true);
  });
});

describe('M4 intentional zero-rights capture compensation', () => {
  async function compensated(stage: 'approved' | 'settled') {
    const tier = createTicketTier({
      id: 'comp-tier',
      eventId: 'comp-event',
      organizationId: 'comp-org',
      name: 'Entry',
      quantity: 10,
      priceInPaise: 1000,
      now: NOW,
    });
    const pricing = calculatePricing({ lines: [{ tier, quantity: 1 }] });
    const paid: Order = {
      ...createOrder({
        id: 'comp-order',
        eventId: tier.eventId,
        organizationId: tier.organizationId,
        userId: 'comp-buyer',
        contact: { name: 'Synthetic', email: '', phone: '' },
        pricing,
        now: NOW,
      }),
      status: 'paid',
      paymentId: 'pay-comp',
      paymentIntentId: 'provider-comp',
      fulfillmentState: 'pending',
      compensationRequired: { reason: 'capacity_unavailable', requestedAt: NOW.toISOString() },
    };
    const quote = quoteOriginalRefund(
      paid,
      paid.refundSnapshot?.tickets.map((ticket) => ticket.entitlementId) ?? [],
      'fulfillment_failure',
    );
    let request = createRefundRequest({
      id: 'comp-request',
      orderId: paid.id,
      organizationId: paid.organizationId,
      requestedBy: 'system_checkout_compensation',
      reason: 'Captured purchase could not grant admission',
      amountPaise: quote.amountPaise,
      refundCause: quote.cause,
      refundComponents: quote.components,
      purchasePolicyVersion: quote.purchasePolicyVersion,
      sourceEventVersion: 1,
      intakeFingerprint: 'comp-intent',
      scope: 'amount_only',
      targetEntitlementIds: [],
      ticketLines: [],
      hasRedeemedEntitlement: false,
      thresholds: { singleApproverCeilingPaise: 1, dualApproverCeilingPaise: 100000 },
      now: NOW,
    });
    request = approveRefundRequest(request, 'finance-approver', NOW);
    let current = lockOrderForRefund(paid, NOW);
    let payment = applyProviderPaymentEvent(
      null,
      {
        type: 'captured',
        paymentId: 'pay-comp',
        providerOrderId: paid.paymentIntentId,
        orderId: null,
        correlated: true,
        amountPaise: paid.grandTotalPaise,
        currency: 'INR',
        feePaise: 0,
        taxOnFeePaise: 0,
        occurredAt: NOW.toISOString(),
      },
      NOW,
    );
    if (stage === 'settled') {
      request = recordRefundProviderFact(
        beginRefundExecution(request, NOW),
        'rfnd-comp',
        'processed',
        NOW,
      );
      payment = applyProviderPaymentEvent(
        payment,
        {
          type: 'refund_processed',
          paymentId: payment.id,
          refundId: 'rfnd-comp',
          amountPaise: paid.grandTotalPaise,
          currency: 'INR',
        },
        NOW,
      );
      current = applyOrderRefund(current, paid.grandTotalPaise, NOW, request.id);
      request = markRefundSettled(request, 'rfnd-comp', NOW);
    }
    const hold = {
      ...createCartReservation({
        id: 'comp-hold',
        eventId: paid.eventId,
        organizationId: paid.organizationId,
        userId: paid.userId,
        lines: [{ tierId: tier.id, tierName: tier.name, quantity: 1, unitPricePaise: 1000 }],
        pricing,
        appliedPromoCode: null,
        attribution: null,
        idempotencyKey: 'comp-hold',
        now: NOW,
      }),
      providerOrderId: paid.paymentIntentId,
      status: 'released' as const,
    };
    const input = {
      orders: [current],
      payments: [payment],
      holds: [hold],
      refunds: [request],
      tickets: [] as Entitlement[],
    };
    const f = build(input),
      posting = new FinancialPostingService(f.journals);
    await posting.postTicketSale({
      organizationId: paid.organizationId,
      orderId: paid.id,
      eventId: paid.eventId,
      paymentId: paid.paymentId,
      sourceType: 'online_payment_capture',
      providerConfirmed: true,
      currency: 'INR',
      ticketFaceValuePaise: 1000,
      discountPaise: 0,
      discountFundingOwner: null,
      netTicketRevenuePaise: 1000,
      gstPaise: paid.gstPaise,
      platformFeePaise: paid.platformFeePaise,
      paymentFeePaise: paid.paymentFeePaise,
      allocation: {
        platformPaise: 0,
        hostOrganizationId: paid.organizationId,
        hostPaise: 1000,
        venueOrganizationId: null,
        venuePaise: 0,
        promoterOrganizationId: null,
        promoterPaise: 0,
      },
      postedAt: NOW,
    });
    if (stage === 'settled')
      await posting.postRefund({
        organizationId: paid.organizationId,
        orderId: paid.id,
        eventId: paid.eventId,
        paymentId: payment.id,
        refundRequestId: request.id,
        providerRefundId: 'rfnd-comp',
        amountPaise: request.amountPaise,
        refundComponents: request.refundComponents,
        previouslyRefundedPaise: 0,
        postedAt: NOW,
      });
    return { ...f, input, paid, request, current, payment, hold };
  }
  it.each(['approved', 'settled'] as const)(
    'recognizes %s full-original compensation without demanding admissions or a converted hold',
    async (stage) => {
      const f = await compensated(stage);
      await f.service.run('finance-admin');
      expect((await f.reconciliations.listDiscrepancies({ limit: 100 })).items).toEqual([]);
    },
  );
  it.each(['valid', 'void'] as const)(
    'flags any %s ticket issued for a blocked compensation order',
    async (status) => {
      const f = await compensated('settled');
      f.input.tickets.push(
        ...issueEntitlements({ order: f.paid, now: NOW }).map((ticket) => ({ ...ticket, status })),
      );
      await f.service.run('finance-admin');
      expect((await f.reconciliations.listDiscrepancies({ limit: 100 })).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'paid_order_without_ticket',
            evidence: expect.objectContaining({ expectedTickets: 0, actualTickets: 1 }),
          }),
        ]),
      );
    },
  );
  it.each(['request', 'capture', 'refund', 'journal', 'refund_journal', 'binding'] as const)(
    'does not let the compensation marker hide missing %s evidence',
    async (missing) => {
      const f = await compensated('settled');
      if (missing === 'request') f.input.refunds.length = 0;
      if (missing === 'capture') f.input.payments.length = 0;
      if (missing === 'refund') f.input.payments[0] = { ...f.payment, refunds: {} };
      if (missing === 'journal') f.journals.journals.clear();
      if (missing === 'refund_journal') {
        for (const journal of f.journals.journals.values())
          if (journal.idempotencyKey.endsWith(':provider-settlement'))
            f.journals.journals.delete(journal.id);
      }
      if (missing === 'binding') f.input.holds[0] = { ...f.hold, userId: 'wrong-buyer' };
      await f.service.run('finance-admin');
      expect(
        (await f.reconciliations.listDiscrepancies({ limit: 100 })).items.some(
          (item) => item.kind === 'paid_order_without_ticket',
        ),
      ).toBe(true);
    },
  );
});
