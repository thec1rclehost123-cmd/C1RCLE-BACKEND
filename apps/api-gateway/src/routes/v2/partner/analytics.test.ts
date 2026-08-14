import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerAnalyticsRoutes from './analytics.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Partner analytics over HTTP (Phase 1) ───────────────────────────────────
 * Read-model routes. The interesting cases are the empty state (a legitimate
 * answer, not an error) and the tenancy guard.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerAnalyticsRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const read = (org: string) => ({ 'x-organization-id': org });

async function seedOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

describe('organization analytics overview', () => {
  it('returns real zeroes for an organization with no history', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    // An empty dashboard is a legitimate state — not a 404, not an error.
    expect(response.json()).toMatchObject({
      organizationId: org,
      totalEvents: 0,
      totalRevenuePaise: 0,
      topEvents: [],
      lastEventAt: null,
    });
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/overview',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('event analytics', () => {
  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/events/evt_someone_else/analytics',
      headers: read(org),
    });

    // Never confirms whether that event exists.
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('reports not-found while an event has no read model yet', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Sky Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/analytics`,
      headers: read(org),
    });

    // The projection has not run: honest 404 rather than fabricated zeroes,
    // which would read as "this event sold nothing" instead of "no data yet".
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});
