import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Entitlement } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminTicketRoutes from './tickets.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin tickets desk over HTTP (Phase 7 admin) ────────────────────────────
 * Platform-wide, read-only entitlement ledger. Asserts admin gating and that
 * the DTO carries the latest scan timestamp, not the full `scannedAt` array.
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

function ticket(overrides: Partial<Entitlement>): Entitlement {
  const now = new Date().toISOString();
  return {
    id: `ENT-${++keySeq}`,
    orderId: 'order_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    tierName: 'General',
    userId: null,
    holderName: 'Guest Person',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
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
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();

  server = await buildPartnerTestServer({ routes: [adminTicketRoutes] });
});

describe('GET /admin/tickets', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/tickets',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('lists tickets platform-wide with the latest scan timestamp', async () => {
    await seedAdmin('admin_a', 'ops');
    const scannedAt = ['2026-09-01T10:00:00.000Z', '2026-09-01T10:05:00.000Z'];
    await services.repos().entitlements.save(
      ticket({
        status: 'redeemed',
        scanCount: 2,
        scanCountAllowed: 2,
        scannedAt,
      }),
    );
    await services.repos().entitlements.save(ticket({ status: 'valid' }));

    const response = await server.inject({
      method: 'GET',
      url: '/admin/tickets',
      headers: asUser('admin_a'),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    const redeemed = body.items.find((item: { status: string }) => item.status === 'redeemed');
    expect(redeemed.lastScannedAt).toBe('2026-09-01T10:05:00.000Z');
    const valid = body.items.find((item: { status: string }) => item.status === 'valid');
    expect(valid.lastScannedAt).toBeNull();
  });
});
