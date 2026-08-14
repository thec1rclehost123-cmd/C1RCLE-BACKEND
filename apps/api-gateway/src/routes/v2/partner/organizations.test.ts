import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerOrganizationRoutes from './organizations.js';

const buildServer = () => buildPartnerTestServer({ routes: [partnerOrganizationRoutes] });

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

  it('GET one returns 403 for an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/nope_1',
      headers: VALID_HEADERS,
    });
    // ABAC (`requirePermission`) compares the path's `:organizationId` with the
    // actor's resolved organization and rejects the mismatch before any service
    // call. The answer is identical whether `nope_1` exists or not, so this is
    // not an existence oracle — it is the same IDOR guarantee the 404 gave,
    // reached one layer earlier. Changed deliberately when RBAC/ABAC was wired
    // onto the partner routes; see docs/architecture/decisions.md D-012.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
    await server.close();
  });
});
