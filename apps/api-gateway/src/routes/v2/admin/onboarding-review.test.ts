import { createPlatformAdmin, createOnboardingRequest } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminOnboardingReviewRoutes from './onboarding-review.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin onboarding-review desk over HTTP (Phase 7 admin) ──────────────────
 * Tests the critical read-only endpoints (list queue, get single, list admins,
 * list proposals, audit trail) for auth gating and DTO shape. Idempotent
 * write endpoints (approve/reject/request-changes) are not tested here because
 * they orchestrate multiple service calls (org provisioning, custom-claims
 * sync) that require deeper integration coverage — covered by contract-suite
 * tests in packages/core.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId };
}

function makeSubmittedRequest(overrides: Record<string, unknown> = {}) {
  const id = `REQ-${++keySeq}`;
  return createOnboardingRequest({
    id,
    userId: `applicant_${keySeq}`,
    requestedType: 'venue',
    plan: 'basic',
    profile: {
      legalName: `Venue ${keySeq}`,
      contactPerson: 'Test Person',
      phone: '+910000000000',
      city: 'Mumbai',
    },
    ...overrides,
  }) as ReturnType<typeof createOnboardingRequest> & { status: string };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.onboarding as unknown as { requests: Map<string, unknown> }).requests.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records.length = 0;

  server = await buildPartnerTestServer({ routes: [adminOnboardingReviewRoutes] });
});

describe('GET /admin/onboarding/applications', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/onboarding/applications',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists submitted onboarding requests with correct DTO shape', async () => {
    await seedAdmin('admin_a', 'ops');
    const req1 = makeSubmittedRequest();
    req1.status = 'submitted';
    await services.repos().onboarding.save(req1);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/onboarding/applications',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.pageInfo).toHaveProperty('hasNextPage');
    const first = body.items[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('requestedType');
  });
});

describe('GET /admin/onboarding/applications/:requestId', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/onboarding/applications/REQ-1',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns a single onboarding request by id', async () => {
    await seedAdmin('admin_a', 'ops');
    const req1 = makeSubmittedRequest();
    req1.status = 'submitted';
    await services.repos().onboarding.save(req1);

    const response = await server.inject({
      method: 'GET',
      url: `/admin/onboarding/applications/${req1.id}`,
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(req1.id);
    expect(body.status).toBe('submitted');
    expect(body.requestedType).toBe('venue');
  });
});

describe('GET /admin/admins', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/admins',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists platform admins with correct DTO shape', async () => {
    await seedAdmin('admin_a', 'ops');
    await seedAdmin('admin_b', 'finance');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/admins',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    const adminA = body.items.find((a: { id: string }) => a.id === 'admin_a');
    expect(adminA.email).toBe('admin_a@c1rcle.test');
    expect(adminA.role).toBe('ops');
    expect(adminA.isActive).toBe(true);
  });
});

describe('GET /admin/proposals', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/proposals',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns an empty list when there are no proposals', async () => {
    await seedAdmin('admin_a', 'super');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/proposals',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(0);
  });
});

describe('POST /admin/admins/:adminId/revoke', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/admins/admin_b/revoke',
      headers: { 'x-user-id': 'not_an_admin', 'idempotency-key': 'key-revoke-0' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('revokes once and replays the same idempotency key without double-revoking (F5)', async () => {
    await seedAdmin('admin_a', 'super');
    await seedAdmin('admin_b', 'ops');
    const headers = { 'x-user-id': 'admin_a', 'idempotency-key': 'key-revoke-1' };

    const first = await server.inject({
      method: 'POST',
      url: '/admin/admins/admin_b/revoke',
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().isActive).toBe(false);

    const replay = await server.inject({
      method: 'POST',
      url: '/admin/admins/admin_b/revoke',
      headers,
    });
    expect(replay.statusCode).toBe(200);

    const audit = await services.adminAudits().listForTarget('admin_b', 10);
    expect(audit.filter((r) => r.action === 'ADMIN_REVOKE')).toHaveLength(1);
  });
});

describe('GET /admin/audit', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/audit',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns audit records (empty or populated)', async () => {
    await seedAdmin('admin_a', 'super');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/audit',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
  });
});
