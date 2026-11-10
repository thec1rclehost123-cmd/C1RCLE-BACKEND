import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { seedApprovedPartnerOrganization } from '../../../test-utils/approved-partner-organization.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import eventComparisonRoutes from './event-comparison.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

let sequence = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      eventComparisonRoutes,
    ],
  });

describe('same-venue event comparison', () => {
  it('selects completed same-tenant events and labels current versus final totals', async () => {
    const server = await buildServer();
    const org = await seedApprovedPartnerOrganization({
      name: 'Compare Host',
      slug: `compare-${++sequence}`,
    });
    const read = { 'x-organization-id': org.id };
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org.id}/venues`,
      headers: { ...read, 'idempotency-key': `venue-${++sequence}` },
      payload: { name: 'Compare Venue', slug: `compare-venue-${sequence}` },
    });
    const makeEvent = async (title: string, startAt: string) =>
      server.inject({
        method: 'POST',
        url: `/organizations/${org.id}/events`,
        headers: { ...read, 'idempotency-key': `event-${++sequence}` },
        payload: {
          title,
          summary: 'compare',
          description: 'compare',
          venueId: venue.json().id,
          startAt,
        },
      });
    const old = await makeEvent('Completed Night', '2026-10-01T18:00:00Z');
    const current = await makeEvent('Current Night', '2026-11-01T18:00:00Z');
    expect(old.statusCode).toBe(201);
    expect(current.statusCode).toBe(201);
    const oldAggregate = await createV2Services().repos().events.getById(old.json().id);
    if (!oldAggregate) throw new Error('Expected seeded event');
    await createV2Services()
      .repos()
      .events.save({ ...oldAggregate, status: 'ended', version: oldAggregate.version + 1 });

    const response = await server.inject({
      method: 'GET',
      url: `/events/${current.json().id}/comparison`,
      headers: read,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      current: { eventId: current.json().id, status: 'current' },
      previous: [{ eventId: old.json().id, title: 'Completed Night', status: 'final' }],
    });
    await server.close();
  });
});
