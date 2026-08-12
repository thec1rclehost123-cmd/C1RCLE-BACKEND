import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, signInPartner, type Partner } from '../../../test-utils/app-harness.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B08 / T10: optimistic locking ───────────────────────────────────────────
 * The exit gate: concurrent updates produce one winner, one 409, and the loser
 * succeeds after refetching. `If-Match` is the only version authority.
 */

let app: FastifyInstance;
let partner: Partner;

beforeEach(async () => {
  app = await buildTestApp();
  partner = await signInPartner(app);
});

afterEach(async () => {
  await app.close();
});

async function createVenue(slug: string): Promise<{ id: string; version: number }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v2/partner/organizations/${partner.organizationId}/venues`,
    headers: partner.write(),
    payload: { name: slug, slug },
  });
  return response.json();
}

const patch = (
  venueId: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) => app.inject({ method: 'PATCH', url: `/api/v2/partner/venues/${venueId}`, headers, payload });

describe('V2 partner venues — optimistic locking', () => {
  it('requires If-Match on PATCH (422 + fieldErrors)', async () => {
    const venue = await createVenue('lock-required');
    const response = await patch(venue.id, partner.write(), { public: { name: 'Renamed' } });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('if-match');
  });

  it('accepts a matching version and bumps it', async () => {
    const venue = await createVenue('lock-happy');
    const response = await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'Renamed Once' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Renamed Once', version: venue.version + 1 });
  });

  it('rejects a stale version with 409 carrying the current version', async () => {
    const venue = await createVenue('lock-stale');

    await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'Winner' },
    });
    const stale = await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'Loser' },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'conflict',
      status: 409,
      details: { expectedVersion: venue.version, currentVersion: venue.version + 1 },
    });

    // The losing write must not have landed.
    const current = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/venues/${venue.id}`,
      headers: partner.read(),
    });
    expect(current.json()).toMatchObject({ name: 'Winner' });
  });

  it('lets the loser succeed after refetching the current version', async () => {
    const venue = await createVenue('lock-recover');

    await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'First Writer' },
    });
    const conflict = await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'Second Writer' },
    });
    expect(conflict.statusCode).toBe(409);

    // Refetch → retry with the fresh version.
    const refetched = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/venues/${venue.id}`,
      headers: partner.read(),
    });
    const current: { version: number } = refetched.json();

    const retried = await patch(venue.id, partner.write({ 'if-match': String(current.version) }), {
      public: { name: 'Second Writer' },
    });

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      name: 'Second Writer',
      version: current.version + 1,
    });
  });

  it('rejects a version supplied in the body — the header is the only authority', async () => {
    const venue = await createVenue('lock-body-version');
    const response = await patch(venue.id, partner.write({ 'if-match': String(venue.version) }), {
      public: { name: 'Renamed' },
      version: 99,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
  });
});
