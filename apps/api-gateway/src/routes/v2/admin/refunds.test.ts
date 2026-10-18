import {
  createPlatformAdmin,
  DefiniteProviderFailureError,
  MemoryPaymentProvider,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import { publishEventForTest } from '../../../test-utils/publish-event.js';
import checkoutRoutes from '../checkout/checkout-routes.js';
import paymentRoutes from '../checkout/payment-routes.js';
import partnerEventCatalogRoutes from '../partner/event-catalog.js';
import partnerEventRoutes from '../partner/events.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerVenueRoutes from '../partner/venues.js';

import adminRefundRoutes from './refunds.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin refunds over HTTP (Phase 6 admin) ─────────────────────────────────
 * Seeds a fully paid order through the real checkout/payment routes (not a
 * repository backdoor, matching `orders-routes.test.ts`'s convention), then
 * exercises the amount-tiered approval ladder end to end: zero-approver
 * auto-approval under ₹500 (approved, not automatically settled),
 * single-approver under ₹5,000, and the two guards
 * that matter most — the requester cannot approve their own request, and a
 * rejected request restores the order to `paid` rather than any hardcoded
 * status.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

function memoryProvider(): MemoryPaymentProvider {
  const provider = services.paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

/** Seeds org -> venue -> event -> tier -> hold -> paid order. Returns id + total. */
async function seedPaidOrder(
  server: FastifyInstance,
  priceInPaise = 600_000,
  quantity = 1,
): Promise<{ orderId: string; grandTotalPaise: number; tierId: string }> {
  const write = (org: string) => ({
    'x-organization-id': org,
    'idempotency-key': `catalog-${++keySeq}`,
  });

  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const org: string = created.json().id;
  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  const venueId: string = venue.json().id;
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  await publishEventForTest(eventId);
  const tier = await server.inject({
    method: 'POST',
    url: `/events/${eventId}/ticket-tiers`,
    headers: write(org),
    payload: { name: 'General', priceInPaise, quantity: 100 },
  });
  const tierId: string = tier.json().id;
  const hold = await server.inject({
    method: 'POST',
    url: '/checkout/holds',
    headers: { 'idempotency-key': `hold-${++keySeq}` },
    payload: { eventId, lines: [{ tierId, quantity }] },
  });
  const holdId: string = hold.json().holdId;
  const grandTotalPaise: number = hold.json().pricing.grandTotalPaise;
  const attempt = await server.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { 'idempotency-key': `attempt-${++keySeq}` },
    payload: { holdId },
  });
  const paymentIntentId: string = attempt.json().paymentIntentId;
  const paymentId = `pay_refund_test_${++keySeq}`;
  const provider = memoryProvider();
  provider.simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: { holdId, paymentIntentId, signature },
  });
  return { orderId: verify.json().order.id as string, grandTotalPaise, tierId };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.refundRequests as unknown as { requests: Map<string, unknown> }).requests.clear();
  (
    repos.orders as unknown as { orders: Map<string, unknown>; byPaymentId: Map<string, unknown> }
  ).orders.clear();
  (
    repos.orders as unknown as { orders: Map<string, unknown>; byPaymentId: Map<string, unknown> }
  ).byPaymentId.clear();

  server = await buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      checkoutRoutes,
      paymentRoutes,
      adminRefundRoutes,
    ],
  });
});

describe('POST /admin/refunds — amount tiers', () => {
  it('auto-approves under ₹500 (0 approvers) but does not settle', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);

    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 40_000, reason: 'Guest cancelled' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.request.status).toBe('approved');
    expect(body.request.approversRequired).toBe(0);
    // Approval alone never settles — order stays locked, nothing refunded yet.
    expect(body.order.status).toBe('refund_requested');
    expect(body.order.refundedPaise).toBe(0);
  });

  it('needs one approver from ₹500 up to ₹5,000, and stays locked until approved', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);

    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 100_000, reason: 'Partial goodwill refund' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.request.status).toBe('pending');
    expect(body.request.approversRequired).toBe(1);
    expect(body.order.status).toBe('refund_requested');
  });

  it('needs two approvers at ₹5,000 and above', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server, 1_000_000);

    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 600_000, reason: 'Event cancelled' },
    });

    expect(response.json().request.approversRequired).toBe(2);
  });

  it('refuses a role below TIER2 (support cannot request a refund)', async () => {
    await seedAdmin('admin_support', 'support');
    const { orderId } = await seedPaidOrder(server);

    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_support'),
      payload: { orderId, amountPaise: 40_000, reason: 'Try anyway' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a refund larger than the order total', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, grandTotalPaise } = await seedPaidOrder(server);

    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: grandTotalPaise + 1, reason: 'Too much' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('approving and rejecting a pending refund', () => {
  it('reaches approved once a distinct second admin approves, but does not settle', async () => {
    await seedAdmin('admin_a', 'finance');
    await seedAdmin('admin_b', 'ops');
    const { orderId, grandTotalPaise } = await seedPaidOrder(server, 150_000);

    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: grandTotalPaise, reason: 'Full refund' },
    });
    const refundRequestId = requested.json().request.id as string;

    const approved = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${refundRequestId}/approve`,
      headers: asUser('admin_b'),
    });

    expect(approved.statusCode).toBe(200);
    const body = approved.json();
    expect(body.request.status).toBe('approved');
    // Approval alone never settles — order stays locked, nothing refunded yet.
    expect(body.order.status).toBe('refund_requested');
    expect(body.order.refundedPaise).toBe(0);
  });

  it('refuses the requester approving their own request', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);

    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 100_000, reason: 'Partial refund' },
    });
    const refundRequestId = requested.json().request.id as string;

    const selfApprove = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${refundRequestId}/approve`,
      headers: asUser('admin_a'),
    });

    expect(selfApprove.statusCode).toBe(403);
  });

  it('rejecting restores the order to paid, never a hardcoded status', async () => {
    await seedAdmin('admin_a', 'finance');
    await seedAdmin('admin_b', 'ops');
    const { orderId } = await seedPaidOrder(server);

    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 100_000, reason: 'Disputed' },
    });
    const refundRequestId = requested.json().request.id as string;
    expect(requested.json().order.status).toBe('refund_requested');

    const rejected = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${refundRequestId}/reject`,
      headers: asUser('admin_b'),
      payload: { reason: 'Order already fulfilled correctly' },
    });

    expect(rejected.statusCode).toBe(200);
    const body = rejected.json();
    expect(body.request.status).toBe('rejected');
    expect(body.order.status).toBe('paid');
    expect(body.order.refundedPaise).toBe(0);
  });
});

describe('executing an approved refund', () => {
  it('settles a partial provider refund exactly once and posts balanced reversal journals', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 40_000, reason: 'Partial guest refund' },
    });
    const requestId = requested.json().request.id as string;

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      request: {
        status: 'settled',
        providerStatus: 'processed',
        executionAttempts: 1,
      },
      order: { status: 'paid', refundedPaise: 40_000 },
    });

    const journals = await services.repos().financialJournals.findBySource('refund', requestId);
    expect(journals).toHaveLength(3);
    for (const journal of journals) {
      const debit = journal.lines
        .filter((line) => line.side === 'debit')
        .reduce((sum, line) => sum + line.amountPaise, 0);
      const credit = journal.lines
        .filter((line) => line.side === 'credit')
        .reduce((sum, line) => sum + line.amountPaise, 0);
      expect(debit).toBe(credit);
    }

    const retry = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_a'),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().request.providerRefundId).toBe(executed.json().request.providerRefundId);
    expect(await services.repos().financialJournals.findBySource('refund', requestId)).toHaveLength(
      3,
    );
  });

  it('preserves every ticket for an amount-only partial adjustment', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server, 100_000, 2);
    const before = await services.repos().entitlements.getByOrderId(orderId);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 40_000, reason: 'Price adjustment' },
    });
    expect(requested.json().request).toMatchObject({
      scope: 'amount_only',
      ticketLines: [],
      targetEntitlementIds: [],
    });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requested.json().request.id as string}/execute`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(200);
    expect(await services.repos().entitlements.getByOrderId(orderId)).toEqual(before);
  });

  it('deterministically revokes only the selected ticket quantity and cannot revoke twice', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedPaidOrder(server, 100_000, 3);
    const before = (await services.repos().entitlements.getByOrderId(orderId)).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'One attendee cancelled',
        ticketLines: [{ tierId, quantity: 1 }],
      },
    });
    const requestId = requested.json().request.id as string;
    expect(requested.json().request).toMatchObject({
      scope: 'ticket_lines',
      targetEntitlementIds: [before[0]?.id],
    });
    const frozen = (await services.repos().entitlements.getByOrderId(orderId)).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    expect(frozen[0]?.refundLock?.refundRequestId).toBe(requestId);
    expect(frozen.slice(1).every((entitlement) => !entitlement.refundLock)).toBe(true);

    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/admin/refunds/${requestId}/execute`,
          headers: asUser('admin_a'),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: `/admin/refunds/${requestId}/execute`,
          headers: asUser('admin_a'),
        })
      ).statusCode,
    ).toBe(200);

    const after = (await services.repos().entitlements.getByOrderId(orderId)).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    expect(after.map((entitlement) => entitlement.status)).toEqual(['void', 'valid', 'valid']);
    expect(after[0]?.version).toBe((before[0]?.version ?? 0) + 2);
  });

  it('releases the exact frozen ticket set after a definite provider failure', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedPaidOrder(server, 100_000, 2);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'Provider rejection test',
        ticketLines: [{ tierId, quantity: 1 }],
      },
    });
    const requestId = requested.json().request.id as string;
    const provider = memoryProvider();
    const originalRefund = provider.refundPayment.bind(provider);
    provider.refundPayment = async (input) => ({
      id: `rfnd_failed_${input.idempotencyKey}`,
      status: 'failed',
      amountPaise: input.amountPaise ?? 0,
    });

    try {
      const response = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/execute`,
        headers: asUser('admin_a'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        request: { status: 'failed' },
        order: { status: 'paid', refundedPaise: 0 },
      });
      const tickets = await services.repos().entitlements.getByOrderId(orderId);
      expect(tickets.every((entitlement) => entitlement.status === 'valid')).toBe(true);
      expect(tickets.every((entitlement) => !entitlement.refundLock)).toBe(true);
    } finally {
      provider.refundPayment = originalRefund;
    }
  });

  it('releases the frozen ticket when Razorpay authoritatively rejects the request', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedPaidOrder(server, 100_000, 2);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'HTTP rejection test',
        ticketLines: [{ tierId, quantity: 1 }],
      },
    });
    const requestId = requested.json().request.id as string;
    const provider = memoryProvider();
    const originalRefund = provider.refundPayment.bind(provider);
    provider.refundPayment = async () => {
      throw new DefiniteProviderFailureError();
    };

    try {
      const response = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/execute`,
        headers: asUser('admin_a'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        request: { status: 'failed' },
        order: { status: 'paid', refundedPaise: 0 },
      });
      const tickets = await services.repos().entitlements.getByOrderId(orderId);
      expect(tickets.every((entitlement) => !entitlement.refundLock)).toBe(true);
      expect(tickets.every((entitlement) => entitlement.status === 'valid')).toBe(true);
    } finally {
      provider.refundPayment = originalRefund;
    }
  });

  it('voids the ticket only when a full refund is authoritatively processed', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, grandTotalPaise } = await seedPaidOrder(server, 10_000);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: grandTotalPaise, reason: 'Full cancellation' },
    });
    const requestId = requested.json().request.id as string;

    const before = await services.repos().entitlements.getByOrderId(orderId);
    expect(before.every((entitlement) => entitlement.status === 'valid')).toBe(true);
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().order).toMatchObject({
      status: 'refunded',
      refundedPaise: grandTotalPaise,
    });
    const after = await services.repos().entitlements.getByOrderId(orderId);
    expect(after.every((entitlement) => entitlement.status === 'void')).toBe(true);
  });

  it('keeps the order and selected ticket locked when the provider result is ambiguous', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedPaidOrder(server);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'Ambiguous provider test',
        ticketLines: [{ tierId, quantity: 1 }],
      },
    });
    const requestId = requested.json().request.id as string;
    const provider = memoryProvider();
    const originalRefund = provider.refundPayment.bind(provider);
    provider.refundPayment = async () => {
      throw new Error('timeout after request write');
    };

    try {
      const response = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/execute`,
        headers: asUser('admin_a'),
      });
      expect(response.statusCode).toBe(409);
      expect((await services.repos().orders.getById(orderId))?.status).toBe('refund_requested');
      expect((await services.repos().refundRequests.getById(requestId))?.status).toBe('executing');
      expect(
        (await services.repos().entitlements.getByOrderId(orderId))[0]?.refundLock?.refundRequestId,
      ).toBe(requestId);
    } finally {
      provider.refundPayment = originalRefund;
    }
  });

  it('does not reapply an order refund after a crash before request settlement', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 40_000, reason: 'Retry fence test' },
    });
    const requestId = requested.json().request.id as string;
    const repository = services.repos().refundRequests;
    const originalSave = repository.save.bind(repository);
    let failSettlementOnce = true;
    repository.save = async (request) => {
      if (request.status === 'settled' && failSettlementOnce) {
        failSettlementOnce = false;
        throw new Error('simulated crash before request settlement');
      }
      return originalSave(request);
    };

    const first = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_a'),
    });
    expect(first.statusCode).toBe(500);
    repository.save = originalSave;

    const retry = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_a'),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().order.refundedPaise).toBe(40_000);
    expect(retry.json().order.status).toBe('paid');
    expect((await services.repos().orders.getById(orderId))?.appliedRefundRequestIds).toEqual([
      requestId,
    ]);
  });
});

describe('reads', () => {
  it('lists refund requests, optionally filtered by status', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);
    await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 100_000, reason: 'One' },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/refunds?status=pending',
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].status).toBe('pending');
  });

  it('fetches a single refund request by id', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedPaidOrder(server);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: { orderId, amountPaise: 40_000, reason: 'Auto' },
    });
    const refundRequestId = requested.json().request.id as string;

    const response = await server.inject({
      method: 'GET',
      url: `/admin/refunds/${refundRequestId}`,
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(refundRequestId);
  });

  it('unknown refund request id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'finance');
    const response = await server.inject({
      method: 'GET',
      url: '/admin/refunds/rfd_does_not_exist',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(404);
  });
});
