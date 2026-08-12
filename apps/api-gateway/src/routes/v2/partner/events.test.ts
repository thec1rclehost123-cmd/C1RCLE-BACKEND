import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestApp, signInPartner, type Partner } from '../../../test-utils/app-harness.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── B05: the four validation layers, behind the real auth stack ─────────────
 * body · params · query · headers, each failing as 422 with `fieldErrors`,
 * plus a create whose response passes the response schema.
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

describe('V2 partners events slice — validation layers', () => {
  it('rejects bad body with 422 + fieldErrors (body layer)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/events',
      headers: partner.write(),
      payload: { title: '', venueId: 'bad id!', startAt: 'not-a-date' },
    });
    const body = response.json();
    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('validation');
    expect(body.status).toBe(422);
    expect(body.fieldErrors).toHaveProperty('title');
    expect(body.fieldErrors).toHaveProperty('venueId');
    expect(body.fieldErrors).toHaveProperty('startAt');
  });

  it('rejects unknown body keys with 422 (strict body)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/events',
      headers: partner.write(),
      payload: {
        title: 'Night',
        venueId: 'ven_1',
        startAt: '2026-08-01T18:00:00Z',
        hackerField: 'leak',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
  });

  it('rejects bad params with 422 + fieldErrors (params layer)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/events/not@valid',
      headers: partner.read(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('eventId');
  });

  it('rejects bad query with 422 + fieldErrors (query layer)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/events?limit=9999',
      headers: partner.read(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('limit');
  });

  it('rejects a missing organization header with 403 before any validation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/events',
      headers: { authorization: partner.bearer },
      payload: {},
    });
    // Tenancy is resolved before the payload is even looked at.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
  });

  it('creates an event and returns a response that passes the response schema', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/events',
      headers: partner.write(),
      payload: { title: 'Sky Night', venueId: 'ven_1', startAt: '2026-08-01T18:00:00Z' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Sky Night',
      organizationId: partner.organizationId,
      status: 'draft',
      isPublic: false,
      version: 1,
    });
    expect(typeof body.id).toBe('string');
  });

  it('GET one returns 404 with V2 shape for unknown id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/partner/events/nope_1',
      headers: partner.read(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
  });
});
