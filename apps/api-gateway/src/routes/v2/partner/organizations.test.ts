import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, signInPartner, type Partner } from '../../../test-utils/app-harness.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B11: organizations route module ─────────────────────────────────────────
 * Thin-route behaviour end to end: create, read back, and the not-found shape.
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

describe('V2 partners organizations slice', () => {
  it('creates an organization and returns the canonical DTO', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/organizations',
      headers: { authorization: partner.bearer, 'idempotency-key': 'orgs-test-create' },
      payload: { name: 'Skyline Events', slug: 'skyline-events' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      name: 'Skyline Events',
      slug: 'skyline-events',
      role: 'owner',
      status: 'active',
      version: 1,
    });
    expect(typeof body.id).toBe('string');
  });

  it('rejects unknown body keys with 422 (strict body)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/organizations',
      headers: { authorization: partner.bearer, 'idempotency-key': 'orgs-test-strict' },
      payload: { name: 'X', slug: 'x-events', hackerField: 'leak' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
  });

  it('reads back the organization the caller belongs to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/organizations/${partner.organizationId}`,
      headers: partner.read(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: partner.organizationId, role: 'owner' });
  });

  it('lists only the caller’s own organizations', async () => {
    await signInPartner(app); // a second partner with their own org
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations',
      headers: partner.read(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(partner.organizationId);
  });

  it('GET one returns 403 for an organization the caller is not in', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/organizations/nope_1',
      headers: partner.read(),
    });
    // Membership is checked before existence — no oracle either way.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });
});
