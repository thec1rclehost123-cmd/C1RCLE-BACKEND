import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventCatalogRoutes from './event-catalog.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Event catalog over HTTP (Phase 3) ───────────────────────────────────────
 * The services were built and tested long ago; only routes were missing. These
 * assert the transport contract — serialization, tenancy, idempotency — rather
 * than re-testing catalog rules already covered in `packages/core`.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;

const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({
  ...read(org),
  'idempotency-key': `catalog-key-${++keySeq}`,
});

/** Creates org → venue → event and returns the ids every catalog route needs. */
async function seed(server: Server): Promise<{ org: string; eventId: string }> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const org: string = created.json().id;

  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  const venueId: string = venue.json().id;

  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  return { org, eventId };
}

describe('ticket tiers', () => {
  it('creates a tier and lists it back', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'Early Bird', priceInPaise: 150_000, quantity: 100 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Early Bird',
      // Money stays integer paise on the wire, never rupees.
      priceInPaise: 150_000,
      quantity: 100,
      eventId,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });

  it('rejects a negative price at the schema boundary', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'Broken', priceInPaise: -1, quantity: 10 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('priceInPaise');
    await server.close();
  });

  it('requires an idempotency key like every other write', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
      payload: { name: 'No Key', priceInPaise: 1000, quantity: 1 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
    await server.close();
  });

  it('replays a repeated create instead of making a second tier', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const headers = write(org);
    const payload = { name: 'Replayed', priceInPaise: 5000, quantity: 5 };

    const first = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers,
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ id: first.json().id });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
    });
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });

  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const { org } = await seed(server);

    const response = await server.inject({
      method: 'GET',
      url: '/events/evt_someone_else/ticket-tiers',
      headers: read(org),
    });

    // Never confirms whether that event exists.
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('promo codes', () => {
  it('creates a percent promo and pages the list', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promo-codes`,
      headers: write(org),
      payload: { code: 'early25', discountType: 'percent', discountValue: 25 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      // v1 normalizes codes to uppercase so `early25` and `EARLY25` are one code.
      code: 'EARLY25',
      discountType: 'percent',
      discountValue: 25,
      redemptionCount: 0,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promo-codes`,
      headers: read(org),
    });
    expect(listed.json()).toMatchObject({ pageInfo: { total: 1 } });
    await server.close();
  });

  it('rejects an unknown discount type', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promo-codes`,
      headers: write(org),
      payload: { code: 'BAD', discountType: 'buy-one-get-one', discountValue: 1 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });
});

describe('table packages', () => {
  it('creates a table package with integer-paise money', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/table-packages`,
      headers: write(org),
      payload: { name: 'VIP Booth', capacity: 6, pricePaise: 2_500_000, minSpendPaise: 1_000_000 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'VIP Booth',
      capacity: 6,
      pricePaise: 2_500_000,
      minSpendPaise: 1_000_000,
    });
    await server.close();
  });

  it('rejects a zero capacity — a table nobody can sit at is not a package', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/table-packages`,
      headers: write(org),
      payload: { name: 'Phantom', capacity: 0, pricePaise: 1000 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });
});

describe('promoter assignments', () => {
  it('freezes the commission terms into the assignment', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_1', ratePercent: 18 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      promoterId: 'promoter_1',
      status: 'active',
      // Frozen at assignment time so a later rate change cannot rewrite what a
      // past order earned.
      terms: { ratePercent: 18, flatPaise: 0, version: 1 },
    });
    await server.close();
  });

  it('defaults to v1’s 15% when no rate is supplied', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_2' },
    });

    expect(created.json().terms.ratePercent).toBe(15);
    await server.close();
  });

  it('rejects a rate above 100 percent', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_3', ratePercent: 150 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('ends an assignment without deleting the record of it', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_4' },
    });
    const assignmentId = created.json().id;

    const ended = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignmentId}/end`,
      headers: write(org),
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ status: 'ended' });
    expect(ended.json().endedAt).not.toBeNull();

    // Still listed: the assignment is history, not a deletion.
    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoter-assignments`,
      headers: read(org),
    });
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });
});
