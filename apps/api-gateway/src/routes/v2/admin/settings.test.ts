import { createPlatformAdmin, DEFAULT_PLATFORM_SETTINGS } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, PlatformSettings } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminSettingsRoutes from './settings.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin platform-settings desk over HTTP (Phase 7 admin) ──────────────────
 * Singleton settings doc: `GET /admin/settings/platform` (any admin) and
 * `PUT /admin/settings/platform` (merge-update, idempotent, SENSITIVE_COMMAND).
 * Asserts defaults before any write, the merge semantics, the strict schema
 * (unknown fields rejected), and idempotent replay of the same key.
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

function resetSettings() {
  const repo = services.repos().platformSettings as unknown as {
    settings: PlatformSettings;
  };
  repo.settings = { ...DEFAULT_PLATFORM_SETTINGS };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records.length = 0;
  resetSettings();

  server = await buildPartnerTestServer({ routes: [adminSettingsRoutes] });
});

describe('GET /admin/settings/platform', () => {
  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/settings/platform',
      headers: { 'x-user-id': 'not_an_admin' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the defaults before any write', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/settings/platform',
      headers: { 'x-user-id': 'admin_a' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.refundSingleApproverThresholdPaise).toBe(
      DEFAULT_PLATFORM_SETTINGS.refundSingleApproverThresholdPaise,
    );
    expect(body.refundDualApproverThresholdPaise).toBe(
      DEFAULT_PLATFORM_SETTINGS.refundDualApproverThresholdPaise,
    );
    expect(body.platformFeeRate).toBe(DEFAULT_PLATFORM_SETTINGS.platformFeeRate);
    expect(body.maintenanceMode).toBe(false);
    expect(typeof body.updatedAt).toBe('string');
  });
});

describe('PUT /admin/settings/platform', () => {
  it('merge-updates a threshold and persists it for subsequent reads', async () => {
    await seedAdmin('admin_a', 'ops');

    const put = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers: asUser('admin_a'),
      payload: { refundSingleApproverThresholdPaise: 75_000 },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.refundSingleApproverThresholdPaise).toBe(75_000);
    expect(body.refundDualApproverThresholdPaise).toBe(
      DEFAULT_PLATFORM_SETTINGS.refundDualApproverThresholdPaise,
    );

    const get = await server.inject({
      method: 'GET',
      url: '/admin/settings/platform',
      headers: { 'x-user-id': 'admin_a' },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().refundSingleApproverThresholdPaise).toBe(75_000);
  });

  it('rejects an unknown field (strict schema)', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers: asUser('admin_a'),
      payload: { platfromFeeRate: 0.2 },
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects a negative threshold', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers: asUser('admin_a'),
      payload: { refundSingleApproverThresholdPaise: -10 },
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a non-admin', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers: { 'x-user-id': 'not_an_admin', 'idempotency-key': 'key-nope-1' },
      payload: { maintenanceMode: true },
    });
    expect(response.statusCode).toBe(401);
  });

  it('replays the same idempotency key + body without double-applying', async () => {
    await seedAdmin('admin_a', 'ops');
    const headers = asUser('admin_a');
    const payload = { maintenanceMode: true };

    const first = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().maintenanceMode).toBe(true);

    const replay = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().maintenanceMode).toBe(true);
  });

  it('rejects the same key with a different body (409, B08)', async () => {
    await seedAdmin('admin_a', 'ops');
    const headers = asUser('admin_a');

    const first = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload: { maintenanceMode: true },
    });
    expect(first.statusCode).toBe(200);

    const replay = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload: { maintenanceMode: false },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('writes an audit record for every settings mutation (F4)', async () => {
    await seedAdmin('admin_a', 'ops');

    const response = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers: asUser('admin_a'),
      payload: { maintenanceMode: true },
    });
    expect(response.statusCode).toBe(200);

    const audit = await services.adminAudits().listRecent(10);
    expect(audit.some((r) => r.action === 'PLATFORM_SETTINGS_UPDATE')).toBe(true);
  });

  it('replays the same idempotency key without double-auditing', async () => {
    await seedAdmin('admin_a', 'ops');
    const headers = asUser('admin_a');
    const payload = { maintenanceMode: true };

    const first = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload,
    });
    const replay = await server.inject({
      method: 'PUT',
      url: '/admin/settings/platform',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);

    const audit = await services.adminAudits().listRecent(10);
    expect(audit.filter((r) => r.action === 'PLATFORM_SETTINGS_UPDATE')).toHaveLength(1);
  });
});
