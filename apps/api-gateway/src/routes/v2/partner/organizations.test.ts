import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import validateV2Plugin from '../../../plugins/validate-v2.js';

import partnerOrganizationRoutes from './organizations.js';

async function buildServer() {
  const server = Fastify({ logger: false });
  await server.register(validateV2Plugin);
  await server.register(partnerOrganizationRoutes);
  return server;
}

const VALID_HEADERS = { 'x-organization-id': 'org_1' };
const CREATE_HEADERS = { 'x-organization-id': 'org_1', 'idempotency-key': 'idem-org-1' };

describe('V2 partners organizations slice', () => {
  it('creates an organization and returns the canonical DTO', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations',
      headers: CREATE_HEADERS,
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
    await server.close();
  });

  it('rejects unknown body keys with 422 (strict body)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations',
      headers: CREATE_HEADERS,
      payload: { name: 'X', slug: 'x-events', hackerField: 'leak' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
    await server.close();
  });

  it('GET one returns 404 with V2 shape for unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/nope_1',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});
