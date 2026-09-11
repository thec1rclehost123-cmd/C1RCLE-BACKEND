import {
  createEvent,
  createOrganization,
  createPlatformAdmin,
  createVenue,
} from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PlatformUser, Venue } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminDirectoryRoutes from './directory.js';
import adminRoutes from './onboarding-review.js';
import adminVenueActionRoutes from './venue-actions.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin directory + venue suspension over HTTP (Phase 7 admin) ───────────
 * Seeds orgs / venues / events / users directly through the domain builders
 * (these routes are platform reads, not catalog writes), then asserts the
 * frozen `{ items, pageInfo }` envelope, the CSV export audit hook, and the
 * TIER2 direct `POST /admin/venues/:venueId/suspend` command (VENUE_SUSPEND
 * is a single-admin action — only TIER3 actions require dual control).
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function seedUser(userId: string, role: string | null): PlatformUser {
  const user: PlatformUser = {
    id: userId,
    email: `${userId}@c1rcle.test`,
    name: userId,
    image: null,
    emailVerified: true,
    role,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  (services.repos().users as unknown as { users: Map<string, PlatformUser> }).users.set(
    userId,
    user,
  );
  return user;
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

async function seedVenue(): Promise<Venue> {
  const org = createOrganization({
    id: `org_${++keySeq}`,
    name: `Org ${keySeq}`,
    slug: `org-${keySeq}`,
    ownerId: 'host_1',
  });
  await services.repos().organizations.save(org);
  const venue = createVenue({
    id: `venue_${keySeq}`,
    organizationId: org.id,
    ownerId: org.ownerId,
    name: 'Sky Bar',
    slug: `sky-bar-${keySeq}`,
    capacity: 120,
    city: 'Mumbai',
  });
  await services.repos().venues.save(venue);
  return venue;
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.users as unknown as { users: Map<string, unknown> }).users.clear();
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.venues as unknown as { venues: Map<string, unknown> }).venues.clear();
  (repos.events as unknown as { events: Map<string, unknown> }).events.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records = [];

  server = await buildPartnerTestServer({
    routes: [adminRoutes, adminDirectoryRoutes, adminVenueActionRoutes],
  });
});

describe('directory reads require platform authority', () => {
  it('refuses a non-admin on every directory read', async () => {
    for (const url of ['/admin/venues', '/admin/events', '/admin/hosts', '/admin/users']) {
      const response = await server.inject({
        method: 'GET',
        url,
        headers: { 'x-user-id': 'normal_user' },
      });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('GET /admin/venues', () => {
  it('returns seeded venues in the paginated envelope', async () => {
    await seedAdmin('admin_a', 'ops');
    const venue = await seedVenue();
    await seedVenue();

    const response = await server.inject({
      method: 'GET',
      url: '/admin/venues',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: venue.id,
      name: 'Sky Bar',
      city: 'Mumbai',
      status: 'active',
      capacity: 120,
    });
    expect(body.pageInfo.hasNextPage).toBe(false);
    expect(body.pageInfo.total).toBe(2);
  });

  it('paginates with a limit', async () => {
    await seedAdmin('admin_a', 'ops');
    await seedVenue();
    await seedVenue();
    await seedVenue();

    const response = await server.inject({
      method: 'GET',
      url: '/admin/venues?limit=2',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(response.json().pageInfo.hasNextPage).toBe(true);
  });
});

describe('GET /admin/events', () => {
  it('returns seeded events', async () => {
    await seedAdmin('admin_a', 'ops');
    await seedVenue();
    const venues = await services.repos().venues.listAll({ limit: 1, cursor: null });
    const org = await services.repos().organizations.listAll({ limit: 1, cursor: null });
    const orgItem = org.items[0];
    const venueItem = venues.items[0];
    if (orgItem === undefined || venueItem === undefined)
      throw new Error('seed events: expected org and venue');
    const event = createEvent({
      id: 'event_1',
      organizationId: orgItem.id,
      venueId: venueItem.id,
      title: 'Sky Night',
      startAt: '2026-09-01T18:00:00Z',
    });
    await services.repos().events.save(event);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/events',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'event_1',
      title: 'Sky Night',
      status: 'draft',
      isPublic: false,
      isFree: true,
    });
  });
});

describe('GET /admin/hosts', () => {
  it('returns organizations with memberCount', async () => {
    await seedAdmin('admin_a', 'ops');
    await seedVenue();

    const response = await server.inject({
      method: 'GET',
      url: '/admin/hosts',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      status: 'active',
      memberCount: 1,
    });
  });
});

describe('GET /admin/users', () => {
  it('returns accounts with role metadata', async () => {
    await seedAdmin('admin_a', 'ops');
    seedUser('usr_1', 'host');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'usr_1',
      email: 'usr_1@c1rcle.test',
      role: 'host',
      emailVerified: true,
    });
  });
});

describe('VENUE_SUSPEND (TIER2, direct command)', () => {
  it('suspends the venue and writes an audit row', async () => {
    await seedAdmin('admin_a', 'ops');
    const venue = await seedVenue();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/venues/${venue.id}/suspend`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: venue.id, status: 'suspended' });

    const audit = await server.inject({
      method: 'GET',
      url: '/admin/audit?limit=10',
      headers: { 'x-user-id': 'admin_a' },
    });
    const records = audit.json().items as { action: string; targetType: string }[];
    const auditRow = records.find((record) => record.action === 'VENUE_SUSPEND');
    expect(auditRow).toBeDefined();
    expect(auditRow?.targetType).toBe('venue');
  });

  it('refuses a role below TIER2 (support cannot suspend a venue)', async () => {
    await seedAdmin('admin_support', 'support');
    const venue = await seedVenue();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/venues/${venue.id}/suspend`,
      headers: asUser('admin_support'),
    });

    expect(executed.statusCode).toBe(403);
    const reviews = await services.repos().venues.listAll({ limit: 10, cursor: null });
    expect(reviews.items[0]?.status).toBe('active');
  });

  it('repeat suspend is idempotent (200, still suspended)', async () => {
    await seedAdmin('admin_a', 'ops');
    const venue = await seedVenue();
    const first = await server.inject({
      method: 'POST',
      url: `/admin/venues/${venue.id}/suspend`,
      headers: asUser('admin_a'),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `/admin/venues/${venue.id}/suspend`,
      headers: asUser('admin_a'),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('suspended');
  });

  it('unknown venue id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'ops');
    const executed = await server.inject({
      method: 'POST',
      url: '/admin/venues/venue_missing/suspend',
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(404);
  });
});

describe('GET /admin/audit/export.csv', () => {
  it('returns CSV with a recorded ADMIN_EXPORT row', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/audit/export.csv',
      headers: { 'x-user-id': 'admin_a' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain(
      '"adminId","adminRole","action","targetType","targetId","reason","occurredAt"',
    );

    const audit = await server.inject({
      method: 'GET',
      url: '/admin/audit?limit=10',
      headers: { 'x-user-id': 'admin_a' },
    });
    const records = audit.json().items as { action: string }[];
    expect(records.some((record) => record.action === 'ADMIN_EXPORT')).toBe(true);
  });
});
