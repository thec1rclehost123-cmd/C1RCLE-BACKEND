import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerOrganizationRoutes from './organizations.js';

/**
 * ─── Invitations over HTTP ───────────────────────────────────────────────────
 * Phase 0 could not register this route: with no pending-invitation concept in
 * the domain, the only possible response was a hardcoded empty list, which
 * rule 10 forbids. Now it reports real state.
 */

let keySeq = 0;
const read = (organizationId: string) => ({ 'x-organization-id': organizationId });
const write = (organizationId: string) => ({
  ...read(organizationId),
  'idempotency-key': `inv-key-${++keySeq}`,
});

const buildServer = () => buildPartnerTestServer({ routes: [partnerOrganizationRoutes] });

/**
 * Creates an organization and returns its id. On the memory driver the dev
 * actor's organization comes from `X-Organization-Id`, so scoping every later
 * call to this id is what makes the tenant checks pass.
 */
async function seedOrganization(server: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    // `organizations.create` still requires the header even though it ignores
    // it (there is no tenant yet); the created id is what matters afterwards.
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  return created.json().id;
}

describe('organization invitations', () => {
  it('lists nothing before any invitation exists — real state, not a stub', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/invitations`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], pageInfo: { total: 0 } });
    await server.close();
  });

  it('creates a pending invitation and then lists it', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload: { email: 'New@Example.com', role: 'manager' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      // Normalized on the way in, so casing cannot fork the identity.
      email: 'new@example.com',
      role: 'manager',
      status: 'pending',
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/invitations`,
      headers: read(org),
    });
    expect(listed.json().items).toHaveLength(1);
    await server.close();
  });

  it('refuses a second pending invitation for the same address', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const payload = { email: 'dupe@example.com', role: 'member' };
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload,
    });

    // Two live invitations would let one person join twice with whichever role
    // they happened to click.
    expect(second.statusCode).toBe(400);
    await server.close();
  });

  it('rejects an owner invitation at the schema boundary', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload: { email: 'owner@example.com', role: 'owner' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('role');
    await server.close();
  });

  it('revokes a pending invitation', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload: { email: 'revoke@example.com', role: 'member' },
    });
    const invitationId = created.json().id;

    const revoked = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/revoke`,
      headers: write(org),
    });

    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'revoked' });
    await server.close();
  });

  it('refuses acceptance by someone who is already a member', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/invitations`,
      headers: write(org),
      payload: { email: 'joiner@example.com', role: 'member' },
    });
    const invitationId = created.json().id;

    // The memory driver has a single fixed dev actor, and that actor owns the
    // organization it just created — so this exercises the duplicate-member
    // guard rather than the happy path. Acceptance BY A NEW USER is covered at
    // the domain level in `packages/core/src/domain/invitation.test.ts`, which
    // can name a different accepting user; wiring a second real session here
    // needs the firestore driver (see phase-00 Session Log).
    const accepted = await server.inject({
      method: 'POST',
      url: `/invitations/${invitationId}/accept`,
    });

    expect(accepted.statusCode).toBe(400);
    await server.close();
  });

  it('reports an unknown invitation as not-found without leaking existence', async () => {
    const server = await buildServer();
    await seedOrganization(server);

    const response = await server.inject({
      method: 'POST',
      url: '/invitations/does_not_exist/accept',
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('partner access context', () => {
  it('computes permissions and tab visibility server-side', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/access`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The creator is the owner, and a venue-capable owner has no tab
    // restriction — `null` means "show everything", not "show nothing".
    expect(body).toMatchObject({ organizationId: org, role: 'OWNER', tabVisibility: null });
    expect(body.permissions).toContain('VIEW_FINANCIALS');
    expect(body.permissions).toContain('MANAGE_STAFF');
    await server.close();
  });

  it('refuses to describe an organization the caller is not in', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/access',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});
