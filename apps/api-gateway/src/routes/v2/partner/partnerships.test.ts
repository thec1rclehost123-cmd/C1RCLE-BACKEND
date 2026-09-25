import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerPartnershipRoutes from './partnerships.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── V2 partnerships slice over HTTP (Phase 1) ───────────────────────────────
 * The venue↔host graph. The new `venue-share` command is the focus: it must be
 * a party-only, active-only negotiation of the % the venue takes of each
 * settlement's gross — and the DTO must round-trip the negotiated value.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerPartnershipRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const write = (org: string) => ({
  'x-organization-id': org,
  'idempotency-key': `partner-key-${++keySeq}`,
});

/**
 * Two tenants — a host and the owner of a venue — plus a venue owned by the
 * latter. Used to open (and later act on) a host→venue partnership request.
 */
async function seedHostAndVenue(
  server: Server,
): Promise<{ host: string; venue: string; venueOrg: string }> {
  const hostCreated = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_host_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Host Co', slug: `host-co-${keySeq}` },
  });
  const host: string = hostCreated.json().id;

  const venueOrgCreated = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_venue_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Venue Co', slug: `venue-co-${keySeq}` },
  });
  const venueOrg: string = venueOrgCreated.json().id;

  const venueCreated = await server.inject({
    method: 'POST',
    url: `/organizations/${venueOrg}/venues`,
    headers: write(venueOrg),
    payload: { name: 'The Hall', slug: `the-hall-${keySeq}` },
  });
  const venue: string = venueCreated.json().id;
  return { host, venue, venueOrg };
}

async function activePartnership(
  server: Server,
  host: string,
  venue: string,
  venueOrg: string,
): Promise<string> {
  const requested = await server.inject({
    method: 'POST',
    url: '/partnerships',
    headers: write(host),
    payload: { venueId: venue, initiatedBy: 'host', venueShareRate: 20 },
  });
  expect(requested.statusCode).toBe(201);
  const partnershipId: string = requested.json().id;

  const approved = await server.inject({
    method: 'POST',
    url: `/partnerships/${partnershipId}/approve`,
    headers: write(venueOrg),
    payload: {},
  });
  expect(approved.statusCode).toBe(200);
  return partnershipId;
}

describe('partnerships over HTTP', () => {
  it('creates a partnership request carrying a proposed venue share', async () => {
    const server = await buildServer();
    const { host, venue } = await seedHostAndVenue(server);

    const requested = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(host),
      payload: { venueId: venue, initiatedBy: 'host', venueShareRate: 20 },
    });

    expect(requested.statusCode).toBe(201);
    expect(requested.json()).toMatchObject({
      status: 'pending',
      venueShareRate: 20,
      initiatedBy: 'host',
    });
    await server.close();
  });

  it('creates a partnership request without a venue share (rate null)', async () => {
    const server = await buildServer();
    const { host, venue } = await seedHostAndVenue(server);

    const requested = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(host),
      payload: { venueId: venue, initiatedBy: 'host' },
    });

    expect(requested.statusCode).toBe(201);
    expect(requested.json().venueShareRate).toBeNull();
    await server.close();
  });
});

describe('POST /partnerships/:partnershipId/venue-share', () => {
  it('lets either party negotiate the venue share on an active partnership', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    // Host sets 20 first...
    const fromHost = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(host),
      payload: { venueShareRate: 20 },
    });
    expect(fromHost.statusCode).toBe(200);
    expect(fromHost.json()).toMatchObject({ status: 'active', venueShareRate: 20 });

    // ...then the venue adjusts it. The DTO round-trips the value.
    const fromVenue = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(venueOrg),
      payload: { venueShareRate: 25 },
    });
    expect(fromVenue.statusCode).toBe(200);
    expect(fromVenue.json().venueShareRate).toBe(25);
    expect(fromVenue.json().version).toBeGreaterThan(fromHost.json().version);
    await server.close();
  });

  it('clears the venue share back to null', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const cleared = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(host),
      payload: { venueShareRate: null },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().venueShareRate).toBeNull();
    await server.close();
  });

  it('rejects a rate outside the 0..50 band with 422', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    for (const venueShareRate of [51, -1]) {
      const response = await server.inject({
        method: 'POST',
        url: `/partnerships/${partnershipId}/venue-share`,
        headers: write(host),
        payload: { venueShareRate },
      });
      expect(response.statusCode).toBe(422);
    }
    await server.close();
  });

  it('rejects a non-integer rate with 422', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(host),
      payload: { venueShareRate: 20.5 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('rejects a rate with a missing body field via 422 (strict body)', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(host),
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('rejects a stranger setting the rate with 404 (non-party == not-found)', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write('org_stranger_seed'),
      payload: { venueShareRate: 20 },
    });

    // `fetchParty` treats any non-party as not-found (404) so a caller cannot
    // distinguish "exists but not yours" from "does not exist" — an id oracle
    // mitigation.
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('rejects setting a rate before the partnership is active', async () => {
    const server = await buildServer();
    const { host, venue } = await seedHostAndVenue(server);

    const requested = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(host),
      payload: { venueId: venue, initiatedBy: 'host' },
    });
    const partnershipId: string = requested.json().id;

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers: write(host),
      payload: { venueShareRate: 20 },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('is idempotent: replaying the same key returns the same negotiation', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);
    const headers = write(host);

    const first = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers,
      payload: { venueShareRate: 30 },
    });
    expect(first.statusCode).toBe(200);

    const replay = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers,
      payload: { venueShareRate: 30 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().venueShareRate).toBe(30);
    await server.close();
  });
});
