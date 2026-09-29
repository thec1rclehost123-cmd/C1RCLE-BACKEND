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
const read = (org: string) => ({ 'x-organization-id': org });

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
    headers: {
      'x-organization-id': 'org_host_seed',
      'idempotency-key': `seed-${++keySeq}`,
    },
    payload: { name: 'Host Co', slug: `host-co-${keySeq}` },
  });
  const host: string = hostCreated.json().id;

  const venueOrgCreated = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: {
      'x-organization-id': 'org_venue_seed',
      'idempotency-key': `seed-${++keySeq}`,
    },
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

/**
 * A pending host-initiated request (never approved). Withdraw/answer tests
 * start here so they never depend on the approval path.
 */
async function pendingHostRequest(
  server: Server,
): Promise<{ host: string; venue: string; venueOrg: string; partnershipId: string }> {
  const { host, venue, venueOrg } = await seedHostAndVenue(server);
  const requested = await server.inject({
    method: 'POST',
    url: '/partnerships',
    headers: write(host),
    payload: { venueId: venue, initiatedBy: 'host' },
  });
  expect(requested.statusCode).toBe(201);
  const partnershipId: string = requested.json().id;
  return { host, venue, venueOrg, partnershipId };
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

  it('opens a pending request from the venue side', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(venueOrg),
      payload: { venueId: venue, initiatedBy: 'venue', hostOrganizationId: host },
    });

    // The route used to drop `hostOrganizationId` before calling the service,
    // so every venue invite failed as "cannot partner with itself".
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'pending',
      initiatedBy: 'venue',
      hostOrganizationId: host,
      venueOrganizationId: venueOrg,
      venueId: venue,
    });
    await server.close();
  });

  it('422s a venue-initiated request without hostOrganizationId', async () => {
    const server = await buildServer();
    const { venue, venueOrg } = await seedHostAndVenue(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(venueOrg),
      payload: { venueId: venue, initiatedBy: 'venue' },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('opens a pending request from the venue side', async () => {
    const server = await buildServer();
    const { venueOrg, venueId, hostOrg } = await twoParties(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(venueOrg),
      payload: { venueId, initiatedBy: 'venue', hostOrganizationId: hostOrg },
    });

    // The route used to drop `hostOrganizationId` before calling the service,
    // so every venue invite failed as "cannot partner with itself".
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'pending',
      initiatedBy: 'venue',
      hostOrganizationId: hostOrg,
      venueOrganizationId: venueOrg,
      venueId,
    });
    await server.close();
  });

  it('422s a venue-initiated request without hostOrganizationId', async () => {
    const server = await buildServer();
    const { venueOrg, venueId } = await twoParties(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(venueOrg),
      payload: { venueId, initiatedBy: 'venue' },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('refuses a venue-initiated request from someone who does not own the venue', async () => {
    const server = await buildServer();
    const { host, venue } = await seedHostAndVenue(server);

    // The host does not own the venue, so inviting "as the venue" is forbidden.
    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(host),
      payload: { venueId: venue, initiatedBy: 'venue', hostOrganizationId: host },
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('negotiates the venue share on an active partnership', async () => {
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

  it('lets the requester withdraw a pending request', async () => {
    const server = await buildServer();
    const { host, partnershipId } = await pendingHostRequest(server);

    // The legacy Sent tab offers "Cancel request", which posts to `end`.
    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/end`,
      headers: write(host),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ended' });
    await server.close();
  });

  it('refuses the counterparty ending a pending request instead of answering it', async () => {
    const server = await buildServer();
    const { venueOrg, partnershipId } = await pendingHostRequest(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/end`,
      headers: write(venueOrg),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('lets the requester withdraw a pending request', async () => {
    const server = await buildServer();
    const { hostOrg, partnershipId } = await pendingRequest(server);

    // The legacy Sent tab offers "Cancel request", which posts to `end`.
    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/end`,
      headers: write(hostOrg),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ended' });
    await server.close();
  });

  it('refuses the counterparty ending a pending request instead of answering it', async () => {
    const server = await buildServer();
    const { venueOrg, partnershipId } = await pendingRequest(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/end`,
      headers: write(venueOrg),
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('treats a block as terminal — a later approve cannot undo it', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const blocked = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/block`,
      headers: write(venueOrg),
      payload: {},
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ status: 'blocked' });

    // The counterparty approved the original request, so it may call approve —
    // the FSM still refuses the blocked → active edge (409, not a silent undo).
    const undone = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/approve`,
      headers: write(venueOrg),
      payload: {},
    });
    expect(undone.statusCode).toBe(409);
    await server.close();
  });

  it('rejects setting the venue share on a pending partnership with 400', async () => {
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

    const second = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/venue-share`,
      headers,
      payload: { venueShareRate: 30 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    await server.close();
  });

  it('lists partnerships from either side with resolved display names', async () => {
    const server = await buildServer();
    const { host, venue, venueOrg } = await seedHostAndVenue(server);
    const partnershipId = await activePartnership(server, host, venue, venueOrg);

    const fromHost = await server.inject({
      method: 'GET',
      url: `/organizations/${host}/partnerships`,
      headers: read(host),
    });
    const fromVenue = await server.inject({
      method: 'GET',
      url: `/organizations/${venueOrg}/partnerships`,
      headers: read(venueOrg),
    });

    expect(fromHost.statusCode).toBe(200);
    expect(fromVenue.statusCode).toBe(200);
    expect(fromHost.json().items).toHaveLength(1);
    expect(fromVenue.json().items).toHaveLength(1);
    expect(fromHost.json().items[0].id).toBe(partnershipId);
    expect(fromVenue.json().items[0].id).toBe(partnershipId);
    // Display names are resolved server-side — the UI must never fall back
    // to `Host A1B2C3` ID labels when the data exists.
    expect(fromVenue.json().items[0].hostName).toBe('Host Co');
    expect(fromHost.json().items[0].venueName).toBe('The Hall');
    expect(fromHost.json().items[0].venueId).toBe(venue);
    await server.close();
  });
});
