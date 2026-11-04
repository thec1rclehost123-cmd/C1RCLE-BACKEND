import { describe, expect, it, vi } from 'vitest';

import { createRefundRequest } from '../../domain/models/refund-request.js';

import { RefundService } from './refund-service.js';

import type { ServiceDeps } from '../context.js';

describe('RefundService cover refund policy gate', () => {
  const order = {
    id: 'ord_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    status: 'paid',
    grandTotalPaise: 10_000,
    refundedPaise: 0,
    appliedRefundRequestIds: [],
    lines: [{ tierId: 'tier_1', quantity: 1, coverUnitPricePaise: 500 }],
  };
  const coverAccount = {
    id: 'cover_1',
    entitlementId: 'ent_1',
    orderId: 'ord_1',
    eventId: 'evt_1',
    refundPolicy: 'saved_policy_review',
    issuedPaise: 500,
    remainingPaise: 500,
    reservedPaise: 0,
    redeemedPaise: 0,
    refundedPaise: 0,
    status: 'active',
    refundRequestId: null,
  };

  it('rejects partial refunds on cover accounts before locking the order', async () => {
    const orderSave = vi.fn();
    const refundSave = vi.fn();
    const authority = { authorize: vi.fn().mockResolvedValue({ id: 'admin_1' }) };
    const deps = {
      repositories: {
        financialJournals: {},
        orders: { getById: vi.fn().mockResolvedValue(order), save: orderSave },
        entitlements: {
          getByOrderId: vi.fn().mockResolvedValue([{ id: 'ent_1', tierId: 'tier_1' }]),
        },
        eventCoverAccounts: { getByEntitlement: vi.fn().mockResolvedValue(coverAccount) },
        refundRequests: { save: refundSave },
      },
    } as unknown as ServiceDeps;
    const service = new RefundService(deps, authority as never);

    await expect(
      service.requestRefund('admin_1', {
        orderId: 'ord_1',
        amountPaise: 2_500,
        reason: 'test refund',
      }),
    ).rejects.toThrow(/full unused balance/);

    expect(orderSave).not.toHaveBeenCalled();
    expect(refundSave).not.toHaveBeenCalled();
  });

  it('rechecks the saved cover policy before executing an already-approved refund', async () => {
    const providerRefund = vi.fn();
    const request = {
      id: 'refund_1',
      orderId: 'ord_1',
      status: 'approved',
      providerRefundId: null,
    };
    const authority = { authorize: vi.fn().mockResolvedValue({ id: 'admin_1' }) };
    const deps = {
      repositories: {
        financialJournals: {},
        orders: { getById: vi.fn().mockResolvedValue(order) },
        entitlements: {
          getByOrderId: vi.fn().mockResolvedValue([{ id: 'ent_1', tierId: 'tier_1' }]),
        },
        eventCoverAccounts: { getByEntitlement: vi.fn().mockResolvedValue(coverAccount) },
        refundRequests: { getById: vi.fn().mockResolvedValue(request) },
      },
      paymentProvider: { refundPayment: providerRefund },
    } as unknown as ServiceDeps;
    const service = new RefundService(deps, authority as never);

    await expect(service.executeRefund('admin_1', request.id)).rejects.toThrow(
      /full unused balance/,
    );

    expect(providerRefund).not.toHaveBeenCalled();
  });

  it('freezes eligible cover accounts before asking the provider to refund', async () => {
    const eligibleAccount = { ...coverAccount, refundPolicy: 'unused_full_before_redemption' };
    const request = createRefundRequest({
      id: 'refund_1',
      orderId: 'ord_1',
      organizationId: 'org_1',
      amountPaise: 10_000,
      requestedBy: 'admin_1',
      reason: 'event cancelled',
      hasRedeemedEntitlement: false,
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    const orderToRefund = { ...order, paymentId: 'pay_1' };
    const freezeForRefund = vi.fn().mockResolvedValue([eligibleAccount]);
    const providerRefund = vi
      .fn()
      .mockResolvedValue({ id: 'provider_refund_1', status: 'pending' });
    const authority = { authorize: vi.fn().mockResolvedValue({ id: 'admin_1' }) };
    const deps = {
      config: { clock: { now: () => new Date('2026-10-28T12:00:00.000Z') } },
      repositories: {
        financialJournals: {},
        orders: { getById: vi.fn().mockResolvedValue(orderToRefund), save: vi.fn() },
        entitlements: {
          getByOrderId: vi.fn().mockResolvedValue([{ id: 'ent_1', tierId: 'tier_1' }]),
        },
        eventCoverAccounts: {
          getByEntitlement: vi.fn().mockResolvedValue(eligibleAccount),
          freezeForRefund,
          listEntries: vi.fn().mockResolvedValue([]),
        },
        refundRequests: { getById: vi.fn().mockResolvedValue(request), save: vi.fn() },
        providerPayments: { findByPaymentId: vi.fn().mockResolvedValue(null) },
      },
      paymentProvider: { refundPayment: providerRefund },
    } as unknown as ServiceDeps;
    const service = new RefundService(deps, authority as never);

    await expect(service.executeRefund('admin_1', request.id)).rejects.toThrow(
      /awaiting authoritative completion/,
    );

    expect(freezeForRefund).toHaveBeenCalledWith(['ent_1'], request.id, expect.any(Date));
    const freezeCallOrder = freezeForRefund.mock.invocationCallOrder[0];
    const providerCallOrder = providerRefund.mock.invocationCallOrder[0];
    expect(freezeCallOrder).toBeDefined();
    expect(providerCallOrder).toBeDefined();
    if (freezeCallOrder === undefined || providerCallOrder === undefined) {
      throw new Error('Expected both freeze and provider operations to run');
    }
    expect(freezeCallOrder).toBeLessThan(providerCallOrder);
  });
});
