import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerOrganizationRoutes from './organizations.js';
import partnerPartnershipRoutes from './partnerships.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Partnerships over HTTP (Phase 1) ────────────────────────────────────────
 *
 * The interesting cases are the two v1 behaviours this port deliberately
 * tightened: a requester could approve their own request, and `blocked` could
 * be silently undone by a later approve.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [partnerOrganizationRoutes, partnerVenueRoutes, partnerPartnershipRoutes],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({
  ...read(org),
  'idempotency-key': `ptn-key-${++keySeq}`,
});

async function createOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Org', slug: `org-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

async function createVenue(server: Server, org: string): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${++keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

/** A venue owned by one org, and a second org that will play the host. */
async function twoParties(server: Server) {
  const venueOrg = await createOrganization(server);
  const venueId = await createVenue(server, venueOrg);
  const hostOrg = await createOrganization(server);
  return { venueOrg, venueId, hostOrg };
}

describe('requesting a partnership', () => {
  it('opens a pending request from the host side', async () => {
    const server = await buildServer();
    const { venueId, hostOrg } = await twoParties(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload: { venueId, initiatedBy: 'host', message: 'Friday nights?' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'pending',
      initiatedBy: 'host',
      hostOrganizationId: hostOrg,
      venueId,
      message: 'Friday nights?',
    });
    await server.close();
  });

  it('resolves the venue’s owning organization server-side', async () => {
    const server = await buildServer();
    const { venueOrg, venueId, hostOrg } = await twoParties(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload: { venueId, initiatedBy: 'host' },
    });

    // The client never sent venueOrganizationId — it comes from the venue.
    expect(response.json().venueOrganizationId).toBe(venueOrg);
    await server.close();
  });

  it('refuses a venue-initiated request from someone who does not own the venue', async () => {
    const server = await buildServer();
    const { venueId, hostOrg } = await twoParties(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload: { venueId, initiatedBy: 'venue' },
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('refuses a second live request for the same pair', async () => {
    const server = await buildServer();
    const { venueId, hostOrg } = await twoParties(server);
    const payload = { venueId, initiatedBy: 'host' as const };

    await server.inject({ method: 'POST', url: '/partnerships', headers: write(hostOrg), payload });
    const second = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload,
    });

    // One live relationship per pair, so approving is never ambiguous.
    expect(second.statusCode).toBe(400);
    await server.close();
  });

  it('404s an unknown venue', async () => {
    const server = await buildServer();
    const hostOrg = await createOrganization(server);

    const response = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload: { venueId: 'ven_nope', initiatedBy: 'host' },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('answering a request', () => {
  async function pendingRequest(server: Server) {
    const parties = await twoParties(server);
    const created = await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(parties.hostOrg),
      payload: { venueId: parties.venueId, initiatedBy: 'host' },
    });
    const id: string = created.json().id;
    return { ...parties, partnershipId: id };
  }

  it('lets the venue (the counterparty) approve', async () => {
    const server = await buildServer();
    const { venueOrg, partnershipId } = await pendingRequest(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/approve`,
      headers: write(venueOrg),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'active' });
    await server.close();
  });

  it('refuses to let the REQUESTER approve their own request', async () => {
    const server = await buildServer();
    const { hostOrg, partnershipId } = await pendingRequest(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/approve`,
      headers: write(hostOrg),
    });

    // v1 only checked "are you a party", which allowed exactly this.
    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('records a rejection reason', async () => {
    const server = await buildServer();
    const { venueOrg, partnershipId } = await pendingRequest(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/reject`,
      headers: write(venueOrg),
      payload: { reason: 'Fully booked' },
    });

    expect(response.json()).toMatchObject({
      status: 'rejected',
      resolutionReason: 'Fully booked',
    });
    await server.close();
  });

  it('treats a block as terminal — a later approve cannot undo it', async () => {
    const server = await buildServer();
    const { venueOrg, partnershipId } = await pendingRequest(server);

    await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/block`,
      headers: write(venueOrg),
      payload: { reason: 'Spam' },
    });
    const approve = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/approve`,
      headers: write(venueOrg),
    });

    // v1's statusMap would have happily written `active` over `blocked`.
    expect(approve.statusCode).toBe(409);
    await server.close();
  });

  it('hides a partnership between two other organizations', async () => {
    const server = await buildServer();
    const { partnershipId } = await pendingRequest(server);
    const stranger = await createOrganization(server);

    const response = await server.inject({
      method: 'POST',
      url: `/partnerships/${partnershipId}/approve`,
      headers: write(stranger),
    });

    // Not-found rather than forbidden: a stranger learns nothing about it.
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('lists partnerships from either side of the graph', async () => {
    const server = await buildServer();
    const { hostOrg, venueOrg } = await pendingRequest(server);

    const fromHost = await server.inject({
      method: 'GET',
      url: `/organizations/${hostOrg}/partnerships`,
      headers: read(hostOrg),
    });
    const fromVenue = await server.inject({
      method: 'GET',
      url: `/organizations/${venueOrg}/partnerships`,
      headers: read(venueOrg),
    });

    expect(fromHost.json().items).toHaveLength(1);
    expect(fromVenue.json().items).toHaveLength(1);
    await server.close();
  });
});
