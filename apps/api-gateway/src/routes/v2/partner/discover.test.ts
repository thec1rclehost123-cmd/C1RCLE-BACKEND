import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerDiscoveryRoutes from './discover.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerPartnershipRoutes from './partnerships.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Partner discovery over HTTP ────────────────────────────────────────────
 *
 * The dashboard's Discover tab called this path before the route existed and
 * read every 404 as "no partners" — the tab was empty by construction. These
 * tests pin the browse contract: real orgs/venues, self excluded, live
 * counterparts excluded, kind + search filters.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerPartnershipRoutes,
      partnerDiscoveryRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({
  ...read(org),
  'idempotency-key': `dsc-key-${++keySeq}`,
});

async function createOrganization(server: Server, name: string): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

async function createVenue(server: Server, org: string, name: string): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

describe('partner discovery', () => {
  it('lists other organizations as host candidates, excluding self', async () => {
    const server = await buildServer();
    const mine = await createOrganization(server, 'My Venue Org');
    const hostOrg = await createOrganization(server, 'Night Owls');

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${mine}/discover-partners?type=host&limit=20`,
      headers: read(mine),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = body.items.map((item: { organizationId: string }) => item.organizationId);
    expect(ids).toContain(hostOrg);
    expect(ids).not.toContain(mine);
    expect(body.items[0]).toMatchObject({ kind: 'host', name: 'Night Owls' });
    await server.close();
  });

  it('lists other orgs venues as venue candidates with the partnership key', async () => {
    const server = await buildServer();
    const mine = await createOrganization(server, 'My Host Org');
    const venueOrg = await createOrganization(server, 'Venue Owner');
    const venueId = await createVenue(server, venueOrg, 'Sky Bar');

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${mine}/discover-partners?type=venue&limit=20`,
      headers: read(mine),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toMatchObject([
      {
        id: venueId,
        kind: 'venue',
        name: 'Sky Bar',
        organizationId: venueOrg,
        venueId,
      },
    ]);
    await server.close();
  });

  it('hides counterparts with a live partnership', async () => {
    const server = await buildServer();
    const venueOrg = await createOrganization(server, 'Venue Org');
    const venueId = await createVenue(server, venueOrg, 'Sky Bar');
    const hostOrg = await createOrganization(server, 'Host Org');

    await server.inject({
      method: 'POST',
      url: '/partnerships',
      headers: write(hostOrg),
      payload: { venueId, initiatedBy: 'host' },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${venueOrg}/discover-partners?type=host&limit=20`,
      headers: read(venueOrg),
    });

    expect(response.statusCode).toBe(200);
    const ids = response
      .json()
      .items.map((item: { organizationId: string }) => item.organizationId);
    expect(ids).not.toContain(hostOrg);
    await server.close();
  });

  it('filters by search text', async () => {
    // NOTE: names are unique per test — the memory driver is memoized per
    // process, so orgs created by earlier tests in this file are still
    // browseable here.
    const server = await buildServer();
    const mine = await createOrganization(server, 'Search Base');
    await createOrganization(server, 'Velvet Owls Search');
    await createOrganization(server, 'Daydreamers Search');

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${mine}/discover-partners?q=velvet%20owls&limit=20`,
      headers: read(mine),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { name: string }) => item.name)).toEqual([
      'Velvet Owls Search',
    ]);
    await server.close();
  });

  it('refuses to browse for an organization the caller is not in', async () => {
    const server = await buildServer();
    const mine = await createOrganization(server, 'My Org');
    const stranger = await createOrganization(server, 'Stranger Org');

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${stranger}/discover-partners?limit=20`,
      headers: read(mine),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('422s without the organization header', async () => {
    const server = await buildServer();
    const mine = await createOrganization(server, 'My Org');

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${mine}/discover-partners?limit=20`,
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });
});
