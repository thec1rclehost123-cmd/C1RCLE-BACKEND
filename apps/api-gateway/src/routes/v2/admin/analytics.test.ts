import { createEvent, createOrganization, createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Order } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminAnalyticsRoutes from './analytics.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin analytics summary over HTTP (Phase 7 admin) ───────────────────────
 * Read-only, any admin. Asserts the aggregation math (net revenue = grand
 * total minus refunded, tickets summed across lines, active events counted
 * via `isPublicStatus`) and that non-captured order statuses are excluded.
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

async function seedOrg(name: string): Promise<string> {
  const org = createOrganization({
    id: `org_${++keySeq}`,
    name,
    slug: `org-${keySeq}`,
    ownerId: 'host_1',
  });
  await services.repos().organizations.save(org);
  return org.id;
}

async function seedPublishedEvent(organizationId: string): Promise<string> {
  const draft = createEvent({
    id: `event_${++keySeq}`,
    organizationId,
    venueId: 'venue_1',
    title: 'Sky Night',
    startAt: '2026-10-01T18:00:00Z',
  });
  // Constructed directly at `published` for this first save (not via
  // `transitionEvent`, which would bump the version past what a brand-new
  // document's compare-and-set expects).
  const event = { ...draft, status: 'published' as const, isPublic: true };
  await services.repos().events.save(event);
  return event.id;
}

function order(overrides: Partial<Order>): Order {
  const now = new Date().toISOString();
  return {
    id: `order_${++keySeq}`,
    eventId: 'event_x',
    organizationId: 'org_x',
    userId: null,
    contact: { name: 'Guest', email: 'guest@example.com', phone: '9000000000' },
    status: 'paid',
    lines: [
      {
        tierId: 'tier_1',
        tierName: 'General',
        quantity: 2,
        unitPricePaise: 50_00,
        subtotalPaise: 100_00,
      },
    ],
    currency: 'INR',
    subtotalPaise: 100_00,
    discountPaise: 0,
    discountedSubtotalPaise: 100_00,
    platformFeePaise: 0,
    paymentFeePaise: 0,
    gstPaise: 0,
    grandTotalPaise: 100_00,
    appliedPromoCode: null,
    attribution: null,
    paymentIntentId: null,
    paymentId: null,
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
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.events as unknown as { events: Map<string, unknown> }).events.clear();
  (repos.orders as unknown as { orders: Map<string, unknown> }).orders.clear();

  server = await buildPartnerTestServer({ routes: [adminAnalyticsRoutes] });
});

describe('GET /admin/analytics', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/analytics',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('sums net revenue and tickets only for captured orders, and counts active events', async () => {
    await seedAdmin('admin_a', 'ops');
    const orgId = await seedOrg('Blue Room');
    await seedPublishedEvent(orgId);
    // A second, non-public event must not count as active.
    await services.repos().events.save(
      createEvent({
        id: `event_${++keySeq}`,
        organizationId: orgId,
        venueId: 'venue_1',
        title: 'Draft Night',
        startAt: '2026-10-01T18:00:00Z',
      }),
    );

    await services
      .repos()
      .orders.save(
        order({ organizationId: orgId, status: 'paid', grandTotalPaise: 100_00, refundedPaise: 0 }),
      );
    await services.repos().orders.save(
      order({
        organizationId: orgId,
        status: 'refund_requested',
        grandTotalPaise: 200_00,
        refundedPaise: 50_00,
      }),
    );
    // Never captured — must not contribute revenue or tickets.
    await services.repos().orders.save(
      order({
        organizationId: orgId,
        status: 'pending',
        grandTotalPaise: 999_00,
        refundedPaise: 0,
      }),
    );
    await services.repos().orders.save(
      order({
        organizationId: orgId,
        status: 'expired',
        grandTotalPaise: 999_00,
        refundedPaise: 0,
      }),
    );

    const response = await server.inject({
      method: 'GET',
      url: '/admin/analytics',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // (100_00 - 0) + (200_00 - 50_00) = 250_00
    expect(body.totalRevenuePaise).toBe(250_00);
    // 2 tickets per captured order * 2 captured orders
    expect(body.ticketsSold).toBe(4);
    expect(body.activeEventsCount).toBe(1);
    expect(body.topOrganizations).toEqual([
      { organizationId: orgId, name: 'Blue Room', revenuePaise: 250_00 },
    ]);
  });
});
