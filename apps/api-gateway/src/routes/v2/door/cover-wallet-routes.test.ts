import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import partnerEventRoutes from '../partner/events.js';

import phase5CoverWalletRoutes from './cover-wallet-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── V2 phase5 cover-wallet slice — route tests ──────────────────────────────
 * Registers the event routes alongside the cover-wallet routes because a
 * wallet can only be issued against a real `Event` (`createWallet` looks it
 * up via `events.findById` and enforces org access against it) — `createV2Services`
 * is memoized per test file, so both route files share the same underlying
 * repositories and an event created via HTTP here is visible to the wallet
 * service exactly like it would be in the real gateway.
 */

const buildServer = (actorRole: 'owner' | 'member' = 'owner') =>
  buildPartnerTestServer({ routes: [partnerEventRoutes, phase5CoverWalletRoutes], actorRole });

const ORG_HEADERS = { 'x-organization-id': 'org_1' };

/** Seeds an event straight into the shared in-memory repos so an RBAC test
 * doesn't need the event-create permission to get a real event row. */
async function seedEvent(): Promise<string> {
  const services = createV2Services();
  const eventId = 'evt_cw_rbac_1';
  if (await services.repos().events.findById(eventId)) return eventId;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: eventId,
    organizationId: 'org_1',
    venueId: 'ven_1',
    slug: `cw-rbac-${eventId}`,
    title: 'Cover Wallet RBAC Night',
    summary: '',
    description: '',
    imageUrl: null,
    startAt: '2026-09-01T18:00:00.000Z',
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: null,
    isFree: false,
    cancellationReason: null,
    capacity: null,
    adminOverride: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  return eventId;
}

async function createEvent(server: FastifyInstance, idempotencyKey: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/organizations/org_1/events',
    headers: { 'x-organization-id': 'org_1', 'idempotency-key': idempotencyKey },
    payload: { title: 'Wallet Test Night', venueId: 'ven_1', startAt: '2026-09-01T18:00:00Z' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

async function issueWallet(
  server: FastifyInstance,
  eventId: string,
  userId: string,
  openingBalancePaise = 500_000,
): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/cover-wallets',
    headers: ORG_HEADERS,
    payload: { eventId, userId, openingBalancePaise },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id as string;
}

describe('V2 phase5 cover-wallet slice', () => {
  it('issues a wallet and returns a response matching coverWalletResponseSchema', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-issue');
    const response = await server.inject({
      method: 'POST',
      url: '/cover-wallets',
      headers: ORG_HEADERS,
      payload: { eventId, userId: 'user_1', openingBalancePaise: 500_000 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      eventId,
      userId: 'user_1',
      balancePaise: 500_000,
      openingBalancePaise: 500_000,
      totalCreditsPaise: 500_000,
      totalDebitsPaise: 0,
      status: 'active',
      terminatedAt: null,
    });
    expect(typeof body.id).toBe('string');
    await server.close();
  });

  it('debits a wallet (happy path, isOnline: true)', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-debit');
    const walletId = await issueWallet(server, eventId, 'user_2');
    const response = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/debit`,
      headers: ORG_HEADERS,
      payload: {
        walletId,
        amountPaise: 20_000,
        idempotencyKey: 'idem-debit-1',
        isOnline: true,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: walletId,
      balancePaise: 480_000,
      totalDebitsPaise: 20_000,
      status: 'active',
    });
    await server.close();
  });

  it('rejects a debit when isOnline is false (offline debits blocked at the API layer)', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-offline');
    const walletId = await issueWallet(server, eventId, 'user_3');
    const response = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/debit`,
      headers: ORG_HEADERS,
      payload: {
        walletId,
        amountPaise: 20_000,
        idempotencyKey: 'idem-debit-offline-1',
        isOnline: false,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });

  it('rejects a debit on a terminated wallet', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-terminated');
    const walletId = await issueWallet(server, eventId, 'user_4');

    const terminateResponse = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/terminate`,
      headers: ORG_HEADERS,
      payload: { reason: 'event ended' },
    });
    expect(terminateResponse.statusCode).toBe(200);
    expect(terminateResponse.json()).toMatchObject({ status: 'terminated' });

    const response = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/debit`,
      headers: ORG_HEADERS,
      payload: {
        walletId,
        amountPaise: 20_000,
        idempotencyKey: 'idem-debit-terminated-1',
        isOnline: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });

  it('reconciles a wallet (happy path, no discrepancy)', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-reconcile');
    const walletId = await issueWallet(server, eventId, 'user_5', 300_000);

    const response = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/reconcile`,
      headers: ORG_HEADERS,
      payload: { eventId, reconciliationDate: '2026-08-21', walletId },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      eventId,
      reconciliationDate: '2026-08-21',
      expectedBalancePaise: 300_000,
      actualBalancePaise: 300_000,
      discrepancyPaise: 0,
      discrepancies: [],
    });
    await server.close();
  });

  it('GET returns 404 with V2 shape for an unknown wallet id', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/cover-wallets/wal-does-not-exist',
      headers: ORG_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('freezes a wallet, blocks a debit while frozen, then unfreezes it', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-freeze');
    const walletId = await issueWallet(server, eventId, 'user_6');

    const freezeResponse = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/freeze`,
      headers: { ...ORG_HEADERS, 'idempotency-key': 'idem-freeze-1' },
    });
    expect(freezeResponse.statusCode).toBe(200);
    expect(freezeResponse.json()).toMatchObject({ id: walletId, status: 'frozen' });

    const debitWhileFrozen = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/debit`,
      headers: ORG_HEADERS,
      payload: {
        walletId,
        amountPaise: 20_000,
        idempotencyKey: 'idem-debit-frozen-1',
        isOnline: true,
      },
    });
    expect(debitWhileFrozen.statusCode).toBe(400);
    expect(debitWhileFrozen.json()).toMatchObject({ code: 'validation', status: 400 });

    const unfreezeResponse = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/unfreeze`,
      headers: { ...ORG_HEADERS, 'idempotency-key': 'idem-unfreeze-1' },
    });
    expect(unfreezeResponse.statusCode).toBe(200);
    expect(unfreezeResponse.json()).toMatchObject({ id: walletId, status: 'active' });

    const debitAfterUnfreeze = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/debit`,
      headers: ORG_HEADERS,
      payload: {
        walletId,
        amountPaise: 20_000,
        idempotencyKey: 'idem-debit-unfrozen-1',
        isOnline: true,
      },
    });
    expect(debitAfterUnfreeze.statusCode).toBe(200);
    expect(debitAfterUnfreeze.json()).toMatchObject({ status: 'active', balancePaise: 480_000 });
    await server.close();
  });

  it('rejects freezing an already-frozen wallet (409, illegal FSM transition)', async () => {
    const server = await buildServer();
    const eventId = await createEvent(server, 'idem-cw-event-double-freeze');
    const walletId = await issueWallet(server, eventId, 'user_7');

    const firstFreeze = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/freeze`,
      headers: { ...ORG_HEADERS, 'idempotency-key': 'idem-double-freeze-1' },
    });
    expect(firstFreeze.statusCode).toBe(200);

    const secondFreeze = await server.inject({
      method: 'POST',
      url: `/cover-wallets/${walletId}/freeze`,
      headers: { ...ORG_HEADERS, 'idempotency-key': 'idem-double-freeze-2' },
    });
    expect(secondFreeze.statusCode).toBe(400);
    expect(secondFreeze.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });
});

describe('V2 cover-wallet RBAC', () => {
  it('denies a read-only member every wallet write (403), before any lookup', async () => {
    const server = await buildServer('member');
    const eventId = await seedEvent();

    const issue = await server.inject({
      method: 'POST',
      url: '/cover-wallets',
      headers: ORG_HEADERS,
      payload: { eventId, userId: 'user_1', openingBalancePaise: 100_000 },
    });
    expect(issue.statusCode).toBe(403);

    // These never reach the service: preHandler denial happens before any
    // wallet lookup, so even a wallet id that does not exist still 403s.
    const debit = await server.inject({
      method: 'POST',
      url: '/cover-wallets/wallet_nope_1/debit',
      headers: ORG_HEADERS,
      payload: {
        walletId: 'wallet_nope_1',
        amountPaise: 100,
        idempotencyKey: 'idem-rbac-debit',
        isOnline: true,
      },
    });
    expect(debit.statusCode).toBe(403);

    const credit = await server.inject({
      method: 'POST',
      url: '/cover-wallets/wallet_nope_1/credit',
      headers: ORG_HEADERS,
      payload: { walletId: 'wallet_nope_1', amountPaise: 100, idempotencyKey: 'idem-rbac-credit' },
    });
    expect(credit.statusCode).toBe(403);

    for (const action of ['freeze', 'unfreeze', 'terminate', 'reconcile']) {
      const response = await server.inject({
        method: 'POST',
        url: `/cover-wallets/wallet_nope_1/${action}`,
        headers: { ...ORG_HEADERS, 'idempotency-key': `idem-rbac-${action}` },
        payload:
          action === 'terminate'
            ? { reason: 'rbac test' }
            : action === 'reconcile'
              ? { eventId, reconciliationDate: '2026-09-01' }
              : {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'forbidden', status: 403 });
    }
    await server.close();
  });

  it('lets a read-only member read wallet state (venue.read) but hides strangers', async () => {
    const server = await buildServer('member');
    const response = await server.inject({
      method: 'GET',
      url: '/cover-wallets/does-not-exist',
      headers: ORG_HEADERS,
    });
    // Gate passes (venue.read), then the service 404s — not a 403.
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});
