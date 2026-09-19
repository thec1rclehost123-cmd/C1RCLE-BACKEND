import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Order } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminOrderRoutes from './orders.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin orders desk over HTTP (Phase 7 admin) ────────────────────────────
 * Platform-wide, read-only order list. Asserts admin gating, DTO shape, and
 * that `ticketCount` correctly sums line quantities.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  const now = new Date().toISOString();
  const id = `ORD-${++keySeq}`;
  return {
    id,
    eventId: 'event_1',
    organizationId: 'org_1',
    userId: `user_${keySeq}`,
    contact: { name: 'Test Buyer', email: 'buyer@example.com', phone: '+910000000000' },
    status: 'paid',
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'General',
        quantity: 2,
        unitPricePaise: 1000,
        subtotalPaise: 2000,
      },
    ],
    currency: 'INR',
    subtotalPaise: 2000,
    discountPaise: 0,
    discountedSubtotalPaise: 2000,
    platformFeePaise: 200,
    paymentFeePaise: 50,
    gstPaise: 36,
    grandTotalPaise: 2286,
    appliedPromoCode: null,
    attribution: null,
    paymentIntentId: 'order_abc',
    paymentId: 'pay_xyz',
    paidAt: now,
    reservationExpiresAt: now,
    failureReason: null,
    refundedPaise: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.orders as unknown as { orders: Map<string, unknown> }).orders.clear();

  server = await buildPartnerTestServer({ routes: [adminOrderRoutes] });
});

describe('GET /admin/orders', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/orders',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns an empty page for an admin with no orders', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/orders',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(0);
    expect(body.pageInfo.total).toBe(0);
    expect(body.pageInfo.hasNextPage).toBe(false);
  });

  it('lists orders platform-wide with correct DTO shape and summed ticketCount', async () => {
    await seedAdmin('admin_a', 'finance');

    await services.repos().orders.save(
      makeOrder({
        lines: [
          {
            tierId: 't1',
            tierName: 'General',
            quantity: 3,
            unitPricePaise: 500,
            subtotalPaise: 1500,
          },
          { tierId: 't2', tierName: 'VIP', quantity: 1, unitPricePaise: 2000, subtotalPaise: 2000 },
        ],
        grandTotalPaise: 3500,
        refundedPaise: 500,
        status: 'refund_requested',
      }),
    );
    await services.repos().orders.save(makeOrder());

    const response = await server.inject({
      method: 'GET',
      url: '/admin/orders',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);

    const multiLine = body.items.find((item: { id: string }) => item.id === 'ORD-1');
    expect(multiLine.ticketCount).toBe(4);
    expect(multiLine.grandTotalPaise).toBe(3500);
    expect(multiLine.refundedPaise).toBe(500);
    expect(multiLine.status).toBe('refund_requested');
    expect(multiLine.contact).toEqual({
      name: 'Test Buyer',
      email: 'buyer@example.com',
      phone: '+910000000000',
    });

    const singleLine = body.items.find((item: { id: string }) => item.id === 'ORD-2');
    expect(singleLine.ticketCount).toBe(2);
  });
});
