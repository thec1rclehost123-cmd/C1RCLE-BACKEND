import { describe, expect, it } from 'vitest';

import { NotFoundError, VersionConflictError } from '../../domain/errors.js';
import { MemoryProviderPaymentRepository } from '../../infrastructure/memory/memory-provider-payment-repository.js';

import { ProviderPaymentService } from './provider-payment-service.js';

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
};

function build(
  providerPayments: ProviderPaymentRepository = new MemoryProviderPaymentRepository(),
) {
  // The service needs only these three collaborators; the rest of ServiceDeps is irrelevant here.
  const deps = {
    repositories: {
      providerPayments,
      orders: { getById: async (id: string) => (id === order.id ? order : null) },
    },
    config: { clock: { now: () => NOW } },
  } as unknown as ServiceDeps;
  return { service: new ProviderPaymentService(deps), providerPayments };
}

const captured: ProviderPaymentEvent = {
  type: 'captured',
  paymentId: 'pay_1',
  providerOrderId: 'order_p1',
  orderId: 'ord_9',
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
    const { service, providerPayments } = build();

    await service.recordEvent(captured);
    await service.recordEvent(captured);

    expect((await providerPayments.findByPaymentId('pay_1'))?.version).toBe(1);
  });

  it('converges when several webhooks for one payment land at the same time', async () => {
    const { service, providerPayments } = build();

    await Promise.all([
      service.recordEvent(captured),
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
      save: async () => {
        throw new Error('disk on fire');
      },
    };
    const { service } = build(broken);

    await expect(service.recordEvent(captured)).rejects.toThrow('disk on fire');
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
