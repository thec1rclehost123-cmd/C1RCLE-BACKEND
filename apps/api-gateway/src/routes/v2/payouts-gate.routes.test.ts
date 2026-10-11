import { describe, expect, it, vi } from 'vitest';

import { buildPartnerTestServer } from '../../test-utils/partner-test-server.js';

import adminPayoutRoutes from './admin/payouts.js';
import financeRoutes from './finance/finance-routes.js';

import type * as ConfigModule from '../../config/index.js';

/**
 * The real payout routes, with the release gate switched off. The point is the
 * SHAPE of the gate: the three actions that request, batch-run or release a
 * payout refuse; freezing (a safety action) and reading stay available.
 */

const flag = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../config/index.js', async (importOriginal) => {
  const actual: typeof ConfigModule = await importOriginal();
  return {
    ...actual,
    getGatewayConfig: (...args: Parameters<typeof actual.getGatewayConfig>) => ({
      ...actual.getGatewayConfig(...args),
      PAYOUTS_ENABLED: flag.enabled,
    }),
  };
});

const build = () => buildPartnerTestServer({ routes: [financeRoutes, adminPayoutRoutes] });

const attempts = {
  requestPayout: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({
      method: 'POST',
      url: '/organizations/org_1/payouts',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': 'payout-gate-1' },
      payload: { amountPaise: 50_000 },
    }),
  batchRun: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({
      method: 'POST',
      url: '/admin/payouts/batch-run',
      headers: { 'idempotency-key': 'payout-gate-2' },
      payload: {},
    }),
  release: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({
      method: 'POST',
      url: '/admin/proposals/prop_1/release-payout',
      headers: { 'idempotency-key': 'payout-gate-3' },
    }),
  freeze: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({
      method: 'POST',
      url: '/admin/proposals/prop_1/freeze-payout',
      headers: { 'idempotency-key': 'payout-gate-4' },
    }),
  listPayouts: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({ method: 'GET', url: '/admin/payouts' }),
  ownPayouts: (server: Awaited<ReturnType<typeof build>>) =>
    server.inject({
      method: 'GET',
      url: '/organizations/org_1/payouts',
      headers: { 'x-organization-id': 'org_1' },
    }),
};

describe('payout release gate on the real routes', () => {
  it('refuses to request, batch-run or release a payout while payouts are off', async () => {
    flag.enabled = false;
    const server = await build();

    for (const attempt of [attempts.requestPayout, attempts.batchRun, attempts.release]) {
      const response = await attempt(server);
      expect(response.statusCode).toBe(503);
      expect(response.json().message).toBe('Payouts are not enabled on this deployment.');
    }
    await server.close();
  });

  it('keeps freezing and reading available while payouts are off', async () => {
    flag.enabled = false;
    const server = await build();

    // Whatever else they answer (auth, validation, not found), they are not the gate.
    for (const attempt of [attempts.freeze, attempts.listPayouts, attempts.ownPayouts]) {
      expect((await attempt(server)).statusCode).not.toBe(503);
    }
    await server.close();
  });

  it('does not refuse the same requests when payouts are on', async () => {
    flag.enabled = true;
    const server = await build();

    for (const attempt of [attempts.requestPayout, attempts.batchRun, attempts.release]) {
      expect((await attempt(server)).statusCode).not.toBe(503);
    }
    await server.close();
  });
});
