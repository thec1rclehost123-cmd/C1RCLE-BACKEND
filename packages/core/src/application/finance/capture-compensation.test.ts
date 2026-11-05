import { describe, expect, it, vi } from 'vitest';

import { createCoreConfig } from '../../config/index.js';
import { NON_PRODUCTION_BOOKING_FEE_POLICY } from '../../domain/models/booking-fee-policy.js';
import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent } from '../../domain/models/event.js';
import { createOrder } from '../../domain/models/order.js';
import { calculatePricing } from '../../domain/models/pricing.js';
import { applyProviderPaymentEvent } from '../../domain/models/provider-payment.js';
import { buildRepositories } from '../../infrastructure/utils.js';

import { requestCaptureCompensation } from './capture-compensation.js';
import { FinancialPostingService } from './financial-posting-service.js';

async function fixture() {
  const now = new Date('2026-11-04T00:00:00Z');
  const config = createCoreConfig({
    firestore: { projectId: 'test-compensation' },
    redis: { url: 'redis://localhost:6379' },
    clock: { now: () => now },
  });
  const repositories = buildRepositories({
    STORAGE_DRIVER: 'memory',
    FIRESTORE_PROJECT_ID: 'test-compensation',
  });
  const event = createEvent({
    id: 'event-compensation',
    organizationId: 'host',
    venueId: 'venue',
    title: 'Synthetic compensation',
    startAt: '2026-12-01T00:00:00Z',
    now,
  });
  await repositories.events.save(event);
  const tier = createTicketTier({
    id: 'tier',
    eventId: event.id,
    organizationId: 'host',
    name: 'Entry',
    priceInPaise: 100000,
    quantity: 10,
    now,
  });
  const pricing = calculatePricing({
    lines: [{ tier, quantity: 1 }],
    currency: 'INR',
    feePolicy: NON_PRODUCTION_BOOKING_FEE_POLICY,
  });
  const order = {
    ...createOrder({
      id: 'ORD-pay_compensation',
      eventId: event.id,
      organizationId: 'host',
      userId: 'guest',
      contact: { name: 'Synthetic', email: 'synthetic@example.test', phone: '' },
      pricing,
      now,
    }),
    status: 'paid' as const,
    paymentId: 'pay_compensation',
    paymentIntentId: 'order_compensation',
    fulfillmentState: 'pending' as const,
    compensationRequired: {
      reason: 'capacity_unavailable' as const,
      requestedAt: now.toISOString(),
    },
  };
  await repositories.orders.save(order);
  await repositories.providerPayments.save(
    applyProviderPaymentEvent(
      null,
      {
        type: 'captured',
        paymentId: order.paymentId,
        providerOrderId: order.paymentIntentId,
        orderId: null,
        correlated: true,
        amountPaise: order.grandTotalPaise,
        currency: order.currency,
        feePaise: 0,
        taxOnFeePaise: 0,
        occurredAt: now.toISOString(),
      },
      now,
    ),
  );
  await new FinancialPostingService(repositories.financialJournals).postTicketSale({
    organizationId: 'host',
    orderId: order.id,
    eventId: event.id,
    paymentId: order.paymentId,
    sourceType: 'online_payment_capture',
    providerConfirmed: true,
    currency: 'INR',
    ticketFaceValuePaise: 100000,
    discountPaise: 0,
    discountFundingOwner: null,
    netTicketRevenuePaise: 100000,
    platformFeePaise: order.platformFeePaise,
    paymentFeePaise: order.paymentFeePaise,
    gstPaise: order.gstPaise,
    allocation: {
      platformPaise: 0,
      hostOrganizationId: 'host',
      hostPaise: 100000,
      venueOrganizationId: null,
      venuePaise: 0,
      promoterOrganizationId: null,
      promoterPaise: 0,
    },
  });
  return { config, repositories, order, now };
}

describe('canonical captured-purchase compensation intake', () => {
  it('atomically queues the full original payment, preserves approval requirements, and replays', async () => {
    const f = await fixture();
    const result = await requestCaptureCompensation(f, f.order.id);
    expect(result.request).toMatchObject({
      refundCause: 'fulfillment_failure',
      amountPaise: f.order.grandTotalPaise,
      status: 'pending',
      approversRequired: 1,
      executionAttempts: 0,
      providerRefundId: null,
      scope: 'amount_only',
      targetEntitlementIds: [],
    });
    expect(result.request.refundComponents).toMatchObject({
      admissionPaise: 100000,
      platformFeePaise: f.order.platformFeePaise,
      paymentFeePaise: f.order.paymentFeePaise,
      feeTaxPaise: f.order.gstPaise,
    });
    expect(result.order.status).toBe('refund_requested');
    expect((await requestCaptureCompensation(f, f.order.id)).request).toEqual(result.request);
    expect(await f.repositories.entitlements.getByOrderId(f.order.id)).toEqual([]);
    expect(await f.repositories.refundRequests.listByOrder(f.order.id)).toHaveLength(1);
  });

  it('refuses compensation for issued rights, requiring the exact-ticket workflow', async () => {
    const f = await fixture();
    await f.repositories.entitlements.saveMany(issueEntitlements({ order: f.order, now: f.now }));
    await expect(requestCaptureCompensation(f, f.order.id)).rejects.toThrow('exact-ticket');
    expect(await f.repositories.refundRequests.listByOrder(f.order.id)).toEqual([]);
    expect((await f.repositories.orders.getById(f.order.id))?.status).toBe('paid');
  });

  it('leaves no lock or request when atomic persistence fails and recovers on retry', async () => {
    const f = await fixture();
    const begin = vi
      .spyOn(f.repositories.orders, 'beginRefundRequest')
      .mockRejectedValueOnce(new Error('injected intake failure'));
    await expect(requestCaptureCompensation(f, f.order.id)).rejects.toThrow(
      'injected intake failure',
    );
    expect(await f.repositories.refundRequests.listByOrder(f.order.id)).toEqual([]);
    expect((await f.repositories.orders.getById(f.order.id))?.status).toBe('paid');
    begin.mockRestore();
    expect((await requestCaptureCompensation(f, f.order.id)).order.status).toBe('refund_requested');
  });
});
