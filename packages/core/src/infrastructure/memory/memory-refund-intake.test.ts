import { describe, expect, it } from 'vitest';

import { issueEntitlements } from '../../domain/models/entitlement.js';
import { createOrder } from '../../domain/models/order.js';
import { createRefundRequest } from '../../domain/models/refund-request.js';

import { MemoryRefundRequestRepository } from './memory-refund-request-repository.js';
import { MemoryEntitlementRepository, MemoryOrderRepository } from './memory-repositories.js';

async function fixture() {
  const now = new Date();
  const entitlements = new MemoryEntitlementRepository();
  const refundRequests = new MemoryRefundRequestRepository();
  const orders = new MemoryOrderRepository(undefined, { entitlements, refundRequests });
  const order = {
    ...createOrder({
      id: 'ORD-local',
      eventId: 'EVT-local',
      organizationId: 'ORG-local',
      userId: 'USR-local',
      contact: { name: 'Local Guest', email: 'local@example.test', phone: '+910000000000' },
      pricing: {
        currency: 'INR',
        lines: [
          {
            tierId: 'TIER-local',
            tierName: 'General',
            quantity: 1,
            unitPricePaise: 1000,
            subtotalPaise: 1000,
          },
        ],
        subtotalPaise: 1000,
        discountPaise: 0,
        discountedSubtotalPaise: 1000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        gstPaise: 0,
        grandTotalPaise: 1000,
        appliedPromoCode: null,
      },
      now,
    }),
    status: 'paid' as const,
  };
  await orders.save(order);
  const tickets = issueEntitlements({ order, now });
  await entitlements.saveMany(tickets);
  const selected = tickets[0];
  if (!selected) throw new Error('Missing fixture ticket');
  const request = {
    ...createRefundRequest({
      id: 'REF-local',
      orderId: order.id,
      organizationId: order.organizationId,
      amountPaise: 1000,
      requestedBy: 'ADMIN-local',
      reason: 'Synthetic intake regression',
      scope: 'ticket_lines',
      ticketLines: [{ tierId: selected.tierId, quantity: 1 }],
      targetEntitlementIds: [selected.id],
      hasRedeemedEntitlement: false,
      now,
    }),
    intakeFingerprint: 'immutable-intent',
  };
  return {
    orders,
    refundRequests,
    entitlements,
    order,
    selected,
    input: {
      request,
      expectedOrderVersion: order.version,
      expectedEntitlementVersions: tickets.map(({ id, version }) => ({ id, version })),
      now,
    },
  };
}

describe('Memory atomic refund intake parity', () => {
  it('replays identical intake without second locks, and shares canonical repository state', async () => {
    const f = await fixture();
    const [first, replay] = await Promise.all([
      f.orders.beginRefundRequest(f.input),
      f.orders.beginRefundRequest(f.input),
    ]);
    expect(replay).toEqual(first);
    expect(first.order.status).toBe('refund_requested');
    expect(f.refundRequests.requests.size).toBe(1);
    expect(await f.entitlements.getById(f.selected.id)).toMatchObject({
      version: f.selected.version + 1,
      refundLock: { refundRequestId: first.request.id },
    });
    await expect(
      f.orders.beginRefundRequest({ ...f.input, request: { ...f.input.request, amountPaise: 1 } }),
    ).rejects.toThrow();
    expect(f.refundRequests.requests.size).toBe(1);
  });
  it('validates every selected state before mutating any storage map', async () => {
    const f = await fixture();
    await f.entitlements.save({
      ...f.selected,
      version: f.selected.version + 1,
      status: 'redeemed',
      scanCount: 1,
    });
    const before = await f.entitlements.getById(f.selected.id);
    await expect(f.orders.beginRefundRequest(f.input)).rejects.toThrow();
    expect(await f.orders.getById(f.order.id)).toEqual(f.order);
    expect(f.refundRequests.requests.size).toBe(0);
    expect(await f.entitlements.getById(f.selected.id)).toEqual(before);
  });
});
