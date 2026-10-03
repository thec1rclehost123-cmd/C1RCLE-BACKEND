import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PromoCode } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminPromotionsRoutes from './promotions.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin promotions desk over HTTP (Phase 7 admin) ─────────────────────────
 * Platform-wide, read-only promo code list. Cross-event — asserts codes from
 * different events all surface on one page.
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

function promo(overrides: Partial<PromoCode>): PromoCode {
  const now = new Date().toISOString();
  return {
    id: `promo_${++keySeq}`,
    eventId: 'event_1',
    organizationId: 'org_1',
    code: 'SAVE10',
    name: 'Save 10',
    type: 'public',
    discountType: 'percent',
    discountValue: 10,
    tierIds: [],
    maxRedemptions: null,
    maxPerUser: null,
    redemptionCount: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.catalog as unknown as { promos: Map<string, unknown> }).promos.clear();

  server = await buildPartnerTestServer({ routes: [adminPromotionsRoutes] });
});

describe('GET /admin/promotions', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/promotions',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists promo codes across events', async () => {
    await seedAdmin('admin_a', 'ops');
    await services.repos().catalog.savePromo(promo({ eventId: 'event_1', code: 'SAVE10' }));
    await services.repos().catalog.savePromo(promo({ eventId: 'event_2', code: 'VIP20' }));

    const response = await server.inject({
      method: 'GET',
      url: '/admin/promotions',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    const codes = body.items.map((item: { code: string }) => item.code).sort();
    expect(codes).toEqual(['SAVE10', 'VIP20']);
  });
});
