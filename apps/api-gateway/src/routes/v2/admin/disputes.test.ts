import {
  attachPaymentIntent,
  calculatePricing,
  createDispute,
  createOrder,
  createPlatformAdmin,
  markPaid,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, TicketTier } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminDisputeRoutes from './disputes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin dispute resolution desk over HTTP (Phase 6 admin) ─────────────────
 * The order + dispute are seeded directly on the repositories (same
 * convention as `payouts.test.ts`) — the piece under test is the admin
 * resolution desk's ledger side effect, not the partner-side checkout or
 * dispute-raise flows, which have their own coverage.
 */

const services = createV2Services();
let keySeq = 0;

function tier(overrides: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 'tier_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    name: 'General',
    description: '',
    entryType: 'general',
    currency: 'INR',
    priceInPaise: 100_000,
    quantity: 100,
    status: 'active',
    salesStartAt: null,
    salesEndAt: null,
    minPerOrder: null,
    maxPerOrder: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

async function seedPaidOrder(suffix: number) {
  const pricing = calculatePricing({
    lines: [{ tier: tier({ eventId: `evt_${suffix}` }), quantity: 1 }],
  });
  const created = createOrder({
    id: `order_${suffix}`,
    eventId: `evt_${suffix}`,
    organizationId: `org_${suffix}`,
    userId: 'user_1',
    contact: { name: 'Guest', email: 'guest@example.com', phone: '9876543210' },
    pricing,
  });
  const withIntent = attachPaymentIntent(created, `intent_${suffix}`);
  const paid = markPaid(withIntent, `pay_${suffix}`);
  // Direct map write, not `.save()` — the two prior FSM transitions already
  // bumped the version past what a fresh CAS write (existing version 0)
  // would accept; this test only needs a paid order to exist, not a
  // realistic version history.
  (services.repos().orders as unknown as { orders: Map<string, unknown> }).orders.set(
    paid.id,
    paid,
  );
  return paid;
}

async function seedDispute(order: Awaited<ReturnType<typeof seedPaidOrder>>, suffix: number) {
  const dispute = createDispute({
    organizationId: order.organizationId,
    orderId: order.id,
    raisedBy: 'user_1',
    reason: 'Payout amount does not match the ticket count',
    amount: 20_000,
    now: new Date(),
  });
  const withId = { ...dispute, id: `dispute_${suffix}` };
  await services.repos().disputes.save(withId);
  return withId;
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.disputes as unknown as { disputes: Map<string, unknown> }).disputes.clear();
  (
    repos.orders as unknown as { orders: Map<string, unknown>; byPaymentId: Map<string, unknown> }
  ).orders.clear();
  (
    repos.orders as unknown as { orders: Map<string, unknown>; byPaymentId: Map<string, unknown> }
  ).byPaymentId.clear();
  (repos.ledger as unknown as { entries: Map<string, unknown> }).entries.clear();

  server = await buildPartnerTestServer({ routes: [adminDisputeRoutes] });
});

describe('POST /admin/disputes/:disputeId/resolve', () => {
  it('upheld writes a correcting ledger entry for the disputed amount', async () => {
    await seedAdmin('admin_a', 'finance');
    const order = await seedPaidOrder(1);
    const dispute = await seedDispute(order, 1);

    const response = await server.inject({
      method: 'POST',
      url: `/admin/disputes/${dispute.id}/resolve`,
      headers: asUser('admin_a'),
      payload: { outcome: 'upheld', resolutionNote: 'Confirmed short payout' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('resolved');
    expect(body.resolution).toBe('upheld');

    const entries = await services.repos().ledger.findByOrder(order.id);
    const correction = entries.find((e) => e.entryType === 'refund');
    expect(correction).toBeDefined();
    expect(correction?.amount).toBe(20_000);
    expect(correction?.status).toBe('settled');
  });

  it('denied resolves the dispute without touching the ledger', async () => {
    await seedAdmin('admin_a', 'finance');
    const order = await seedPaidOrder(2);
    const dispute = await seedDispute(order, 2);

    const response = await server.inject({
      method: 'POST',
      url: `/admin/disputes/${dispute.id}/resolve`,
      headers: asUser('admin_a'),
      payload: { outcome: 'denied', resolutionNote: 'Amount was correct' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().resolution).toBe('denied');

    const entries = await services.repos().ledger.findByOrder(order.id);
    expect(entries).toHaveLength(0);
  });

  it('refuses a role below TIER2 (support cannot resolve a dispute)', async () => {
    await seedAdmin('admin_support', 'support');
    const order = await seedPaidOrder(3);
    const dispute = await seedDispute(order, 3);

    const response = await server.inject({
      method: 'POST',
      url: `/admin/disputes/${dispute.id}/resolve`,
      headers: asUser('admin_support'),
      payload: { outcome: 'upheld', resolutionNote: 'Try anyway' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('unknown dispute id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'finance');

    const response = await server.inject({
      method: 'POST',
      url: '/admin/disputes/dispute_missing/resolve',
      headers: asUser('admin_a'),
      payload: { outcome: 'denied', resolutionNote: 'n/a' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('reads', () => {
  it('lists disputes filtered by status across organizations', async () => {
    await seedAdmin('admin_a', 'finance');
    const order = await seedPaidOrder(4);
    await seedDispute(order, 4);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/disputes?status=open',
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].status).toBe('open');
  });

  it('fetches a single dispute by id', async () => {
    await seedAdmin('admin_a', 'finance');
    const order = await seedPaidOrder(5);
    const dispute = await seedDispute(order, 5);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/disputes/${dispute.id}`,
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(dispute.id);
  });
});
