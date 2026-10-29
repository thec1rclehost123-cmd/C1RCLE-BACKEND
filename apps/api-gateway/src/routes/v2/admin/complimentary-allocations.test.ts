import { InventoryService } from '@c1rcle/core/application';
import {
  createEvent,
  createOrganization,
  createPlatformAdmin,
  createTicketTier,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminComplimentaryAllocationRoutes from './complimentary-allocations.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
let server: FastifyInstance;
let sequence = 0;

async function seedAdmin(userId: string, role: AdminRole = 'ops') {
  await services.repos().platformAdmins.save(
    createPlatformAdmin({
      id: userId,
      email: `${userId}@c1rcle.test`,
      role,
    }),
  );
}

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.events as unknown as { events: Map<string, unknown> }).events.clear();
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.catalog as unknown as { tiers: Map<string, unknown> }).tiers.clear();
  (repos.users as unknown as { users: Map<string, unknown> }).users.clear();
  (
    repos.complimentaryAllocations as unknown as { allocations: Map<string, unknown> }
  ).allocations.clear();
  (repos.complimentaryAllocations as unknown as { claims: Map<string, unknown> }).claims.clear();
  (repos.orders as unknown as { orders: Map<string, unknown> }).orders.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (
    repos.cartReservations as unknown as { reservations: Map<string, unknown> }
  ).reservations.clear();
  server = await buildPartnerTestServer({ routes: [adminComplimentaryAllocationRoutes] });
});

async function seedEventAndTier() {
  const orgId = `org_comp_${++sequence}`;
  const org = createOrganization({ id: orgId, name: 'Comp Org', slug: orgId, ownerId: 'host_1' });
  await services.repos().organizations.save(org);
  const event = createEvent({
    id: `event_comp_${sequence}`,
    organizationId: orgId,
    venueId: 'venue_1',
    title: 'Comp Test',
    startAt: '2026-11-01T18:00:00.000Z',
  });
  await services.repos().events.save(event);
  const tier = createTicketTier({
    id: `tier_comp_${sequence}`,
    eventId: event.id,
    organizationId: orgId,
    name: 'General',
    quantity: 2,
    priceInPaise: 10000,
  });
  await services.repos().catalog.saveTier(tier);
  return { event, tier };
}

describe('Admin controlled complimentary allocations', () => {
  it('requires Tier2 Admin authority and issues a zero-value ticket without provider payment', async () => {
    const { event, tier } = await seedEventAndTier();
    const userId = 'comp_recipient';
    (services.repos().users as unknown as { users: Map<string, unknown> }).users.set(userId, {
      id: userId,
      email: 'guest@example.test',
      name: 'Comp Guest',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const denied = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/complimentary-allocations`,
      headers: { 'x-user-id': 'not_admin', 'idempotency-key': 'comp-create-denied' },
      payload: { tierId: tier.id, category: 'artist', reason: 'Production guest list', quota: 1 },
    });
    expect(denied.statusCode).toBe(401);

    await seedAdmin('comp_admin');
    const created = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/complimentary-allocations`,
      headers: { 'x-user-id': 'comp_admin', 'idempotency-key': 'comp-create-1' },
      payload: { tierId: tier.id, category: 'artist', reason: 'Production guest list', quota: 1 },
    });
    expect(created.statusCode).toBe(201);
    const allocationId = created.json().id as string;

    const issued = await server.inject({
      method: 'POST',
      url: `/admin/complimentary-allocations/${allocationId}/claims`,
      headers: { 'x-user-id': 'comp_admin', 'idempotency-key': 'comp-issue-1' },
      payload: { recipientUserId: userId, holderName: 'Comp Guest' },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toMatchObject({
      orderId: expect.any(String),
      entitlements: [{ unitKind: 'complimentary' }],
    });
    const order = await services.repos().orders.getById(issued.json().orderId);
    expect(order).toMatchObject({
      status: 'paid',
      grandTotalPaise: 0,
      paymentId: null,
      paymentIntentId: null,
    });
    expect(await services.repos().entitlements.countValidByTier(tier.id)).toBe(1);
    const inventory = new InventoryService({
      eventCatalog: services.repos().catalog,
      cartReservation: services.repos().cartReservations,
      order: services.repos().orders,
    });
    expect(await inventory.getAvailableQuantity(event.id, tier.id)).toBe(1);

    const revoked = await server.inject({
      method: 'POST',
      url: `/admin/complimentary-claims/${issued.json().claim.id}/revoke`,
      headers: { 'x-user-id': 'comp_admin', 'idempotency-key': 'comp-revoke-1' },
      payload: { reason: 'Guest list allocation was entered in error' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ claimStatus: 'revoked', entitlementStatus: 'void' });
    expect(await services.repos().entitlements.countValidByTier(tier.id)).toBe(0);
    expect(await services.repos().orders.getById(issued.json().orderId)).toMatchObject({
      status: 'refunded',
      refundedPaise: 0,
      paymentId: null,
      paymentIntentId: null,
    });
    expect(await inventory.getAvailableQuantity(event.id, tier.id)).toBe(2);
  });
});
