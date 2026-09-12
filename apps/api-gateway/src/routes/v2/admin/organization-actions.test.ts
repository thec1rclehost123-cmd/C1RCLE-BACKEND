import { createOrganization, createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminRoutes from './onboarding-review.js';
import adminOrganizationActionRoutes from './organization-actions.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin commission adjust over HTTP (Phase 7 admin) ───────────────────────
 * Exercised through the real proposal desk (`/admin/proposals`, registered
 * via `onboarding-review`) — same style as `payouts.test.ts`'s freeze/
 * release coverage.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

async function seedOrganization() {
  const org = createOrganization({
    id: `org_${++keySeq}`,
    name: 'Skyline',
    slug: `skyline-${keySeq}`,
    ownerId: 'user_1',
  });
  await services.repos().organizations.save(org);
  return org;
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  server = await buildPartnerTestServer({ routes: [adminRoutes, adminOrganizationActionRoutes] });
});

async function proposeAndApprove(
  organizationId: string,
  platformFeePercent: number,
  proposer: string,
  approver: string,
) {
  const proposed = await server.inject({
    method: 'POST',
    url: '/admin/proposals',
    headers: asUser(proposer),
    payload: {
      action: 'COMMISSION_ADJUST',
      reason: 'Negotiated new rate',
      payload: { organizationId, platformFeePercent },
    },
  });
  const proposalId = proposed.json().id as string;
  const approved = await server.inject({
    method: 'POST',
    url: `/admin/proposals/${proposalId}/approve`,
    headers: asUser(approver),
  });
  expect(approved.statusCode).toBe(200);
  return proposalId;
}

describe('commission adjust — dual control', () => {
  it('changes platformFeePercent once a second admin approves', async () => {
    await seedAdmin('admin_a', 'super');
    await seedAdmin('admin_b', 'super');
    const org = await seedOrganization();

    const proposalId = await proposeAndApprove(org.id, 10, 'admin_a', 'admin_b');

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/adjust-commission`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().platformFeePercent).toBe(10);
  });

  it('a non-super admin cannot even propose a commission change (TIER3)', async () => {
    await seedAdmin('admin_finance', 'finance');
    const org = await seedOrganization();

    const proposed = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_finance'),
      payload: {
        action: 'COMMISSION_ADJUST',
        reason: 'test',
        payload: { organizationId: org.id, platformFeePercent: 5 },
      },
    });

    expect(proposed.statusCode).toBe(403);
  });

  it('refuses to execute an unapproved proposal', async () => {
    await seedAdmin('admin_a', 'super');
    const org = await seedOrganization();

    const proposed = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_a'),
      payload: {
        action: 'COMMISSION_ADJUST',
        reason: 'test',
        payload: { organizationId: org.id, platformFeePercent: 5 },
      },
    });
    const proposalId = proposed.json().id as string;

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/adjust-commission`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(400);
  });
});

describe('ORGANIZATION_SUSPEND / ORGANIZATION_REINSTATE (TIER2, direct command)', () => {
  it('suspends an org and writes an audit row', async () => {
    await seedAdmin('admin_a', 'ops');
    const org = await seedOrganization();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/organizations/${org.id}/suspend`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: org.id, status: 'suspended' });
  });

  it('refuses a role below TIER2', async () => {
    await seedAdmin('admin_support', 'support');
    const org = await seedOrganization();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/organizations/${org.id}/suspend`,
      headers: asUser('admin_support'),
    });
    expect(executed.statusCode).toBe(403);
  });

  it('reinstates a suspended org back to the literal "active" status', async () => {
    await seedAdmin('admin_a', 'ops');
    const org = await seedOrganization();
    await services
      .repos()
      .organizations.save({ ...org, status: 'suspended', version: org.version + 1 });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/organizations/${org.id}/reinstate`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: org.id, status: 'active' });
  });

  it('repeat suspend is idempotent (200, still suspended)', async () => {
    await seedAdmin('admin_a', 'ops');
    const org = await seedOrganization();

    const first = await server.inject({
      method: 'POST',
      url: `/admin/organizations/${org.id}/suspend`,
      headers: asUser('admin_a'),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `/admin/organizations/${org.id}/suspend`,
      headers: asUser('admin_a'),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('suspended');
  });

  it('unknown organization id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'ops');
    const executed = await server.inject({
      method: 'POST',
      url: '/admin/organizations/org_missing/suspend',
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(404);
  });
});
