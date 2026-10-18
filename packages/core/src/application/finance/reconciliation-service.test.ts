import { describe, expect, it } from 'vitest';

import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryReconciliationRepository } from '../../infrastructure/memory/memory-reconciliation-repository.js';

import { ReconciliationService } from './reconciliation-service.js';

import type { Order } from '../../domain/models/order.js';
import type { Payout } from '../../domain/models/payout.js';
import type { ProviderPayment } from '../../domain/models/provider-payment.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');

function page<T>(items: T[]) {
  return { items, total: items.length, nextCursor: null };
}

function order(input: Partial<Order> & Pick<Order, 'id' | 'status'>): Order {
  return {
    id: input.id,
    eventId: 'event_1',
    organizationId: 'org_1',
    userId: 'user_1',
    contact: { name: 'Test', email: 'test@example.invalid', phone: '0000000000' },
    status: input.status,
    lines: [
      { tierId: 'tier_1', tierName: 'GA', quantity: 1, unitPricePaise: 1000, subtotalPaise: 1000 },
    ],
    currency: 'INR',
    subtotalPaise: 1000,
    discountPaise: 0,
    discountFundingOwner: null,
    discountedSubtotalPaise: 1000,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: 1000,
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
      entitlements: { listAll: async () => page([]) },
      payouts: { listByStatus: async () => page(input.payouts ?? []) },
      cartReservations: { getByProviderOrderId: async () => null },
      financialJournals: journals,
    },
  } as unknown as ServiceDeps;
  return { service: new ReconciliationService(deps), reconciliations };
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
