import { createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PlatformUser } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminRoutes from './onboarding-review.js';
import adminUserActionRoutes from './user-actions.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin user ban/unban over HTTP (Phase 7 trust & safety) ─────────────────
 * USER_BAN/USER_UNBAN are TIER2 direct commands — single admin, no dual
 * control. Same shape as `directory.test.ts`'s VENUE_SUSPEND coverage.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function seedUser(userId: string): PlatformUser {
  const user: PlatformUser = {
    id: userId,
    email: `${userId}@c1rcle.test`,
    name: userId,
    image: null,
    emailVerified: true,
    role: 'host',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  (services.repos().users as unknown as { users: Map<string, PlatformUser> }).users.set(
    userId,
    user,
  );
  return user;
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.users as unknown as { users: Map<string, unknown> }).users.clear();
  (repos.userBans as unknown as { bans: Map<string, unknown> }).bans.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records = [];

  server = await buildPartnerTestServer({ routes: [adminRoutes, adminUserActionRoutes] });
});

describe('USER_BAN / USER_UNBAN (TIER2, direct command)', () => {
  it('bans a user with a reason and writes an audit row', async () => {
    await seedAdmin('admin_a', 'ops');
    const user = seedUser('user_1');

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/ban`,
      headers: asUser('admin_a'),
      payload: { reason: 'Harassment report' },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: user.id, isBanned: true });

    const audit = await server.inject({
      method: 'GET',
      url: '/admin/audit?limit=10',
      headers: { 'x-user-id': 'admin_a' },
    });
    const records = audit.json().items as { action: string; reason: string | null }[];
    const row = records.find((record) => record.action === 'USER_BAN');
    expect(row?.reason).toBe('Harassment report');
  });

  it('refuses a role below TIER2', async () => {
    await seedAdmin('admin_support', 'support');
    const user = seedUser('user_1');

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/ban`,
      headers: asUser('admin_support'),
    });
    expect(executed.statusCode).toBe(403);
  });

  it('repeat ban is idempotent (200, still banned)', async () => {
    await seedAdmin('admin_a', 'ops');
    const user = seedUser('user_1');

    const first = await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/ban`,
      headers: asUser('admin_a'),
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/ban`,
      headers: asUser('admin_a'),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().isBanned).toBe(true);
  });

  it('unbans a banned user, clearing isBanned', async () => {
    await seedAdmin('admin_a', 'ops');
    const user = seedUser('user_1');
    await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/ban`,
      headers: asUser('admin_a'),
    });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/users/${user.id}/unban`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: user.id, isBanned: false });
  });

  it('banning a user id not in the directory still succeeds (ban state is independent)', async () => {
    await seedAdmin('admin_a', 'ops');

    const executed = await server.inject({
      method: 'POST',
      url: '/admin/users/user_not_in_directory/ban',
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ id: 'user_not_in_directory', isBanned: true });
  });
});
