import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PromoterAssignment } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminPromotersRoutes from './promoters.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin promoters desk over HTTP (Phase 7 admin) ──────────────────────────
 * Platform-wide, read-only promoter-assignment list. Asserts the DTO flattens
 * `terms` into `ratePercent`/`flatPaise` for the desk.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

function assignment(overrides: Partial<PromoterAssignment>): PromoterAssignment {
  const now = new Date().toISOString();
  return {
    id: `pa_${++keySeq}`,
    eventId: 'event_1',
    promoterId: 'user_promoter',
    status: 'active',
    terms: { version: 1, ratePercent: 15, flatPaise: 0 },
    version: 1,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.catalog as unknown as { assignments: Map<string, unknown> }).assignments.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records.length = 0;

  server = await buildPartnerTestServer({ routes: [adminPromotersRoutes] });
});

describe('GET /admin/promoters', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists promoter assignments with flattened commission terms', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'GET',
      url: '/admin/promoters',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].ratePercent).toBe(15);
    expect(body.items[0].flatPaise).toBe(0);
    expect(body.items[0].status).toBe('active');
  });
});

describe('POST /admin/promoters/:promoterId/suspend', () => {
  it('refuses a support-tier admin (TIER2 action, F1/F2 regression)', async () => {
    await seedAdmin('admin_support', 'support');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers: asUser('admin_support'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('suspends as an ops admin and writes an audit record (F3)', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const response = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.action).toBe('suspended');
    expect(body.affectedAssignments).toBe(1);

    const audit = await services.adminAudits().listForTarget('user_promoter', 10);
    expect(audit.some((r) => r.action === 'PROMOTER_SUSPEND')).toBe(true);
  });

  it('replay of the same audit-free idempotency key does not double-log', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.saveAssignment(assignment({}));

    const headers = asUser('admin_a');
    const first = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/admin/promoters/user_promoter/suspend',
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const audit = await services.adminAudits().listForTarget('user_promoter', 10);
    expect(audit.filter((r) => r.action === 'PROMOTER_SUSPEND')).toHaveLength(1);
  });
});
