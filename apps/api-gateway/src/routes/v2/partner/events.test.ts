import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import validateV2Plugin from '../../../plugins/validate-v2.js';

import partnerEventRoutes from './events.js';

async function buildServer() {
  const server = Fastify({ logger: false });
  await server.register(validateV2Plugin);
  await server.register(partnerEventRoutes);
  return server;
}

const VALID_HEADERS = { 'x-organization-id': 'org_1' };
const CREATE_HEADERS = { 'x-organization-id': 'org_1', 'idempotency-key': 'idem-event-1' };

describe('V2 partners events slice — validation layers', () => {
  it('rejects bad body with 422 + fieldErrors (body layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: CREATE_HEADERS,
      payload: { title: '', venueId: 'bad id!', startAt: 'not-a-date' },
    });
    const body = response.json();
    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('validation');
    expect(body.status).toBe(422);
    expect(body.fieldErrors).toHaveProperty('title');
    expect(body.fieldErrors).toHaveProperty('venueId');
    expect(body.fieldErrors).toHaveProperty('startAt');
    await server.close();
  });

  it('rejects unknown body keys with 422 (strict body)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: CREATE_HEADERS,
      payload: {
        title: 'Night',
        venueId: 'ven_1',
        startAt: '2026-08-01T18:00:00Z',
        hackerField: 'leak',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
    await server.close();
  });

  it('rejects bad params with 422 + fieldErrors (params layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/events/not@valid',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('eventId');
    await server.close();
  });

  it('rejects bad query with 422 + fieldErrors (query layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/org_1/events?limit=9999',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('limit');
    await server.close();
  });

  it('rejects missing/bad headers with 422 + fieldErrors (headers layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('x-organization-id');
    await server.close();
  });

  it('creates an event and returns a response that passes the response schema', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: CREATE_HEADERS,
      payload: { title: 'Sky Night', venueId: 'ven_1', startAt: '2026-08-01T18:00:00Z' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Sky Night',
      organizationId: 'org_1',
      status: 'draft',
      isPublic: false,
      version: 1,
    });
    expect(typeof body.id).toBe('string');
    await server.close();
  });

  it('GET one returns 404 with V2 shape for unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/events/nope_1',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});
