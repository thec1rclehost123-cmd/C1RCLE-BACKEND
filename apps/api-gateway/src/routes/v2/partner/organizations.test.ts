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

// The services (and their idempotency store) are memoized per test file, so
// every test needs a unique idempotency-key — reusing one replays a previous
// test's result instead of creating a fresh org.
let orgSeq = 0;
function nextOrgKey() {
  orgSeq += 1;
  return `idem-org-${orgSeq}`;
}

async function createOrg(server: Awaited<ReturnType<typeof buildServer>>) {
  const response = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'idempotency-key': nextOrgKey() },
    payload: { name: 'Skyline Events', slug: 'skyline-events' },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('V2 partners organizations slice — read, update, members', () => {
  it('lists the orgs the caller is a member of', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const response = await server.inject({
      method: 'GET',
      url: '/organizations?limit=10',
      headers: { 'x-organization-id': id },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(id);
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    await server.close();
  });

  it('gets one owned org with the caller-scoped role', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${id}`,
      headers: { 'x-organization-id': id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      name: 'Skyline Events',
      slug: 'skyline-events',
      role: 'owner',
      status: 'active',
    });
    await server.close();
  });

  it('patches an org name via If-Match and bumps the version', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/organizations/${id}`,
      headers: {
        'x-organization-id': id,
        'idempotency-key': nextOrgKey(),
        'if-match': '1',
      },
      payload: { name: 'Skyline Events HQ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: 'Skyline Events HQ', version: 2 });
    await server.close();
  });

  it('returns 409 when the if-match version is stale', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const bump = await server.inject({
      method: 'PATCH',
      url: `/organizations/${id}`,
      headers: {
        'x-organization-id': id,
        'idempotency-key': nextOrgKey(),
        'if-match': '1',
      },
      payload: { name: 'Skyline Events HQ' },
    });
    expect(bump.statusCode).toBe(200);
    const stale = await server.inject({
      method: 'PATCH',
      url: `/organizations/${id}`,
      headers: {
        'x-organization-id': id,
        'idempotency-key': nextOrgKey(),
        'if-match': '1',
      },
      payload: { name: 'Third Name' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', status: 409 });
    await server.close();
  });

  it('invites a member and lists the membership', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const invited = await server.inject({
      method: 'POST',
      url: `/organizations/${id}/members`,
      headers: { 'x-organization-id': id, 'idempotency-key': nextOrgKey() },
      payload: { userId: 'user_2', role: 'manager', capabilities: ['host'] },
    });
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({
      userId: 'user_2',
      role: 'manager',
      capabilities: ['host'],
    });
    const list = await server.inject({
      method: 'GET',
      url: `/organizations/${id}/members?limit=10`,
      headers: { 'x-organization-id': id },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.items.map((item: { userId: string }) => item.userId)).toContain('user_2');
    await server.close();
  });

  it('reports the access context for the acting member', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${id}/access`,
      headers: { 'x-organization-id': id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationId: id,
      userId: 'user_1',
      partnerType: 'venue',
      role: 'OWNER',
    });
    expect(response.json().permissions.length).toBeGreaterThan(0);
    await server.close();
  });
});

describe('V2 partners organizations slice — invitations', () => {
  it('creates, lists, revokes and accepts an invitation', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);

    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${id}/invitations`,
      headers: { 'x-organization-id': id, 'idempotency-key': nextOrgKey() },
      payload: { email: 'newguy@acme.test', role: 'manager', capabilities: ['host'] },
    });
    expect(created.statusCode).toBe(201);
    const invitationId = created.json().id as string;
    expect(created.json()).toMatchObject({
      organizationId: id,
      email: 'newguy@acme.test',
      role: 'manager',
      status: 'pending',
    });

    const list = await server.inject({
      method: 'GET',
      url: `/organizations/${id}/invitations?limit=10`,
      headers: { 'x-organization-id': id },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: { id: string }) => item.id)).toContain(invitationId);

    const revoked = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/revoke`,
      headers: { 'x-organization-id': id, 'idempotency-key': nextOrgKey() },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ id: invitationId, status: 'revoked' });
    await server.close();
  });

  it('accepts an invitation as the invitee and joins the org', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${id}/invitations`,
      headers: { 'x-organization-id': id, 'idempotency-key': nextOrgKey() },
      payload: { email: 'joining@acme.test', role: 'admin' },
    });
    expect(created.statusCode).toBe(201);

    const accepted = await server.inject({
      method: 'POST',
      url: `/invitations/${created.json().id}/accept`,
      headers: { 'x-user-id': 'user_2' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id, name: 'Skyline Events' });
    await server.close();
  });

  it('returns 400 when an accepted invitation is accepted again', async () => {
    const server = await buildServer();
    const { id } = await createOrg(server);
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${id}/invitations`,
      headers: { 'x-organization-id': id, 'idempotency-key': nextOrgKey() },
      payload: { email: 'again@acme.test', role: 'member' },
    });
    expect(created.statusCode).toBe(201);

    const first = await server.inject({
      method: 'POST',
      url: `/invitations/${created.json().id}/accept`,
      headers: { 'x-user-id': 'user_3' },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `/invitations/${created.json().id}/accept`,
      headers: { 'x-user-id': 'user_4' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });
});
