import { describe, expect, it } from 'vitest';

import partnerEventRoutes from '../routes/v2/partner/events.js';
import partnerOrganizationRoutes from '../routes/v2/partner/organizations.js';
import partnerVenueRoutes from '../routes/v2/partner/venues.js';
import { buildPartnerTestServer } from '../test-utils/partner-test-server.js';

import { ROLE_PERMISSIONS, roleHasPermission } from './rbac.js';

import type { Permission } from './rbac.js';

/**
 * ─── RBAC + ABAC enforcement ─────────────────────────────────────────────────
 *
 * These plugins were registered but wired to nothing for a while, which is the
 * failure mode worth guarding: policy code that exists, typechecks, and denies
 * nobody. Every assertion here is about a request actually being refused.
 */

const ORG = 'org_1';
const headers = (extra: Record<string, string> = {}) => ({
  'x-organization-id': ORG,
  ...extra,
});

describe('role → permission table', () => {
  it('gives a member read-only access and no write authority', () => {
    const member = ROLE_PERMISSIONS.member;
    expect(member).toContain('organization.read');
    expect(member).not.toContain('organization.update');
    expect(member).not.toContain('event.create');
    expect(member).not.toContain('event.publish');
    expect(member).not.toContain('staff.manage');
  });

  it('withholds staff.manage from a manager — inviting people is an owner/admin act', () => {
    expect(roleHasPermission('manager', 'staff.manage')).toBe(false);
    expect(roleHasPermission('admin', 'staff.manage')).toBe(true);
    expect(roleHasPermission('owner', 'staff.manage')).toBe(true);
  });

  it('covers every permission the union declares — no unreachable permission', () => {
    const declared: Permission[] = [
      'organization.read',
      'organization.update',
      'organization.create',
      'staff.manage',
      'venue.read',
      'venue.create',
      'venue.manage',
      'venue.schedule',
      'event.read',
      'event.create',
      'event.update',
      'event.publish',
      'event.cancel',
      'slot-request.create',
    ];
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    // A permission no role holds is dead policy: it can only ever deny.
    expect(declared.filter((permission) => !granted.has(permission))).toEqual([]);
  });
});

describe('ABAC — the path is the authority on which tenant is addressed', () => {
  it('refuses a path organization that is not the actor’s', async () => {
    const server = await buildPartnerTestServer({ routes: [partnerVenueRoutes] });
    const response = await server.inject({
      method: 'GET',
      // Header says org_1 (the dev actor's org); the path names another tenant.
      url: '/organizations/someone_else/venues',
      headers: headers(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
    await server.close();
  });

  it('allows the matching organization through', async () => {
    const server = await buildPartnerTestServer({ routes: [partnerVenueRoutes] });
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${ORG}/venues`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    await server.close();
  });

  it('rejects the mismatch on writes too, before the command runs', async () => {
    const server = await buildPartnerTestServer({ routes: [partnerEventRoutes] });
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/someone_else/events',
      headers: headers({ 'idempotency-key': 'abac-write-1' }),
      payload: { title: 'Sky Night', venueId: 'ven_1', startAt: '2026-09-01T18:00:00Z' },
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('policy ordering', () => {
  it('validates before it authorizes, so a bad request explains itself', async () => {
    const server = await buildPartnerTestServer({ routes: [partnerEventRoutes] });
    const response = await server.inject({
      method: 'POST',
      // No X-Organization-Id at all: the informative answer is "you omitted a
      // required header" (422), not a bare 403 that hides the real problem.
      url: `/organizations/${ORG}/events`,
      payload: {},
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('x-organization-id');
    await server.close();
  });

  it('still authorizes after validation passes', async () => {
    const server = await buildPartnerTestServer({ routes: [partnerOrganizationRoutes] });
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_my_org',
      headers: headers(),
    });

    // Well-formed request, wrong tenant → policy, not validation.
    expect(response.statusCode).toBe(403);
    await server.close();
  });
});
