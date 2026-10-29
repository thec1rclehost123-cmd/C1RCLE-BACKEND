import { describe, expect, it } from 'vitest';

import { NotFoundError, VersionConflictError } from '../../domain/errors.js';
import { MemoryFinancialJournalRepository } from '../../infrastructure/memory/memory-financial-journal-repository.js';
import { MemoryProviderFinancialEventRepository } from '../../infrastructure/memory/memory-provider-financial-event-repository.js';
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { ProviderPaymentService } from './provider-payment-service.js';

import type { DomainEvent } from '../../domain/events.js';
import type {
  ProviderPayment,
  ProviderPaymentEvent,
} from '../../domain/models/provider-payment.js';
import type { ProviderPaymentRepository } from '../../domain/ports/repositories.js';
import type { ServiceDeps } from '../context.js';

const NOW = new Date('2026-10-11T10:00:00.000Z');

const order = {
  id: 'ord_9',
  paymentId: 'pay_1',
  grandTotalPaise: 118_000,
  currency: 'INR',
  refundedPaise: 0,
  organizationId: 'org_host',
  eventId: 'event_1',
};

function build(
  providerPayments: ProviderPaymentRepository = new MemoryProviderPaymentRepository(),
  orderRecord: unknown = order,
) {
  const providerFinancialEvents = new MemoryProviderFinancialEventRepository();
  const financialJournals = new MemoryFinancialJournalRepository();
  const outboxEvents: DomainEvent[] = [];
  // The service needs only these three collaborators; the rest of ServiceDeps is irrelevant here.
  const deps = {
    repositories: {
      providerPayments,
      providerFinancialEvents,
      orders: { getById: async (id: string) => (id === order.id ? orderRecord : null) },
      financialJournals,
    },
    config: { clock: { now: () => NOW } },
    outbox: {
      append: async (event: DomainEvent) => {
        outboxEvents.push(event);
      },
    },
  } as unknown as ServiceDeps;
  return {
    service: new ProviderPaymentService(deps),
    providerPayments,
    providerFinancialEvents,
    financialJournals,
    outboxEvents,
  };
}

async function seedSale(journals: MemoryFinancialJournalRepository, withPromoter = false) {
  await new FinancialPostingService(journals).postTicketSale({
    organizationId: 'org_host',
    orderId: order.id,
    eventId: order.eventId,
    paymentId: 'pay_1',
    sourceType: 'online_payment_capture',
    providerConfirmed: true,
    currency: 'INR',
    ticketFaceValuePaise: 100_000,
    discountPaise: 0,
    discountFundingOwner: null,
    netTicketRevenuePaise: 100_000,
    gstPaise: 18_000,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    allocation: {
      platformPaise: 10_000,
      hostOrganizationId: 'org_host',
      hostPaise: withPromoter ? 88_750 : 90_000,
      venueOrganizationId: null,
      venuePaise: 0,
      promoterOrganizationId: withPromoter ? 'org_promoter' : null,
      promoterPaise: withPromoter ? 1_250 : 0,
    },
  });
}

const captured: ProviderPaymentEvent = {
  type: 'captured',
  paymentId: 'pay_1',
  providerOrderId: 'order_p1',
  orderId: 'ord_9',
  correlated: true,
  amountPaise: 118_000,
  currency: 'INR',
  feePaise: 2_360,
  taxOnFeePaise: 425,
  occurredAt: NOW.toISOString(),
};

describe('MemoryProviderPaymentRepository', () => {
  const record = (version: number): ProviderPayment => ({
    id: 'pay_1',
    provider: 'razorpay',
    providerOrderId: null,
    orderId: null,
    processingState: 'requires_support',
    currency: 'INR',
    capturedPaise: 1,
    feePaise: 0,
    taxOnFeePaise: 0,
    capturedAt: null,
    refunds: {},
    disputes: {},
    version,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  it('refuses to create a record that already exists, and to skip a version', async () => {
    const repo = new MemoryProviderPaymentRepository();
    await repo.save(record(1));

    await expect(repo.save(record(1))).rejects.toBeInstanceOf(VersionConflictError);
    await expect(repo.save(record(3))).rejects.toBeInstanceOf(VersionConflictError);
    await repo.save(record(2));
    expect((await repo.findByPaymentId('pay_1'))?.version).toBe(2);
  });

  it('hands out copies, so a caller cannot edit the stored record', async () => {
    const repo = new MemoryProviderPaymentRepository();
    await repo.save(record(1));

    const found = await repo.findByPaymentId('pay_1');
    if (found) found.capturedPaise = 999;

    expect((await repo.findByPaymentId('pay_1'))?.capturedPaise).toBe(1);
  });
});

describe('ProviderPaymentService.recordEvent', () => {
  it('stores a capture and writes nothing for an exact replay', async () => {
    const { service, providerPayments, providerFinancialEvents } = build();

    await service.recordEvent(captured);
    await service.recordEvent(captured);

    expect((await providerPayments.findByPaymentId('pay_1'))?.version).toBe(1);
    const ingested = await providerFinancialEvents.listByPaymentId('pay_1');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      processingState: 'processed',
      processingAttempts: 1,
      finalResult: 'provider_aggregate_updated',
    });
  });

  it('emits one outbox event for a Promoter commission chargeback hold', async () => {
    const attributed = {
      ...order,
      attribution: { promoterId: 'org_promoter', promoterCommissionPaise: 1_250 },
    };
    const { service, outboxEvents, financialJournals } = build(
      new MemoryProviderPaymentRepository(),
      attributed,
    );
    await seedSale(financialJournals, true);
    await service.recordEvent(captured);
    const dispute: ProviderPaymentEvent = {
      type: 'dispute',
      paymentId: 'pay_1',
      disputeId: 'disp_m4_1',
      amountPaise: 3_000,
      currency: 'INR',
      status: 'open',
      amountDeductedPaise: 0,
      reasonCode: 'test_reason',
      reasonDescription: null,
      respondBy: null,
      phase: 'chargeback',
      evidenceState: 'none',
      providerOccurredAt: null,
    };

    await service.recordEvent(dispute);
    await service.recordEvent(dispute);

    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]).toMatchObject({
      id: expect.stringMatching(/^EVT-/),
      type: 'finance.chargeback.updated',
      aggregateId: order.id,
      payload: { orderId: order.id, disputeId: 'disp_m4_1', status: 'open' },
    });
  });

  it('converges when several webhooks for one payment land at the same time', async () => {
    const { service, providerPayments, financialJournals } = build();
    await seedSale(financialJournals);
    await service.recordEvent(captured);

    await Promise.all([
      service.recordEvent({
        type: 'refund_processed',
        paymentId: 'pay_1',
        refundId: 'rfnd_1',
        amountPaise: 5_000,
        currency: 'INR',
      }),
      service.recordEvent({
        type: 'dispute',
        paymentId: 'pay_1',
        disputeId: 'disp_1',
        amountPaise: 3_000,
        currency: 'INR',
        status: 'lost',
        amountDeductedPaise: 3_000,
        reasonCode: 'test_reason',
        reasonDescription: null,
        respondBy: null,
        phase: 'chargeback',
        evidenceState: 'none',
        providerOccurredAt: null,
      }),
    ]);

    const stored = await providerPayments.findByPaymentId('pay_1');
    expect(stored).toMatchObject({
      capturedPaise: 118_000,
      feePaise: 2_360,
      refunds: { rfnd_1: 5_000 },
      disputes: { disp_1: { amountPaise: 3_000, status: 'lost' } },
    });
  });

  it('gives up with the conflict if the store keeps losing the race', async () => {
    const stuck: ProviderPaymentRepository = {
      findByPaymentId: async () => null,
      findByProviderOrderId: async () => null,
      listAll: async () => ({ items: [], nextCursor: null, total: 0 }),
      save: async () => {
        throw new VersionConflictError(0, 1);
      },
    };
    const { service } = build(stuck);

    await expect(service.recordEvent(captured)).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('does not swallow other storage errors', async () => {
    const broken: ProviderPaymentRepository = {
      findByPaymentId: async () => null,
      findByProviderOrderId: async () => null,
      listAll: async () => ({ items: [], nextCursor: null, total: 0 }),
      save: async () => {
        throw new Error('disk on fire');
      },
    };
    const { service, providerFinancialEvents } = build(broken);

    await expect(service.recordEvent(captured)).rejects.toThrow('disk on fire');
    expect((await providerFinancialEvents.listByPaymentId('pay_1'))[0]).toMatchObject({
      processingState: 'support_required',
      finalResult: 'disk on fire',
    });
  });
});

describe('ProviderPaymentService.reconcileOrder', () => {
  it('reconciles an order with a matching capture, and exposes the provider net', async () => {
    const { service } = build();
    await service.recordEvent(captured);

    expect(await service.reconcileOrder('ord_9')).toMatchObject({
      reconciled: true,
      providerNetPaise: 118_000 - 2_360 - 425,
    });
  });

  it('flags an order whose payment the provider never reported', async () => {
    const { service } = build();

    expect(await service.reconcileOrder('ord_9')).toMatchObject({
      reconciled: false,
      findings: [{ kind: 'provider_record_missing' }],
    });
  });

  it('flags a provider refund the order does not know about', async () => {
    const { service } = build();
    await service.recordEvent(captured);
    await service.recordEvent({
      type: 'refund_processed',
      paymentId: 'pay_1',
      refundId: 'rfnd_1',
      amountPaise: 5_000,
      currency: 'INR',
    });

    const result = await service.reconcileOrder('ord_9');
    expect(result.reconciled).toBe(false);
    expect(result.findings).toContainEqual({
      kind: 'refund_mismatch',
      ourPaise: 0,
      providerPaise: 5_000,
    });
  });

  it('reports an unknown order as not found', async () => {
    const { service } = build();

    await expect(service.reconcileOrder('ord_missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
