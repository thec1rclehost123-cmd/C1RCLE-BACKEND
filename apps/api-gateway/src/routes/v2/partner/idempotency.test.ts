import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import validateV2Plugin from '../../../plugins/validate-v2.js';

import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

async function buildOrgServer() {
  const server = Fastify({ logger: false });
  await server.register(validateV2Plugin);
  await server.register(partnerOrganizationRoutes);
  return server;
}

async function buildVenueServer() {
  const server = Fastify({ logger: false });
  await server.register(validateV2Plugin);
  await server.register(partnerVenueRoutes);
  return server;
}

const HEADERS = (key: string) => ({
  'x-organization-id': 'org_1',
  'idempotency-key': key,
});

/**
 * ─── B08 — Idempotency-Key + If-Match (T09/T10) ─────────────────────────────
 * Exit gate: retries never duplicate results; no lost updates.
 */
describe('V2 idempotency + optimistic locking (B08)', () => {
  describe('Idempotency-Key', () => {
    it('POST create without idempotency-key → 422 validation', async () => {
      const server = await buildOrgServer();
      const response = await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: { 'x-organization-id': 'org_1' },
        payload: { name: 'X Events', slug: 'x-events' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
      await server.close();
    });

    it('duplicate request → identical response, no second write (replay)', async () => {
      const server = await buildOrgServer();
      const payload = { name: 'Replay Events', slug: 'replay-events' };
      const first = await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-replay-1'),
        payload,
      });
      expect(first.statusCode).toBe(201);
      const second = await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-replay-1'),
        payload,
      });
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      const list = await server.inject({
        method: 'GET',
        url: '/organizations',
        headers: { 'x-organization-id': 'org_1' },
      });
      const items = list.json().items ?? [];
      expect(items.filter((o: { slug: string }) => o.slug === 'replay-events')).toHaveLength(1);
      await server.close();
    });

    it('key reused with a different body → 409 conflict', async () => {
      const server = await buildOrgServer();
      const payload = { name: 'Conflict Events', slug: 'conflict-events' };
      await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-conflict-1'),
        payload,
      });
      const second = await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-conflict-1'),
        payload: { name: 'Different Name', slug: 'different-slug' },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: 'conflict', status: 409 });
      await server.close();
    });

    it('concurrent same-key → one winner (in-flight → 409, then success)', async () => {
      const server = await buildOrgServer();
      const payload = { name: 'Race Events', slug: 'race-events' };
      const first = server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-race-1'),
        payload,
      });
      // Second attempt arrives while the first is still in flight.
      const second = await server.inject({
        method: 'POST',
        url: '/organizations',
        headers: HEADERS('idem-race-1'),
        payload,
      });
      const [firstResult] = await Promise.all([first]);
      expect(firstResult.statusCode).toBe(201);
      expect([201, 409]).toContain(second.statusCode);
      const list = await server.inject({
        method: 'GET',
        url: '/organizations',
        headers: { 'x-organization-id': 'org_1' },
      });
      const items = list.json().items ?? [];
      expect(items.filter((o: { slug: string }) => o.slug === 'race-events')).toHaveLength(1);
      await server.close();
    });
  });

  describe('If-Match optimistic locking', () => {
    it('PATCH without If-Match → 422 validation', async () => {
      const server = await buildVenueServer();
      const create = await server.inject({
        method: 'POST',
        url: '/organizations/org_1/venues',
        headers: HEADERS('idem-venue-1'),
        payload: { name: 'Grand Hall', slug: 'grand-hall' },
      });
      expect(create.statusCode).toBe(201);
      const venueId = create.json().id as string;
      const response = await server.inject({
        method: 'PATCH',
        url: `/venues/${venueId}`,
        headers: { 'x-organization-id': 'org_1', 'idempotency-key': 'idem-venue-patch-1' },
        payload: { public: { name: 'Grand Hall II' } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().fieldErrors).toHaveProperty('if-match');
      await server.close();
    });

    it('stale version → 409 with current version; retry after refetch succeeds', async () => {
      const server = await buildVenueServer();
      const create = await server.inject({
        method: 'POST',
        url: '/organizations/org_1/venues',
        headers: HEADERS('idem-venue-2'),
        payload: { name: 'Skyline Arena', slug: 'skyline-arena' },
      });
      const venueId = create.json().id as string;

      const stale = await server.inject({
        method: 'PATCH',
        url: `/venues/${venueId}`,
        headers: {
          'x-organization-id': 'org_1',
          'idempotency-key': 'idem-venue-patch-2',
          'if-match': '999',
        },
        payload: { public: { name: 'Stale Rename' } },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'conflict', details: { currentVersion: 1 } });

      // Refetch (fresh version) then retry succeeds.
      const refetch = await server.inject({
        method: 'GET',
        url: `/venues/${venueId}`,
        headers: { 'x-organization-id': 'org_1' },
      });
      const currentVersion = refetch.json().version as number;
      const retry = await server.inject({
        method: 'PATCH',
        url: `/venues/${venueId}`,
        headers: {
          'x-organization-id': 'org_1',
          'idempotency-key': 'idem-venue-patch-3',
          'if-match': String(currentVersion),
        },
        payload: { public: { name: 'Fresh Rename' } },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ name: 'Fresh Rename', version: currentVersion + 1 });
      await server.close();
    });
  });
});
