import { afterEach, describe, expect, it, vi } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerOrganizationRoutes from '../partner/organizations.js';

import leaderboardRoutes from './leaderboard-routes.js';

/**
 * ─── Leaderboard routes over HTTP (Phase 6) ─────────────────────────────────
 * Increments have no HTTP entrypoint of their own (they happen inside the
 * checkout-webhook settlement — see `checkout/webhook-routes.test.ts`'s
 * ledger-split test) — seeded directly via `services.leaderboard.recordCommission`,
 * mirroring how `finance-routes.test.ts` seeds ledger reads through the
 * service layer.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({ routes: [partnerOrganizationRoutes, leaderboardRoutes] });

type Server = Awaited<ReturnType<typeof buildServer>>;

/** Fixed instant for seeded commissions; see the `leaderboard/me` block below. */
const SEED_AT = new Date('2026-09-08T12:00:00.000Z');

async function seedOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Leaderboard Test Promoter', slug: `leaderboard-org-${++keySeq}` },
  });
  return created.json().id as string;
}

describe('GET /leaderboard', () => {
  it('is reachable with no auth headers and ranks by commission earned', async () => {
    const server = await buildServer();
    const promoterA = await seedOrganization(server);
    const promoterB = await seedOrganization(server);
    const now = new Date('2026-09-08T12:00:00.000Z');

    await createV2Services().leaderboard.recordCommission(promoterA, 5_000, 'Mumbai', now);
    await createV2Services().leaderboard.recordCommission(promoterB, 9_000, 'Mumbai', now);

    const res = await server.inject({
      method: 'GET',
      url: '/leaderboard?periodType=all_time&city=Mumbai',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].promoterId).toBe(promoterB);
    expect(body.items[0].totalCommissionEarnedPaise).toBe(9_000);
    expect(body.items[1].promoterId).toBe(promoterA);
    await server.close();
  });

  it('defaults to the global, all_time ranking with no query params', async () => {
    const server = await buildServer();
    const promoter = await seedOrganization(server);
    await createV2Services().leaderboard.recordCommission(promoter, 1_000, null, new Date());

    const res = await server.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.some((item: { promoterId: string }) => item.promoterId === promoter)).toBe(
      true,
    );
    await server.close();
  });
});

describe('GET /organizations/:organizationId/leaderboard/me', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the caller own standing', async () => {
    // `periodType=month` with no `periodValue` resolves the bucket from
    // `new Date()` at request time, while the commission is recorded at SEED_AT.
    // Pin the clock to the same instant so the write and the read always land in
    // the same month bucket — otherwise the read hits an empty bucket and this
    // fails on the 1st of each month, which is a rotted test, not a real signal.
    //
    // Only `Date` is faked. Faking the timer functions as well stalls the test
    // server's own scheduling and the request never resolves.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SEED_AT);

    const server = await buildServer();
    const promoter = await seedOrganization(server);
    await createV2Services().leaderboard.recordCommission(promoter, 3_000, 'Delhi', SEED_AT);

    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${promoter}/leaderboard/me?periodType=month&city=Delhi`,
      headers: { 'x-organization-id': promoter },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCommissionEarnedPaise).toBe(3_000);
    await server.close();
  });

  it('returns a real zero, not a 404, when nothing has been earned yet', async () => {
    const server = await buildServer();
    const promoter = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${promoter}/leaderboard/me`,
      headers: { 'x-organization-id': promoter },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalCommissionEarnedPaise).toBe(0);
  });

  it('rejects a cross-tenant read', async () => {
    const server = await buildServer();
    const promoter = await seedOrganization(server);
    const other = await seedOrganization(server);
    const res = await server.inject({
      method: 'GET',
      url: `/organizations/${promoter}/leaderboard/me`,
      headers: { 'x-organization-id': other },
    });
    expect(res.statusCode).toBe(403);
  });
});
