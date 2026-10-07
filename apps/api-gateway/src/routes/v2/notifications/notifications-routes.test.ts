import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerOrganizationRoutes from '../partner/organizations.js';
import partnerPartnershipRoutes from '../partner/partnerships.js';
import promoterConnectionRoutes from '../partner/promoter-connections.js';
import partnerVenueRoutes from '../partner/venues.js';

import notificationRoutes from './notifications-routes.js';

/**
 * ─── V2 partner notifications (inbox) over HTTP ─────────────────────────────
 * Recipients are organizations, so every assertion holds the recipient's
 * own org in the `x-organization-id` header — a stranger's org reads the
 * that inbox as forbidden or not-found, never as a leak.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerPartnershipRoutes,
      promoterConnectionRoutes,
      notificationRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({ ...read(org), 'idempotency-key': `n-key-${++keySeq}` });

async function createOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: write('org_seed'),
    payload: { name: 'Org', slug: `n-org-${++keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

async function createVenue(server: Server, org: string): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'N Bar', slug: `n-venue-${++keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

/** A promoter org opening a connection to a venue org. */
async function connectionRequest(server: Server, promoter: string, target: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/promoter-connections',
    headers: write(promoter),
    payload: { counterpartyId: target, targetType: 'venue', initiatedBy: 'promoter' },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

/** A host org requesting a partnership with a venue. */
async function partnershipRequest(server: Server, hostOrg: string, venueId: string) {
  const response = await server.inject({
    method: 'POST',
    url: '/partnerships',
    headers: write(hostOrg),
    payload: { venueId, initiatedBy: 'host', message: 'Friday nights?' },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function inbox(server: Server, org: string) {
  const response = await server.inject({
    method: 'GET',
    url: `/organizations/${org}/notifications`,
    headers: read(org),
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('producers', () => {
  it('routes a promoter connection request into the target org inbox', async () => {
    const server = await buildServer();
    const promoter = await createOrganization(server);
    const target = await createOrganization(server);
    await connectionRequest(server, promoter, target);

    const page = await inbox(server, target);
    expect(page.unreadCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      recipientId: target,
      recipientType: 'venue',
      type: 'promoter_connection.requested',
      read: false,
      action: { resourceType: 'promoter_connection', resourceId: expect.any(String) },
    });
    await server.close();
  });

  it('routes a partnership request into the venue org inbox', async () => {
    const server = await buildServer();
    const venueOrg = await createOrganization(server);
    const venueId = await createVenue(server, venueOrg);
    const hostOrg = await createOrganization(server);
    await partnershipRequest(server, hostOrg, venueId);

    const page = await inbox(server, venueOrg);
    expect(page.unreadCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      recipientId: venueOrg,
      recipientType: 'venue',
      type: 'partnership.requested',
      action: { resourceType: 'partnership', resourceId: expect.any(String) },
    });
    await server.close();
  });
});

describe('inbox access', () => {
  it('only the recipient org can read the inbox', async () => {
    const server = await buildServer();
    const promoter = await createOrganization(server);
    const target = await createOrganization(server);
    await connectionRequest(server, promoter, target);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${target}/notifications`,
      headers: read(promoter),
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('treats a foreign org as not-found on single read', async () => {
    const server = await buildServer();
    const promoter = await createOrganization(server);
    const target = await createOrganization(server);
    await connectionRequest(server, promoter, target);
    const page = await inbox(server, target);
    const { id } = page.items[0];

    const stranger = await createOrganization(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/organizations/${stranger}/notifications/${id}/read`,
      headers: read(stranger),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});

describe('marking read', () => {
  it('marks one notification read idempotently and drops unreadCount', async () => {
    const server = await buildServer();
    const promoter = await createOrganization(server);
    const target = await createOrganization(server);
    await connectionRequest(server, promoter, target);
    const page = await inbox(server, target);
    const { id } = page.items[0];

    const mark = await server.inject({
      method: 'PATCH',
      url: `/organizations/${target}/notifications/${id}/read`,
      headers: read(target),
    });
    expect(mark.statusCode).toBe(200);
    expect(mark.json()).toMatchObject({ id, read: true });

    const again = await server.inject({
      method: 'PATCH',
      url: `/organizations/${target}/notifications/${id}/read`,
      headers: read(target),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id, read: true });

    const after = await inbox(server, target);
    expect(after.unreadCount).toBe(0);
    await server.close();
  });

  it('read-all clears every notification for the org in one call', async () => {
    const server = await buildServer();
    const venueOrg = await createOrganization(server);
    const venueId = await createVenue(server, venueOrg);
    const hostA = await createOrganization(server);
    const hostB = await createOrganization(server);
    await partnershipRequest(server, hostA, venueId);
    await partnershipRequest(server, hostB, venueId);

    const response = await server.inject({
      method: 'PATCH',
      url: `/organizations/${venueOrg}/notifications/read-all`,
      headers: write(venueOrg),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ selected: 2 });

    const after = await inbox(server, venueOrg);
    expect(after.unreadCount).toBe(0);
    await server.close();
  });
});

describe('quick actions', () => {
  it('approves a promoter connection from the inbox and marks it read', async () => {
    const server = await buildServer();
    const promoter = await createOrganization(server);
    const target = await createOrganization(server);
    await connectionRequest(server, promoter, target);
    const page = await inbox(server, target);
    const { id } = page.items[0];

    const respond = await server.inject({
      method: 'POST',
      url: `/organizations/${target}/notifications/${id}/actions`,
      headers: write(target),
      payload: { decision: 'approve' },
    });
    expect(respond.statusCode).toBe(200);
    expect(respond.json()).toMatchObject({
      id,
      read: true,
      action: { resourceType: 'promoter_connection' },
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/organizations/${target}/promoter-connections`,
      headers: read(target),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ status: 'active' }] });
    await server.close();
  });

  it('rejects a partnership from the inbox and marks it read', async () => {
    const server = await buildServer();
    const venueOrg = await createOrganization(server);
    const venueId = await createVenue(server, venueOrg);
    const hostOrg = await createOrganization(server);
    await partnershipRequest(server, hostOrg, venueId);
    const page = await inbox(server, venueOrg);
    const { id } = page.items[0];

    const respond = await server.inject({
      method: 'POST',
      url: `/organizations/${venueOrg}/notifications/${id}/actions`,
      headers: write(venueOrg),
      payload: { decision: 'reject' },
    });
    expect(respond.statusCode).toBe(200);
    expect(respond.json()).toMatchObject({ id, read: true });

    const listed = await server.inject({
      method: 'GET',
      url: `/organizations/${venueOrg}/partnerships`,
      headers: read(venueOrg),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ items: [{ status: 'rejected' }] });
    await server.close();
  });
});
