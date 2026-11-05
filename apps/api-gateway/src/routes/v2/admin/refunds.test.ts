import {
  createPlatformAdmin,
  cancelEvent,
  beginRefundExecution,
  recordRefundProviderFact,
  DefiniteProviderFailureError,
  MemoryPaymentProvider,
  IdempotencyFailedError,
  IdempotencyInFlightError,
} from '@c1rcle/core/domain';
import { MemoryUserAccountRepository } from '@c1rcle/core/infrastructure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { RazorpayPaymentProvider } from '../../../lib/payments/razorpay-adapter.js';
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
  legacyAmountPolicy = false,
  cancelBeforeVerify = false,
): Promise<{ orderId: string; grandTotalPaise: number; tierId: string }> {
  const users = services.repos().users;
  if (!(users instanceof MemoryUserAccountRepository))
    throw new Error('Expected memory account directory in refund test');
  users.save({
    id: 'user_1',
    email: 'guest-refund@example.test',
    name: 'Refund test guest',
    image: null,
    emailVerified: true,
    role: 'guest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
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
  expect(hold.statusCode, hold.body).toBe(201);
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
  if (cancelBeforeVerify) {
    const capturedEvent = await services.repos().events.getById(eventId);
    if (!capturedEvent) throw new Error('Synthetic capture event missing');
    await services
      .repos()
      .events.save(cancelEvent(capturedEvent, 'Synthetic event cancellation during capture'));
  }
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: { holdId, paymentIntentId, signature },
  });
  expect(verify.statusCode, verify.body).toBe(200);
  const orderId = verify.json().order.id as string;
  if (legacyAmountPolicy) {
    const stored = await services.repos().orders.getById(orderId);
    if (!stored) throw new Error('Paid legacy fixture order missing');
    const { refundSnapshot: _snapshot, ...legacy } = stored;
    await services.repos().orders.save({ ...legacy, version: stored.version + 1 });
  }
  return { orderId, grandTotalPaise, tierId };
}

/** Historical M2 amount-only policy is explicit; M4 tests use the original-purchase snapshot. */
function seedLegacyPaidOrder(server: FastifyInstance, priceInPaise = 600_000, quantity = 1) {
  return seedPaidOrder(server, priceInPaise, quantity, true);
}

let server: FastifyInstance;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  it('lists a canonical captured-purchase compensation request without violating actor identity contracts', async () => {
    await seedAdmin('comp_admin', 'finance');
    const { orderId, grandTotalPaise } = await seedPaidOrder(server, 100_000, 1, false, true);
    const requests = await services.repos().refundRequests.listByOrder(orderId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      refundCause: 'fulfillment_failure',
      amountPaise: grandTotalPaise,
      status: 'pending',
      approversRequired: 1,
      executionAttempts: 0,
      providerRefundId: null,
    });
    expect(await services.repos().entitlements.getByOrderId(orderId)).toEqual([]);
    const response = await server.inject({
      method: 'GET',
      url: '/admin/refunds?status=pending&limit=100',
      headers: asUser('comp_admin'),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: requests[0]?.id,
          requestedBy: 'system_checkout_compensation',
          refundCause: 'fulfillment_failure',
        }),
      ]),
    );
  });

  it('auto-approves under ₹500 (0 approvers) but does not settle', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedLegacyPaidOrder(server);

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
    const { orderId } = await seedLegacyPaidOrder(server);

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
    const { orderId } = await seedLegacyPaidOrder(server, 1_000_000);

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
    const { orderId } = await seedLegacyPaidOrder(server);

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
    const { orderId, grandTotalPaise } = await seedLegacyPaidOrder(server);

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
    const { orderId, grandTotalPaise } = await seedLegacyPaidOrder(server, 150_000);

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
    const { orderId } = await seedLegacyPaidOrder(server);

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
    const { orderId } = await seedLegacyPaidOrder(server);

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
    const { orderId } = await seedLegacyPaidOrder(server);
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
    const { orderId } = await seedLegacyPaidOrder(server, 100_000, 2);
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

  it('revokes only the explicitly selected non-first attendee and cannot revoke twice', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedLegacyPaidOrder(server, 100_000, 3);
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
        targetEntitlementIds: [before[1]?.id],
      },
    });
    const requestId = requested.json().request.id as string;
    expect(requested.json().request).toMatchObject({
      scope: 'ticket_lines',
      targetEntitlementIds: [before[1]?.id],
    });
    const frozen = (await services.repos().entitlements.getByOrderId(orderId)).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    expect(frozen[1]?.refundLock?.refundRequestId).toBe(requestId);
    expect(
      frozen
        .filter((entitlement) => entitlement.id !== before[1]?.id)
        .every((entitlement) => !entitlement.refundLock),
    ).toBe(true);

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
    expect(after.map((entitlement) => entitlement.status)).toEqual(['valid', 'void', 'valid']);
    expect(after[1]?.version).toBe((before[1]?.version ?? 0) + 2);
  });

  it('does not revoke unselected attendees by refunding the full order balance for one ticket', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, grandTotalPaise } = await seedLegacyPaidOrder(server, 100_000, 2);
    const tickets = await services.repos().entitlements.getByOrderId(orderId);
    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: grandTotalPaise,
        reason: 'Specific attendee request',
        targetEntitlementIds: [tickets[1]?.id],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('selecting every active ticket');
    expect(await services.repos().orders.getById(orderId)).toMatchObject({
      status: 'paid',
      refundedPaise: 0,
    });
    expect(
      (await services.repos().entitlements.getByOrderId(orderId)).every(
        (ticket) => ticket.status === 'valid' && !ticket.refundLock,
      ),
    ).toBe(true);
  });

  it('releases the exact frozen ticket set after a definite provider failure', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId, tierId } = await seedLegacyPaidOrder(server, 100_000, 2);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'Provider rejection test',
        ticketLines: [{ tierId, quantity: 1 }],
        targetEntitlementIds: [(await services.repos().entitlements.getByOrderId(orderId))[0]?.id],
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
    const { orderId, tierId } = await seedLegacyPaidOrder(server, 100_000, 2);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'HTTP rejection test',
        ticketLines: [{ tierId, quantity: 1 }],
        targetEntitlementIds: [(await services.repos().entitlements.getByOrderId(orderId))[0]?.id],
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
    const { orderId, grandTotalPaise } = await seedLegacyPaidOrder(server, 10_000);
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
    const { orderId, tierId } = await seedLegacyPaidOrder(server);
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_a'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'Ambiguous provider test',
        ticketLines: [{ tierId, quantity: 1 }],
        targetEntitlementIds: [(await services.repos().entitlements.getByOrderId(orderId))[0]?.id],
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

  it.each([400, 500, 409, 429])(
    'applies the correct refund lock decision after adapter HTTP %i',
    async (status) => {
      await seedAdmin('admin_a', 'finance');
      const { orderId, tierId } = await seedLegacyPaidOrder(server, 100_000, 2);
      const requested = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('admin_a'),
        payload: {
          orderId,
          amountPaise: 40_000,
          reason: 'Classification regression',
          ticketLines: [{ tierId, quantity: 1 }],
          targetEntitlementIds: [
            (await services.repos().entitlements.getByOrderId(orderId))[0]?.id,
          ],
        },
      });
      expect(requested.statusCode).toBe(201);
      const requestId = requested.json().request.id as string;
      const provider = memoryProvider();
      const originalRefund = provider.refundPayment.bind(provider);
      const adapter = new RazorpayPaymentProvider({
        keyId: 'rzp_test_synthetic',
        keySecret: 'synthetic',
        webhookSecret: 'synthetic',
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { code: 'BAD_REQUEST_ERROR', description: 'Synthetic provider failure' } },
            { status },
          ),
        );
      vi.stubGlobal('fetch', fetchMock);
      provider.refundPayment = adapter.refundPayment.bind(adapter);
      try {
        const response = await server.inject({
          method: 'POST',
          url: `/admin/refunds/${requestId}/execute`,
          headers: asUser('admin_a'),
        });
        if (status === 400) {
          expect(response.statusCode).toBe(200);
          expect(await services.repos().orders.getById(orderId)).toMatchObject({
            status: 'paid',
            refundedPaise: 0,
          });
          expect(await services.repos().refundRequests.getById(requestId)).toMatchObject({
            status: 'failed',
            providerRefundId: null,
          });
          const tickets = await services.repos().entitlements.getByOrderId(orderId);
          expect(tickets.every((ticket) => !ticket.refundLock && ticket.status === 'valid')).toBe(
            true,
          );
          expect(fetchMock).toHaveBeenCalledTimes(1);
          return;
        }
        expect(response.statusCode).toBe(409);
        expect(await services.repos().orders.getById(orderId)).toMatchObject({
          status: 'refund_requested',
          refundedPaise: 0,
        });
        expect(await services.repos().refundRequests.getById(requestId)).toMatchObject({
          status: 'executing',
          providerRefundId: null,
        });
        const tickets = await services.repos().entitlements.getByOrderId(orderId);
        expect(
          tickets.filter((ticket) => ticket.refundLock?.refundRequestId === requestId),
        ).toHaveLength(1);
        const retry = await server.inject({
          method: 'POST',
          url: `/admin/refunds/${requestId}/execute`,
          headers: asUser('admin_a'),
        });
        expect(retry.statusCode).toBe(409);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        provider.refundPayment = originalRefund;
        vi.unstubAllGlobals();
      }
    },
  );

  it('does not reapply an order refund after a crash before request settlement', async () => {
    await seedAdmin('admin_a', 'finance');
    const { orderId } = await seedLegacyPaidOrder(server);
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
    const { orderId } = await seedLegacyPaidOrder(server);
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
    const { orderId } = await seedLegacyPaidOrder(server);
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

describe('uncertain refund recovery', () => {
  async function uncertain() {
    await seedAdmin('admin_recovery', 'finance');
    const { orderId, tierId } = await seedLegacyPaidOrder(server, 100_000, 2);
    const created = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('admin_recovery'),
      payload: {
        orderId,
        amountPaise: 40_000,
        reason: 'Synthetic recovery test',
        ticketLines: [{ tierId, quantity: 1 }],
        targetEntitlementIds: [(await services.repos().entitlements.getByOrderId(orderId))[0]?.id],
      },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().request.id as string;
    const provider = memoryProvider();
    const refundPost = vi
      .spyOn(provider, 'refundPayment')
      .mockRejectedValue(new Error('lost provider response'));
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('admin_recovery'),
    });
    expect(executed.statusCode).toBe(409);
    const saved = await services.repos().refundRequests.getById(requestId);
    const order = await services.repos().orders.getById(orderId);
    if (!saved || !order?.paymentId) throw new Error('Expected uncertain execution');
    const candidate = `rfnd_recovered_${++keySeq}`;
    const fact = {
      id: candidate,
      payment_id: order.paymentId,
      currency: order.currency,
      amount: saved.amountPaise,
      receipt: saved.executionIdempotencyKey,
      status: 'processed',
    };
    const adapter = new RazorpayPaymentProvider({
      keyId: 'rzp_test_synthetic',
      keySecret: 'synthetic',
      webhookSecret: 'synthetic',
    });
    const lookup = vi
      .spyOn(provider, 'getRefund')
      .mockImplementation(adapter.getRefund.bind(adapter));
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(fact)));
    vi.stubGlobal('fetch', fetchMock);
    const reconcile = (
      payload: Record<string, unknown> = {
        providerRefundId: candidate,
        reason: 'Provider record found during approved review',
      },
      headers = asUser('admin_recovery'),
    ) =>
      server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/reconcile`,
        headers,
        payload,
      });
    return { requestId, orderId, candidate, fact, fetchMock, lookup, refundPost, reconcile, saved };
  }

  it.each(['processed', 'failed', 'pending'])(
    'recovers missing refund id with provider state %s, then safely converges',
    async (status) => {
      const f = await uncertain();
      f.fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ...f.fact, status })));
      const headers = asUser('admin_recovery');
      const response = await f.reconcile(undefined, headers);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        request: { status: 'executing', providerRefundId: f.candidate, providerStatus: status },
        order: { status: 'refund_requested', refundedPaise: 0 },
      });
      const audits = await services.adminAudits().listForTarget(f.requestId, 100);
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'FINANCIAL_REFUND.reconcile.requested',
            adminId: 'admin_recovery',
          }),
          expect.objectContaining({
            action: 'FINANCIAL_REFUND.reconcile.observed',
            after: expect.objectContaining({
              providerRefundId: f.candidate,
              providerStatus: status,
            }),
          }),
        ]),
      );
      const replay = await f.reconcile(undefined, headers);
      expect(replay.statusCode).toBe(200);
      expect(f.lookup).toHaveBeenCalledTimes(1);
      const version = (await services.repos().refundRequests.getById(f.requestId))?.version;
      expect((await f.reconcile()).statusCode).toBe(200);
      expect((await services.repos().refundRequests.getById(f.requestId))?.version).toBe(version);
      const execute = () =>
        server.inject({
          method: 'POST',
          url: `/admin/refunds/${f.requestId}/execute`,
          headers: asUser('admin_recovery'),
        });
      const completed = await execute();
      const tickets = await services.repos().entitlements.getByOrderId(f.orderId);
      if (status === 'pending') {
        expect(completed.statusCode).toBe(409);
        expect(
          tickets.filter((ticket) => ticket.refundLock?.refundRequestId === f.requestId),
        ).toHaveLength(1);
        f.fetchMock.mockImplementation(() => Promise.resolve(Response.json(f.fact)));
        expect((await f.reconcile()).statusCode).toBe(200);
        const settled = await execute();
        expect(settled.statusCode).toBe(200);
        expect(settled.json().request.status).toBe('settled');
        expect(settled.json().order.refundedPaise).toBe(40_000);
      } else {
        expect(completed.statusCode).toBe(200);
        expect(completed.json().request.status).toBe(status === 'processed' ? 'settled' : 'failed');
        expect(completed.json().order.refundedPaise).toBe(status === 'processed' ? 40_000 : 0);
        expect(tickets.every((ticket) => !ticket.refundLock)).toBe(true);
        if (status === 'processed') {
          expect(tickets.filter((ticket) => ticket.status === 'void')).toHaveLength(1);
          expect((await execute()).json().order.refundedPaise).toBe(40_000);
        }
      }
      expect(f.refundPost).toHaveBeenCalledTimes(1); // only the original ambiguous call
    },
  );

  it.each([
    { payment_id: 'pay_wrong' },
    { amount: 1 },
    { currency: 'USD' },
    { receipt: 'another-request' },
    { receipt: null },
  ])('rejects mismatched provider evidence without releasing locks: %j', async (patch) => {
    const f = await uncertain();
    f.fetchMock.mockResolvedValue(Response.json({ ...f.fact, ...patch }));
    const response = await f.reconcile();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(f.saved);
    expect((await services.repos().orders.getById(f.orderId))?.status).toBe('refund_requested');
    expect(
      (await services.repos().entitlements.getByOrderId(f.orderId)).some(
        (ticket) => ticket.refundLock?.refundRequestId === f.requestId,
      ),
    ).toBe(true);
    expect(f.refundPost).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500])(
    'keeps no-id uncertainty locked when provider lookup returns %i',
    async (status) => {
      const f = await uncertain();
      f.fetchMock.mockResolvedValue(new Response(null, { status }));
      expect((await f.reconcile()).statusCode).toBeGreaterThanOrEqual(400);
      expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(f.saved);
      expect(f.refundPost).toHaveBeenCalledTimes(1);
    },
  );

  it('denies non-finance identities before lookup and rejects operator-supplied status/amount', async () => {
    const f = await uncertain();
    await seedAdmin('admin_support_recovery', 'support');
    expect((await f.reconcile(undefined, asUser('not_an_admin'))).statusCode).toBe(401);
    expect((await f.reconcile(undefined, asUser('admin_support_recovery'))).statusCode).toBe(403);
    expect(
      (
        await f.reconcile({
          providerRefundId: f.candidate,
          reason: 'Synthetic review',
          status: 'processed',
          amountPaise: 40_000,
        })
      ).statusCode,
    ).toBe(422);
    expect((await f.reconcile({ providerRefundId: f.candidate, reason: ' ' })).statusCode).toBe(
      422,
    );
    expect(f.lookup).not.toHaveBeenCalled();
  });

  it('fails closed before provider lookup if the audit store is unavailable', async () => {
    const f = await uncertain();
    vi.spyOn(services.adminAudits(), 'append').mockRejectedValue(
      new Error('synthetic audit outage'),
    );
    expect((await f.reconcile()).statusCode).toBe(500);
    expect(f.lookup).not.toHaveBeenCalled();
    expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(f.saved);
  });

  it('retains uncertainty when observation auditing fails after a successful lookup', async () => {
    const f = await uncertain();
    const audit = services.adminAudits();
    const append = audit.append.bind(audit);
    vi.spyOn(audit, 'append')
      .mockImplementationOnce(append)
      .mockRejectedValue(new Error('synthetic audit outage'));
    expect((await f.reconcile()).statusCode).toBe(500);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(f.saved);
  });

  it('rejects contradictory processed webhook evidence instead of unlocking', async () => {
    const f = await uncertain();
    await services.providerPayments.recordEvent({
      type: 'refund_processed',
      paymentId: f.fact.payment_id,
      refundId: f.candidate,
      amountPaise: f.fact.amount,
      currency: f.fact.currency,
    });
    f.fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ ...f.fact, status: 'failed' })),
    );
    expect((await f.reconcile()).statusCode).toBe(409);
    expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(f.saved);
  });

  it('refuses a replacement id or downgrade of an already recorded terminal fact', async () => {
    const f = await uncertain();
    expect((await f.reconcile()).statusCode).toBe(200);
    const saved = await services.repos().refundRequests.getById(f.requestId);
    expect(
      (await f.reconcile({ providerRefundId: 'rfnd_other', reason: 'Wrong candidate' })).statusCode,
    ).toBe(409);
    expect(f.lookup).toHaveBeenCalledTimes(1);
    f.fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ ...f.fact, status: 'pending' })),
    );
    expect((await f.reconcile()).statusCode).toBe(409);
    expect(await services.repos().refundRequests.getById(f.requestId)).toEqual(saved);
  });

  it('keeps a recovered failed refund locked if a processed webhook arrives before finalization', async () => {
    const f = await uncertain();
    f.fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ ...f.fact, status: 'failed' })),
    );
    expect((await f.reconcile()).statusCode).toBe(200);
    await services.providerPayments.recordEvent({
      type: 'refund_processed',
      paymentId: f.fact.payment_id,
      refundId: f.candidate,
      amountPaise: f.fact.amount,
      currency: f.fact.currency,
    });
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${f.requestId}/execute`,
      headers: asUser('admin_recovery'),
    });
    expect(executed.statusCode).toBe(409);
    expect((await services.repos().orders.getById(f.orderId))?.status).toBe('refund_requested');
    expect((await services.repos().refundRequests.getById(f.requestId))?.status).toBe('executing');
    expect(f.refundPost).toHaveBeenCalledTimes(1);
  });

  it('recovers after a fact persistence failure without resending money', async () => {
    const f = await uncertain();
    const repo = services.repos().refundRequests;
    const save = vi
      .spyOn(repo, 'save')
      .mockRejectedValueOnce(new Error('synthetic persistence outage'));
    expect((await f.reconcile()).statusCode).toBe(500);
    expect(await repo.getById(f.requestId)).toEqual(f.saved);
    save.mockRestore();
    expect((await f.reconcile()).statusCode).toBe(200);
    expect(f.refundPost).toHaveBeenCalledTimes(1);
  });
});

describe('M4 immutable original-purchase refund policy', () => {
  it('derives a normal exact-attendee refund without accepting arbitrary amounts or refundable fees', async () => {
    await seedAdmin('m4_admin', 'finance');
    const { orderId } = await seedPaidOrder(server, 100_000, 2);
    const order = await services.repos().orders.getById(orderId);
    const tickets = await services.repos().entitlements.getByOrderId(orderId);
    const target = tickets[1];
    const original = order?.refundSnapshot?.tickets.find(
      (ticket) => ticket.entitlementId === target?.id,
    );
    if (!order || !target || !original) throw new Error('Original M4 purchase fixture missing');
    const bad = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: {
        orderId,
        reason: 'Normal refund',
        targetEntitlementIds: [target.id],
        amountPaise: original.admissionPaise + 1,
      },
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect((await services.repos().orders.getById(orderId))?.status).toBe('paid');
    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: { orderId, reason: 'Normal refund', targetEntitlementIds: [target.id] },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().request).toMatchObject({
      amountPaise: original.admissionPaise,
      refundCause: 'guest_request',
      purchasePolicyVersion: order.refundSnapshot?.policyVersion,
      refundComponents: {
        admissionPaise: original.admissionPaise,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        feeTaxPaise: 0,
        otherPaidPaise: 0,
      },
      targetEntitlementIds: [target.id],
    });
    expect(
      (await services.repos().entitlements.getById(target.id))?.refundLock?.refundRequestId,
    ).toBe(response.json().request.id);
    const unaffected = tickets[0];
    if (!unaffected) throw new Error('Unaffected attendee missing');
    expect((await services.repos().entitlements.getById(unaffected.id))?.refundLock).toBeNull();
  });

  it('settles multiple selected original admissions after a catalog price change, retaining disclosed fees and the unaffected ticket', async () => {
    await seedAdmin('m4_admin', 'finance');
    await seedAdmin('m4_approver', 'finance');
    const { orderId, tierId } = await seedPaidOrder(server, 100_000, 3);
    const order = await services.repos().orders.getById(orderId);
    const tickets = await services.repos().entitlements.getByOrderId(orderId);
    const first = tickets[0],
      unaffected = tickets[1],
      last = tickets[2];
    const tier = await services.repos().catalog.getTierById(tierId);
    if (!order || !first || !unaffected || !last || !tier)
      throw new Error('Three-ticket M4 purchase missing');
    await services
      .repos()
      .catalog.updateTier({ ...tier, priceInPaise: 999_000, version: tier.version + 1 });
    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: {
        orderId,
        reason: 'Two attendees return admission',
        targetEntitlementIds: [last.id, first.id],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().request).toMatchObject({
      amountPaise: 200_000,
      refundCause: 'guest_request',
      ticketLines: [{ tierId, quantity: 2 }],
      refundComponents: {
        admissionPaise: 200_000,
        platformFeePaise: 0,
        paymentFeePaise: 0,
        feeTaxPaise: 0,
        otherPaidPaise: 0,
      },
    });
    const requestId = response.json().request.id as string;
    const approval = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/approve`,
      headers: asUser('m4_approver'),
    });
    expect(approval.statusCode, approval.body).toBe(200);
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(executed.statusCode, executed.body).toBe(200);
    expect(executed.json()).toMatchObject({
      request: { status: 'settled' },
      order: { status: 'paid', refundedPaise: 200_000 },
    });
    for (const id of [first.id, last.id])
      expect((await services.repos().entitlements.getById(id))?.status).toBe('void');
    expect(await services.repos().entitlements.getById(unaffected.id)).toMatchObject({
      status: 'valid',
      refundLock: null,
    });
    const refundJournals = (await services.repos().financialJournals.findByOrderId(orderId)).filter(
      (journal) => journal.source.type === 'refund',
    );
    const recognition = refundJournals.find((journal) =>
      journal.idempotencyKey.endsWith(':recognition'),
    );
    expect(
      recognition?.lines
        .filter(
          (line) =>
            line.side === 'debit' &&
            ['platform_fee_revenue', 'gst_tax_liability'].includes(line.account),
        )
        .reduce((sum, line) => sum + line.amountPaise, 0),
    ).toBe(0);
    expect((await services.repos().orders.getById(orderId))?.lines).toEqual(order.lines);
    expect(
      (await services.repos().providerPayments.findByPaymentId(order.paymentId ?? ''))?.refunds,
    ).toEqual({ [executed.json().request.providerRefundId as string]: 200_000 });
    const cancelled = await server.inject({
      method: 'POST',
      url: `/events/${order.eventId}/cancel`,
      headers: { ...asUser('user_1'), 'x-organization-id': order.organizationId },
      payload: { reason: 'Cancellation after admission-only partial refund' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const cancellationRequests = (
      await services.repos().refundRequests.listByOrder(orderId)
    ).filter((request) => request.id !== requestId);
    expect(cancellationRequests).toHaveLength(1);
    expect(cancellationRequests[0]).toMatchObject({
      refundCause: 'organizer_cancel',
      amountPaise: order.grandTotalPaise - 200_000,
      targetEntitlementIds: [unaffected.id],
      scope: 'ticket_lines',
      refundComponents: {
        admissionPaise: 100_000,
        platformFeePaise: order.platformFeePaise,
        paymentFeePaise: order.paymentFeePaise,
        feeTaxPaise: order.gstPaise,
        otherPaidPaise: 0,
      },
    });
    const cancellationId = cancellationRequests[0]?.id;
    if (!cancellationId) throw new Error('Cancellation refund missing');
    const cancellationApproval = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${cancellationId}/approve`,
      headers: asUser('m4_approver'),
    });
    expect(cancellationApproval.statusCode, cancellationApproval.body).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const completion = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${cancellationId}/execute`,
        headers: asUser('m4_approver'),
      });
      expect(completion.statusCode, completion.body).toBe(200);
    }
    const finalOrder = await services.repos().orders.getById(orderId);
    expect(finalOrder).toMatchObject({ status: 'refunded', refundedPaise: order.grandTotalPaise });
    expect(finalOrder?.refundedTicketClaims).toHaveLength(3);
    expect(
      finalOrder?.refundedTicketClaims?.filter((claim) => claim.refundRequestId === cancellationId),
    ).toHaveLength(1);
  });

  it.each(['organizer_cancel', 'material_change'] as const)(
    'rejects a forged %s cause before locking the order',
    async (refundCause) => {
      await seedAdmin('m4_admin', 'finance');
      const { orderId } = await seedPaidOrder(server, 100_000);
      const response = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('m4_admin'),
        payload: { orderId, reason: 'Forged cause', refundCause },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect((await services.repos().orders.getById(orderId))?.status).toBe('paid');
    },
  );

  it('uses authoritative cancellation and the full affected original paid components, defaulting to all active tickets', async () => {
    await seedAdmin('m4_admin', 'finance');
    const { orderId, grandTotalPaise } = await seedPaidOrder(server, 100_000, 2);
    const order = await services.repos().orders.getById(orderId);
    if (!order) throw new Error('M4 purchase missing');
    const event = await services.repos().events.getById(order.eventId);
    if (!event) throw new Error('M4 event missing');
    await services
      .repos()
      .events.save({ ...event, status: 'cancelled', version: event.version + 1 });
    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: { orderId, reason: 'Organizer cancellation' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().request).toMatchObject({
      amountPaise: grandTotalPaise,
      refundCause: 'organizer_cancel',
      scope: 'ticket_lines',
    });
    expect(response.json().request.targetEntitlementIds).toHaveLength(2);
    expect(response.json().request.refundComponents).toMatchObject({
      admissionPaise: order.discountedAdmissionSubtotalPaise,
      platformFeePaise: order.platformFeePaise,
      paymentFeePaise: order.paymentFeePaise,
      feeTaxPaise: order.gstPaise,
    });
  });

  it.each([true, false])(
    'applies qualifying material-change refunds with explicit cause: %s',
    async (explicitCause) => {
      await seedAdmin('m4_admin', 'finance');
      const { orderId } = await seedPaidOrder(server, 100_000, 2);
      const order = await services.repos().orders.getById(orderId);
      const ticket = (await services.repos().entitlements.getByOrderId(orderId))[1];
      if (!order || !ticket) throw new Error('M4 purchase fixture missing');
      const event = await services.repos().events.getById(order.eventId);
      if (!event) throw new Error('M4 event missing');
      await services.repos().events.save({
        ...event,
        lastMaterialChangeAt: order.createdAt,
        version: event.version + 1,
      });
      const original = order.refundSnapshot?.tickets.find(
        (unit) => unit.entitlementId === ticket.id,
      );
      const response = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('m4_admin'),
        payload: {
          orderId,
          targetEntitlementIds: [ticket.id],
          reason: 'Qualifying material change',
          ...(explicitCause ? { refundCause: 'material_change' } : {}),
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().request.amountPaise).toBe(original?.totalPaidPaise);
      expect(response.json().request.refundCause).toBe('material_change');
    },
  );

  it.each([true, false])(
    'qualifies material change from original held booking time, affected: %s',
    async (affected) => {
      await seedAdmin('m4_admin', 'finance');
      const { orderId } = await seedPaidOrder(server, 100_000);
      const order = await services.repos().orders.getById(orderId);
      const ticket = (await services.repos().entitlements.getByOrderId(orderId))[0];
      if (!order || !ticket) throw new Error('M4 original purchase missing');
      const event = await services.repos().events.getById(order.eventId);
      if (!event) throw new Error('M4 event missing');
      // Controlled historical timestamps represent capture after an earlier hold/change.
      const capturedAt = Date.parse(order.createdAt);
      const bookedAt = new Date(capturedAt - (affected ? 10 : 2) * 60000).toISOString();
      const changedAt = new Date(capturedAt - 5 * 60000).toISOString();
      await services.repos().orders.save({ ...order, bookedAt, version: order.version + 1 });
      await services
        .repos()
        .events.save({ ...event, lastMaterialChangeAt: changedAt, version: event.version + 1 });
      const original = order.refundSnapshot?.tickets.find(
        (unit) => unit.entitlementId === ticket.id,
      );
      const response = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('m4_admin'),
        payload: { orderId, reason: 'Original booking chronology' },
      });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().request.amountPaise).toBe(
        affected ? original?.totalPaidPaise : original?.admissionPaise,
      );
      expect(response.json().request.refundCause).toBe(
        affected ? 'material_change' : 'guest_request',
      );
    },
  );

  it.each(['cancelled', 'material'] as const)(
    'requires explicit recreation when an unexecuted refund cause promotes to %s',
    async (promotion) => {
      await seedAdmin('m4_admin', 'finance');
      await seedAdmin('m4_approver', 'finance');
      const { orderId } = await seedPaidOrder(server, 100_000, 2);
      const order = await services.repos().orders.getById(orderId);
      const ticket = (await services.repos().entitlements.getByOrderId(orderId))[0];
      if (!order || !ticket) throw new Error('M4 purchase missing');
      const requested = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('m4_admin'),
        payload: { orderId, targetEntitlementIds: [ticket.id], reason: 'Original Guest request' },
      });
      expect(requested.statusCode, requested.body).toBe(201);
      const requestId = requested.json().request.id as string;
      const approval = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/approve`,
        headers: asUser('m4_approver'),
      });
      expect(approval.statusCode, approval.body).toBe(200);
      const originalRequest = await services.repos().refundRequests.getById(requestId);
      const event = await services.repos().events.getById(order.eventId);
      if (!originalRequest || !event) throw new Error('Original refund policy state missing');
      expect(originalRequest.sourceEventVersion).toBe(event.version);
      await services.repos().events.save({
        ...event,
        ...(promotion === 'cancelled'
          ? { status: 'cancelled' as const }
          : { lastMaterialChangeAt: order.createdAt }),
        version: event.version + 1,
      });
      const refundCall = vi.spyOn(memoryProvider(), 'refundPayment');
      const blocked = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/execute`,
        headers: asUser('m4_approver'),
      });
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(refundCall).not.toHaveBeenCalled();
      expect(await services.repos().refundRequests.getById(requestId)).toEqual(originalRequest);
      const rejected = await server.inject({
        method: 'POST',
        url: `/admin/refunds/${requestId}/reject`,
        headers: asUser('m4_approver'),
        payload: { reason: 'Recreate under authoritative full-paid policy' },
      });
      expect(rejected.statusCode, rejected.body).toBe(200);
      const recreated = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers: asUser('m4_admin'),
        payload: {
          orderId,
          targetEntitlementIds: [ticket.id],
          reason: 'Full affected original payment',
        },
      });
      if (promotion === 'cancelled') {
        expect(recreated.statusCode, recreated.body).toBe(400);
        const requests = await services.repos().refundRequests.listByOrder(orderId);
        const automatic = requests.filter((request) => request.id !== requestId);
        expect(automatic).toHaveLength(1);
        expect(automatic[0]).toMatchObject({
          amountPaise: order.grandTotalPaise,
          refundCause: 'organizer_cancel',
          purchasePolicyVersion: order.refundSnapshot?.policyVersion,
          sourceEventVersion: event.version + 1,
          scope: 'ticket_lines',
        });
        expect(automatic[0]?.targetEntitlementIds.slice().sort()).toEqual(
          order.refundSnapshot?.tickets.map((unit) => unit.entitlementId).sort(),
        );
        expect(automatic[0]?.refundComponents).toBeDefined();
        expect(automatic[0]?.intakeFingerprint).toBeTruthy();
        expect(refundCall).not.toHaveBeenCalled();
        return;
      }
      expect(recreated.statusCode, recreated.body).toBe(201);
      const unit = order.refundSnapshot?.tickets.find((item) => item.entitlementId === ticket.id);
      expect(recreated.json().request.amountPaise).toBe(unit?.totalPaidPaise);
      expect(recreated.json().request.refundCause).toBe('material_change');
    },
  );

  it('converges an immutable processed Memory-provider refund after policy promotion and preserves a deduplicated review remedy', async () => {
    await seedAdmin('m4_admin', 'finance');
    await seedAdmin('m4_approver', 'finance');
    const { orderId } = await seedPaidOrder(server, 100_000, 2);
    const order = await services.repos().orders.getById(orderId);
    const ticket = (await services.repos().entitlements.getByOrderId(orderId))[0];
    if (!order?.paymentId || !ticket) throw new Error('M4 paid purchase missing');
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: { orderId, targetEntitlementIds: [ticket.id], reason: 'Original Guest request' },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const requestId = requested.json().request.id as string;
    const approval = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/approve`,
      headers: asUser('m4_approver'),
    });
    expect(approval.statusCode, approval.body).toBe(200);
    const approved = await services.repos().refundRequests.getById(requestId);
    if (!approved) throw new Error('Approved request missing');
    const executing = beginRefundExecution(approved, new Date());
    await services.repos().refundRequests.save(executing);
    const providerCall = vi.spyOn(memoryProvider(), 'refundPayment');
    const providerFact = await memoryProvider().refundPayment({
      paymentId: order.paymentId,
      amountPaise: executing.amountPaise,
      idempotencyKey: executing.executionIdempotencyKey,
    });
    await services
      .repos()
      .refundRequests.save(
        recordRefundProviderFact(executing, providerFact.id, providerFact.status, new Date()),
      );
    const event = await services.repos().events.getById(order.eventId);
    if (!event) throw new Error('Event missing');
    await services
      .repos()
      .events.save({ ...event, lastMaterialChangeAt: order.createdAt, version: event.version + 1 });
    const runFailure = vi
      .spyOn(services.repos().reconciliations, 'saveRun')
      .mockRejectedValueOnce(new Error('Synthetic review-run persistence interruption'));
    const interrupted = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(interrupted.statusCode, interrupted.body).toBe(500);
    expect(await services.repos().refundRequests.getById(requestId)).toMatchObject({
      status: 'executing',
      providerRefundId: providerFact.id,
      providerStatus: 'processed',
      amountPaise: approved.amountPaise,
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
    runFailure.mockRestore();
    const recovered = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      request: {
        status: 'settled',
        amountPaise: approved.amountPaise,
        executionIdempotencyKey: approved.executionIdempotencyKey,
        refundCause: 'guest_request',
      },
      order: { refundedPaise: approved.amountPaise },
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
    const findings = (
      await services
        .repos()
        .reconciliations.listDiscrepancies({ organizationId: order.organizationId, limit: 100 })
    ).items.filter((item) => item.evidence.refundRequestId === requestId);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error('Financial remedy review missing');
    const original = order.refundSnapshot?.tickets.find((item) => item.entitlementId === ticket.id);
    expect(finding).toMatchObject({
      kind: 'refund_mismatch',
      state: 'finance_review',
      orderId,
      paymentId: order.paymentId,
      currency: order.currency,
      amountPaise: (original?.totalPaidPaise ?? 0) - approved.amountPaise,
      evidence: {
        reason: 'policy_remedy_required',
        selectedEntitlementIds: JSON.stringify([ticket.id]),
        authoritativeCause: 'material_change',
      },
    });
    await services.reconciliation.resolve(
      finding.id,
      'Controlled Admin review resolution; do not reset on replay',
      'm4_approver',
    );
    const replay = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(providerCall).toHaveBeenCalledTimes(1);
    const remedies = (await services.repos().refundRequests.listByOrder(orderId)).filter(
      (request) => request.remedyForRefundRequestId === requestId,
    );
    expect(remedies).toHaveLength(1);
    const remedy = remedies[0];
    if (!remedy) throw new Error('Original fee remedy missing');
    expect(remedy).toMatchObject({
      amountPaise: finding.amountPaise,
      refundCause: 'material_change',
      scope: 'amount_only',
      targetEntitlementIds: [],
      status: 'approved',
      executionAttempts: 0,
      refundComponents: {
        admissionPaise: 0,
        platformFeePaise: original?.platformFeePaise,
        paymentFeePaise: original?.paymentFeePaise,
        feeTaxPaise: original?.feeTaxPaise,
      },
    });
    const claimsBefore = (await services.repos().orders.getById(orderId))?.refundedTicketClaims;
    const remedyReplay = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/policy-remedy`,
      headers: asUser('m4_approver'),
    });
    expect(remedyReplay.statusCode, remedyReplay.body).toBe(201);
    expect(remedyReplay.json().request.id).toBe(remedy.id);
    await seedAdmin('m4_support', 'support');
    const unauthorized = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/policy-remedy`,
      headers: asUser('m4_support'),
    });
    expect(unauthorized.statusCode).toBe(403);
    const remedySettled = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${remedy.id}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(remedySettled.statusCode, remedySettled.body).toBe(200);
    expect(remedySettled.json().request.status).toBe('settled');
    expect(remedySettled.json().order.refundedPaise).toBe(original?.totalPaidPaise);
    expect((await services.repos().orders.getById(orderId))?.refundedTicketClaims).toEqual(
      claimsBefore,
    );
    const remainingTickets = await services.repos().entitlements.getByOrderId(orderId);
    expect(remainingTickets.find((item) => item.id === ticket.id)?.status).toBe('void');
    expect(
      remainingTickets
        .filter((item) => item.id !== ticket.id)
        .every((item) => item.status !== 'void'),
    ).toBe(true);
    expect(providerCall).toHaveBeenCalledTimes(2);
    const remedySettledReplay = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${remedy.id}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(remedySettledReplay.statusCode, remedySettledReplay.body).toBe(200);
    expect(providerCall).toHaveBeenCalledTimes(2);
    expect((await services.repos().reconciliations.getDiscrepancy(finding.id))?.state).toBe(
      'resolved',
    );
    expect(
      (
        await services
          .repos()
          .reconciliations.listDiscrepancies({ organizationId: order.organizationId, limit: 100 })
      ).items.filter((item) => item.evidence.refundRequestId === requestId),
    ).toHaveLength(1);
  });

  it('records the remaining original fee remedy when material change races the Memory provider operation', async () => {
    await seedAdmin('m4_admin', 'finance');
    await seedAdmin('m4_approver', 'finance');
    const { orderId } = await seedPaidOrder(server, 100_000, 2);
    const order = await services.repos().orders.getById(orderId);
    const ticket = (await services.repos().entitlements.getByOrderId(orderId))[0];
    if (!order || !ticket) throw new Error('M4 purchase missing');
    const requested = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers: asUser('m4_admin'),
      payload: { orderId, targetEntitlementIds: [ticket.id], reason: 'Original Guest refund' },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const requestId = requested.json().request.id as string;
    const approval = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/approve`,
      headers: asUser('m4_approver'),
    });
    expect(approval.statusCode, approval.body).toBe(200);
    const provider = memoryProvider();
    const originalRefund = provider.refundPayment.bind(provider);
    const call = vi.spyOn(provider, 'refundPayment').mockImplementationOnce(async (input) => {
      const fact = await originalRefund(input);
      const event = await services.repos().events.getById(order.eventId);
      if (!event) throw new Error('Event fixture missing');
      await services.repos().events.save({
        ...event,
        lastMaterialChangeAt: order.createdAt,
        version: event.version + 1,
      });
      return fact;
    });
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/refunds/${requestId}/execute`,
      headers: asUser('m4_approver'),
    });
    expect(executed.statusCode, executed.body).toBe(200);
    expect(executed.json().request).toMatchObject({
      status: 'settled',
      refundCause: 'guest_request',
      amountPaise: 100_000,
    });
    expect(call).toHaveBeenCalledTimes(1);
    const findings = (
      await services
        .repos()
        .reconciliations.listDiscrepancies({ organizationId: order.organizationId, limit: 100 })
    ).items.filter((item) => item.evidence.refundRequestId === requestId);
    expect(findings).toHaveLength(1);
    const unit = order.refundSnapshot?.tickets.find((item) => item.entitlementId === ticket.id);
    expect(findings[0]).toMatchObject({
      state: 'finance_review',
      amountPaise: (unit?.totalPaidPaise ?? 0) - 100_000,
      evidence: { reason: 'policy_remedy_required' },
    });
  });

  it('does not create intake while an in-flight cache claim has no committed canonical request', async () => {
    await seedAdmin('m4_admin', 'finance');
    const { orderId } = await seedPaidOrder(server, 100_000);
    const headers = asUser('m4_admin');
    vi.spyOn(services.idempotency, 'executeOnce').mockRejectedValueOnce(
      new IdempotencyInFlightError(headers['idempotency-key']),
    );
    const response = await server.inject({
      method: 'POST',
      url: '/admin/refunds',
      headers,
      payload: { orderId, reason: 'Not yet committed' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(await services.repos().refundRequests.listByOrder(orderId)).toHaveLength(0);
    expect((await services.repos().orders.getById(orderId))?.status).toBe('paid');
  });

  it.each(['failed', 'in-flight'] as const)(
    'recovers committed intake through a %s response-cache claim and rejects changed semantic intent',
    async (state) => {
      await seedAdmin('m4_admin', 'finance');
      const { orderId } = await seedPaidOrder(server, 100_000);
      const headers = asUser('m4_admin');
      const payload = { orderId, reason: 'Stable refund intake' };
      const first = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers,
        payload,
      });
      expect(first.statusCode, first.body).toBe(201);
      const fail = vi
        .spyOn(services.idempotency, 'executeOnce')
        .mockRejectedValueOnce(
          state === 'failed'
            ? new IdempotencyFailedError(headers['idempotency-key'])
            : new IdempotencyInFlightError(headers['idempotency-key']),
        );
      const recovered = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers,
        payload,
      });
      expect(recovered.statusCode, recovered.body).toBe(201);
      expect(recovered.json().request.id).toBe(first.json().request.id);
      expect(await services.repos().refundRequests.listByOrder(orderId)).toHaveLength(1);
      fail.mockRejectedValueOnce(
        state === 'failed'
          ? new IdempotencyFailedError(headers['idempotency-key'])
          : new IdempotencyInFlightError(headers['idempotency-key']),
      );
      const changed = await server.inject({
        method: 'POST',
        url: '/admin/refunds',
        headers,
        payload: { ...payload, reason: 'Different intent' },
      });
      expect(changed.statusCode, changed.body).toBe(409);
      expect(await services.repos().refundRequests.listByOrder(orderId)).toHaveLength(1);
    },
  );
});
