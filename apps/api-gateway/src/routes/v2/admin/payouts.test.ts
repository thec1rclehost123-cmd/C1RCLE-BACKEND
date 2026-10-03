import { createPayout, createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminRoutes from './onboarding-review.js';
import adminPayoutRoutes from './payouts.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin payout controls over HTTP (Phase 6 admin) ─────────────────────────
 * Freeze/release are TIER3 dual control — exercised through the real
 * proposal desk (`/admin/proposals`, registered here via `onboarding-review`)
 * rather than calling the service directly, so the propose→approve→execute
 * chain is covered end to end, same as `admin-authority-service.test.ts`'s
 * style for `ADMIN_PROVISION`.
 *
 * Payouts themselves are seeded directly on the repository — freeze/release
 * never touch money, only a status flag, and the money-movement path (real
 * ledger settlement -> `requestPayout`) is already covered by
 * `finance-services.test.ts`.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

async function seedPayout(status: 'requested' | 'processing' = 'requested') {
  const payout = createPayout({
    organizationId: `org_${++keySeq}`,
    bankAccountId: 'bank_1',
    amount: 50_000,
    requestedBy: 'user_1',
  });
  const withStatus =
    status === 'processing' ? { ...payout, status: 'processing' as const } : payout;
  await services.repos().payouts.save(withStatus);
  return withStatus;
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  (repos.payouts as unknown as { payouts: Map<string, unknown> }).payouts.clear();

  server = await buildPartnerTestServer({ routes: [adminRoutes, adminPayoutRoutes] });
});

async function proposeAndApprove(
  action: 'PAYOUT_FREEZE' | 'PAYOUT_RELEASE',
  payoutId: string,
  proposer: string,
  approver: string,
) {
  const proposed = await server.inject({
    method: 'POST',
    url: '/admin/proposals',
    headers: asUser(proposer),
    payload: { action, reason: 'test', payload: { payoutId } },
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

describe('payout freeze/release — dual control', () => {
  it('freezes a requested payout once a second admin approves the proposal', async () => {
    await seedAdmin('admin_a', 'super');
    await seedAdmin('admin_b', 'super');
    const payout = await seedPayout('requested');

    const proposalId = await proposeAndApprove('PAYOUT_FREEZE', payout.id, 'admin_a', 'admin_b');

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/freeze-payout`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(200);
    expect(executed.json().status).toBe('frozen');
  });

  it('release restores exactly the status held before freezing', async () => {
    await seedAdmin('admin_a', 'super');
    await seedAdmin('admin_b', 'super');
    const payout = await seedPayout('processing');

    const freezeProposal = await proposeAndApprove(
      'PAYOUT_FREEZE',
      payout.id,
      'admin_a',
      'admin_b',
    );
    await server.inject({
      method: 'POST',
      url: `/admin/proposals/${freezeProposal}/freeze-payout`,
      headers: asUser('admin_a'),
    });

    const releaseProposal = await proposeAndApprove(
      'PAYOUT_RELEASE',
      payout.id,
      'admin_a',
      'admin_b',
    );
    const released = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${releaseProposal}/release-payout`,
      headers: asUser('admin_a'),
    });

    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe('processing');
  });

  it('a non-super admin cannot even propose a freeze (TIER3)', async () => {
    await seedAdmin('admin_finance', 'finance');
    const payout = await seedPayout();

    const proposed = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_finance'),
      payload: { action: 'PAYOUT_FREEZE', reason: 'test', payload: { payoutId: payout.id } },
    });

    expect(proposed.statusCode).toBe(403);
  });

  it('refuses to execute a freeze proposal that has not been approved', async () => {
    await seedAdmin('admin_a', 'super');
    const payout = await seedPayout();

    const proposed = await server.inject({
      method: 'POST',
      url: '/admin/proposals',
      headers: asUser('admin_a'),
      payload: { action: 'PAYOUT_FREEZE', reason: 'test', payload: { payoutId: payout.id } },
    });
    const proposalId = proposed.json().id as string;

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/proposals/${proposalId}/freeze-payout`,
      headers: asUser('admin_a'),
    });

    expect(executed.statusCode).toBe(400);
  });
});

describe('POST /admin/payouts/batch-run — TIER2, single admin', () => {
  it('moves eligible requested payouts to processing and skips the rest', async () => {
    await seedAdmin('admin_ops', 'ops');
    const eligible = await seedPayout('requested');
    const alreadyProcessing = await seedPayout('processing');

    const response = await server.inject({
      method: 'POST',
      url: '/admin/payouts/batch-run',
      headers: asUser('admin_ops'),
      payload: { payoutIds: [eligible.id, alreadyProcessing.id, 'payout_missing'] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.processed).toHaveLength(1);
    expect(body.processed[0].id).toBe(eligible.id);
    expect(body.processed[0].status).toBe('processing');
    expect(body.skipped).toHaveLength(2);
  });

  it('refuses a support-tier admin (below TIER2)', async () => {
    await seedAdmin('admin_support', 'support');
    const payout = await seedPayout('requested');

    const response = await server.inject({
      method: 'POST',
      url: '/admin/payouts/batch-run',
      headers: asUser('admin_support'),
      payload: { payoutIds: [payout.id] },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('reads', () => {
  it('lists payouts filtered by status across organizations', async () => {
    await seedAdmin('admin_a', 'finance');
    await seedPayout('requested');
    await seedPayout('processing');

    const response = await server.inject({
      method: 'GET',
      url: '/admin/payouts?status=requested',
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].status).toBe('requested');
  });

  it('fetches a single payout by id', async () => {
    await seedAdmin('admin_a', 'finance');
    const payout = await seedPayout();

    const response = await server.inject({
      method: 'GET',
      url: `/admin/payouts/${payout.id}`,
      headers: asUser('admin_a'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(payout.id);
  });
});
