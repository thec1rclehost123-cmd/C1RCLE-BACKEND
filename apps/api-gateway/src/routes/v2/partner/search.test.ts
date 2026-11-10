import { describe, expect, it } from 'vitest';

import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerDiscoveryRoutes from './discover.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerPartnershipRoutes from './partnerships.js';
import promoterConnectionRoutes from './promoter-connections.js';
import partnerSearchRoutes from './search.js';
import partnerVenueRoutes from './venues.js';

const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerPartnershipRoutes,
      partnerDiscoveryRoutes,
      promoterConnectionRoutes,
      partnerSearchRoutes,
    ],
  });

describe('partner global search', () => {
  it('returns bounded empty results for an authorized tenant and rejects cross-tenant scope', async () => {
    const server = await buildServer();
    const org = await seedApprovedPartnerOrganization({
      name: 'Search Venue',
      slug: `search-${Date.now()}`,
    });
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org.id}/search?q=nomatch`,
      headers: { 'x-organization-id': org.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });

    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org.id}/venues`,
      headers: { 'x-organization-id': org.id, 'idempotency-key': `search-venue-${Date.now()}` },
      payload: { name: 'Search Venue', slug: `search-venue-${Date.now()}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org.id}/events`,
      headers: { 'x-organization-id': org.id, 'idempotency-key': `search-event-${Date.now()}` },
      payload: {
        title: 'Neon Search Event',
        summary: 'search test',
        description: 'search test',
        venueId: venue.json().id,
        startAt: '2099-09-01T18:00:00Z',
      },
    });
    expect(event.statusCode).toBe(201);
    const found = await server.inject({
      method: 'GET',
      url: `/organizations/${org.id}/search?q=Neon`,
      headers: { 'x-organization-id': org.id },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      results: [
        { id: event.json().id, type: 'event', title: 'Neon Search Event', subtitle: 'Event' },
      ],
    });

    const denied = await server.inject({
      method: 'GET',
      url: '/organizations/org_other/search?q=nomatch',
      headers: { 'x-organization-id': org.id },
    });
    expect(denied.statusCode).toBe(403);
    await server.close();
  });

  it('rejects short queries before searching', async () => {
    const server = await buildServer();
    const org = await seedApprovedPartnerOrganization({
      name: 'Search Venue',
      slug: `search-short-${Date.now()}`,
    });
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org.id}/search?q=x`,
      headers: { 'x-organization-id': org.id },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });
});
