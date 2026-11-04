import {
  createEvent,
  createOrganization,
  createPlatformAdmin,
  createTicketTier,
  updateTicketTier,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import waitlistRoutes from './waitlist-routes.js';

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

async function seedEvent(tierQuantity: number) {
  const id = ++sequence;
  const organization = createOrganization({
    id: `org_wait_${id}`,
    name: 'Waitlist Org',
    slug: `waitlist-org-${id}`,
    ownerId: 'host_waitlist',
  });
  await services.repos().organizations.save(organization);
  const draft = createEvent({
    id: `event_wait_${id}`,
    organizationId: organization.id,
    venueId: `venue_wait_${id}`,
    title: 'Waitlist Event',
    startAt: '2026-11-30T20:00:00.000Z',
  });
  const event = { ...draft, status: 'published' as const, isPublic: true };
  await services.repos().events.save(event);
  const tier = createTicketTier({
    id: `tier_wait_${id}`,
    eventId: event.id,
    organizationId: organization.id,
    name: 'General Admission',
    quantity: tierQuantity,
    priceInPaise: 10000,
  });
  await services.repos().catalog.saveTier(tier);
  return { event, tier };
}

let guestId: string;

beforeEach(async () => {
  const repos = services.repos();
  for (const [repository, property] of [
    [repos.platformAdmins, 'admins'],
    [repos.events, 'events'],
    [repos.organizations, 'organizations'],
    [repos.catalog, 'tiers'],
    [repos.users, 'users'],
    [repos.waitlist, 'entries'],
    [repos.orders, 'orders'],
  ] as const) {
    (repository as unknown as Record<string, Map<string, unknown>>)[property]?.clear();
  }
  (repos.waitlist as unknown as { sequences: Map<string, number> }).sequences.clear();
  guestId = `wait_guest_${++sequence}`;
  (repos.users as unknown as { users: Map<string, unknown> }).users.set(guestId, {
    id: guestId,
    email: `${guestId}@example.test`,
    name: 'Waitlist Guest',
    image: null,
    emailVerified: true,
    role: 'guest',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  server = await buildPartnerTestServer({ routes: [waitlistRoutes], actorRole: 'owner' });
});

describe('M5 waitlist routes', () => {
  it('queues FIFO, reserves a bounded hold, and hands it to Guest checkout without charging', async () => {
    const { event, tier } = await seedEvent(0);
    const joined = await server.inject({
      method: 'POST',
      url: '/waitlist',
      headers: { 'x-user-id': guestId },
      payload: { eventId: event.id, tierId: tier.id },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ sequence: 1, status: 'waiting' });

    const replay = await server.inject({
      method: 'POST',
      url: '/waitlist',
      headers: { 'x-user-id': guestId },
      payload: { eventId: event.id, tierId: tier.id },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(joined.json().id);

    await services.repos().catalog.saveTier(updateTicketTier(tier, { quantity: 1 }));
    await seedAdmin('wait_admin');
    const offered = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/tiers/${tier.id}/waitlist/offer-next`,
      headers: { 'x-user-id': 'wait_admin', 'idempotency-key': 'wait-offer-1' },
      payload: {},
    });
    expect(offered.statusCode).toBe(201);
    expect(offered.json()).toMatchObject({ entry: { id: joined.json().id, status: 'offered' } });

    const accepted = await server.inject({
      method: 'POST',
      url: `/waitlist/${joined.json().id}/accept`,
      headers: { 'x-user-id': guestId, 'idempotency-key': 'wait-accept-1' },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      entry: { status: 'accepted' },
      holdId: expect.any(String),
    });
    const acceptedOffer = await server.inject({
      method: 'GET',
      url: `/waitlist/${joined.json().id}`,
      headers: { 'x-user-id': guestId },
    });
    expect(acceptedOffer.statusCode).toBe(200);
    expect(acceptedOffer.json()).toMatchObject({
      entry: { id: joined.json().id, status: 'accepted' },
      holdId: accepted.json().holdId,
      pricing: { grandTotalPaise: accepted.json().pricing.grandTotalPaise },
    });
    const hold = await services.repos().cartReservations.getById(accepted.json().holdId);
    expect(hold).toMatchObject({ status: 'active', userId: guestId });
    expect(hold).not.toHaveProperty('providerOrderId');
    expect(
      (services.repos().orders as unknown as { orders: Map<string, unknown> }).orders.size,
    ).toBe(0);
  });

  it('refuses an unverified account before allocating a queue position', async () => {
    const { event, tier } = await seedEvent(0);
    const unverifiedId = 'wait_guest_unverified';
    (services.repos().users as unknown as { users: Map<string, unknown> }).users.set(unverifiedId, {
      id: unverifiedId,
      email: `${unverifiedId}@example.test`,
      name: 'Unverified',
      image: null,
      emailVerified: false,
      role: 'guest',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/waitlist',
      headers: { 'x-user-id': unverifiedId },
      payload: { eventId: event.id, tierId: tier.id },
    });
    expect(response.statusCode).toBe(400);
    expect(await services.repos().waitlist.getNextWaiting(event.id, tier.id)).toBeNull();
  });

  it('returns an explicit no-waiter result to an authorized offer operator', async () => {
    const { event, tier } = await seedEvent(1);
    await seedAdmin('wait_admin_empty');
    const response = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/tiers/${tier.id}/waitlist/offer-next`,
      headers: { 'x-user-id': 'wait_admin_empty', 'idempotency-key': 'wait-offer-empty' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ offered: false });
  });

  it('returns an Admin-scoped FIFO queue without exposing account identifiers', async () => {
    const { event, tier } = await seedEvent(0);
    const otherGuest = 'wait_guest_second';
    (services.repos().users as unknown as { users: Map<string, unknown> }).users.set(otherGuest, {
      id: otherGuest,
      email: `${otherGuest}@example.test`,
      name: 'Second guest',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const userId of [guestId, otherGuest]) {
      const joined = await server.inject({
        method: 'POST',
        url: '/waitlist',
        headers: { 'x-user-id': userId },
        payload: { eventId: event.id, tierId: tier.id },
      });
      expect(joined.statusCode).toBe(201);
    }
    await seedAdmin('wait_admin_queue');
    const response = await server.inject({
      method: 'GET',
      url: `/admin/events/${event.id}/tiers/${tier.id}/waitlist?limit=1`,
      headers: { 'x-user-id': 'wait_admin_queue' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      items: [{ sequence: 1, status: 'waiting' }],
      pageInfo: { total: 2, hasNextPage: true },
    });
    expect(response.json().items[0]).not.toHaveProperty('userId');
    expect(response.json().pageInfo.nextCursor).toBe('1');
    const nextPage = await server.inject({
      method: 'GET',
      url: `/admin/events/${event.id}/tiers/${tier.id}/waitlist?limit=1&cursor=1`,
      headers: { 'x-user-id': 'wait_admin_queue' },
    });
    expect(nextPage.statusCode).toBe(200);
    expect(nextPage.json()).toMatchObject({
      items: [{ sequence: 2, status: 'waiting' }],
      pageInfo: { page: 2, total: 2, hasNextPage: false },
    });
  });

  it('allows only the owning Partner organization to inspect the queue and issue an idempotent offer', async () => {
    const { event, tier } = await seedEvent(0);
    const joined = await server.inject({
      method: 'POST',
      url: '/waitlist',
      headers: { 'x-user-id': guestId },
      payload: { eventId: event.id, tierId: tier.id },
    });
    expect(joined.statusCode).toBe(201);

    const forbidden = await server.inject({
      method: 'GET',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist`,
      headers: { 'x-user-id': 'host_wrong_org', 'x-organization-id': 'org_wrong' },
    });
    expect(forbidden.statusCode).toBe(404);

    const headers = { 'x-user-id': 'host_waitlist', 'x-organization-id': event.organizationId };
    const queue = await server.inject({
      method: 'GET',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist?limit=10`,
      headers,
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.headers['cache-control']).toContain('no-store');
    expect(queue.json()).toMatchObject({ items: [{ sequence: 1, status: 'waiting' }] });
    expect(queue.json().items[0]).not.toHaveProperty('userId');

    const readOnlyServer = await buildPartnerTestServer({
      routes: [waitlistRoutes],
      actorRole: 'member',
    });
    const readOnlyOffer = await readOnlyServer.inject({
      method: 'POST',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist/offer-next`,
      headers: {
        ...headers,
        'idempotency-key': 'member-waitlist-offer-denied',
      },
      payload: {},
    });
    expect(readOnlyOffer.statusCode).toBe(403);
    await readOnlyServer.close();

    await services.repos().catalog.saveTier(updateTicketTier(tier, { quantity: 1 }));
    const offerHeaders = {
      ...headers,
      'idempotency-key': 'partner-waitlist-offer-1',
    };
    const offered = await server.inject({
      method: 'POST',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist/offer-next`,
      headers: offerHeaders,
      payload: {},
    });
    expect(offered.statusCode).toBe(201);
    expect(offered.json()).toMatchObject({
      entry: { id: joined.json().id, status: 'offered' },
      expiresAt: expect.any(String),
    });

    const replay = await server.inject({
      method: 'POST',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist/offer-next`,
      headers: offerHeaders,
      payload: {},
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(offered.json());
    const queueAfter = await server.inject({
      method: 'GET',
      url: `/events/${event.id}/tiers/${tier.id}/waitlist?limit=10`,
      headers,
    });
    expect(queueAfter.json().items).toHaveLength(1);
    expect(queueAfter.json().items[0]).toMatchObject({ id: joined.json().id, status: 'offered' });
  });
});
