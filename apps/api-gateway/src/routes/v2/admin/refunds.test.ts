import { createPlatformAdmin, MemoryPaymentProvider } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
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
 * exercises the amount-tiered approval ladder end to end: auto-settle under
 * ₹500, single-approver under ₹5,000, and the two guards that matter most —
 * the requester cannot approve their own request, and a rejected request
 * restores the order to `paid` rather than any hardcoded status.
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
): Promise<{ orderId: string; grandTotalPaise: number }> {
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
    payload: { eventId, lines: [{ tierId, quantity: 1 }] },
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
  provider.simulateCapture(paymentId, grandTotalPaise);
  const signature = provider.generateSignature({ paymentId, orderId: paymentIntentId });
  const verify = await server.inject({
    method: 'POST',
    url: `/payments/${paymentId}/verify`,
    payload: { holdId, paymentIntentId, signature },
  });
  return { orderId: verify.json().order.id as string, grandTotalPaise };
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
  it('settles immediately under ₹500 (0 approvers)', async () => {
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
    expect(body.request.status).toBe('settled');
    expect(body.request.approversRequired).toBe(0);
    expect(body.order.status).toBe('paid'); // partial — order total is larger
    expect(body.order.refundedPaise).toBe(40_000);
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
  it('settles once a distinct second admin approves', async () => {
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
    expect(body.request.status).toBe('settled');
    expect(body.order.status).toBe('refunded'); // full amount exhausted the balance
    expect(body.order.refundedPaise).toBe(grandTotalPaise);
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
