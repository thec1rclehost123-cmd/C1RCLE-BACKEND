import { createHmac } from 'node:crypto';

import { MemoryPaymentProvider, createPlatformAdmin } from '@c1rcle/core/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';

import { buildApp } from '../src/app.js';
import { createV2Services } from '../src/lib/v2-services.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Main-gated end-to-end scenario suite ─────────────────────────────────────
 *
 * This suite is intentionally OUTSIDE `apps/api-gateway/src/` (in `scenarios/`)
 * so the default vitest config (`include` restricted to `src` `.test.ts` files)
 * never runs it in the normal `test` task. A dedicated
 * `vitest.scenarios.config.mjs` runs it as an EXTRA hard gate that CI only
 * executes on the `main` branch (see `ci.yml`'s `scenario` job) — it is the
 * trunk-merge safety net, not a developer loop.
 *
 * The scenario suite drives the FULL `buildApp()` over the real `/api/v2` wire
 * contract — every route, plugin (validate-v2, rbac, rate-limit, cache), and the
 * memory storage driver's actor fabrication — and walks two complete business
 * journeys end to end. It is deliberately NOT a mock: it exercises the same
 * `createV2Services()` singleton the routes use, so a regression in any layer
 * (validation, idempotency, FSM, ledger settlement, scanner session) fails here.
 *
 * Because `buildApp()` powers the full wired app, `request.actor` is never
 * populated (auth is a no-op on the memory driver), so `services.actor`
 * fabricates from headers the same way the other v2 suites do: `x-user-id` and
 * `x-organization-id`.
 */

let keySeq = 0;
const ik = (prefix: string) => `${prefix}-${++keySeq}-${Date.now()}`;

const services = createV2Services();

const STAFF: ActorContext = {
  userId: 'staff_1',
  organizationId: 'org_placeholder',
  role: 'owner',
  capabilities: [],
};

/** Header set for an org-scoped host actor (fabricated on the memory driver). */
const host = (orgId: string) => ({
  'x-user-id': 'host_1',
  'x-organization-id': orgId,
  'idempotency-key': ik('host'),
});

/** Header set for a not-yet-in-an-org applicant / platform admin actor. */
const asUser = (userId: string) => ({
  'x-user-id': userId,
  'idempotency-key': ik('user'),
});

const FULL_PROFILE = {
  legalName: 'Blue Room Hospitality',
  contactPerson: 'A. Applicant',
  phone: '9876543210',
  city: 'Mumbai',
};

const WEBHOOK_SECRET = 'test_webhook_secret';

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function webhookPayload(entity: { id: string; order_id: string; holdId: string }): string {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: entity.id,
          order_id: entity.order_id,
          notes: { holdId: entity.holdId },
        },
      },
    },
  });
}

function memoryProvider(): MemoryPaymentProvider {
  const provider = services.paymentProvider;
  if (!(provider instanceof MemoryPaymentProvider)) {
    throw new Error('expected the memory payment provider under STORAGE_DRIVER=memory');
  }
  return provider;
}

/**
 * Moves a host from onboarding to an approved, provisioned organization.
 * Returns `{ orgId }` for the subsequent host lifecycle steps.
 */
async function onboardAndApproveHost(
  server: FastifyInstance,
): Promise<{ requestId: string; orgId: string }> {
  const applicantId = 'host_1';
  const start = await server.inject({
    method: 'POST',
    url: '/api/v2/onboarding/applications',
    headers: asUser(applicantId),
    payload: { requestedType: 'host', plan: 'basic', profile: FULL_PROFILE },
  });
  expect(start.statusCode, JSON.stringify(start.json())).toBe(201);
  const requestId: string = start.json().id;

  for (const label of ['id_front', 'id_back', 'selfie']) {
    const doc = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/documents`,
      headers: asUser(applicantId),
      payload: { label, storagePath: `kyc/${applicantId}/${label}.jpg` },
    });
    expect(doc.statusCode).toBe(200);
  }

  const submit = await server.inject({
    method: 'POST',
    url: `/api/v2/onboarding/applications/${requestId}/submit`,
    headers: asUser(applicantId),
  });
  expect(submit.statusCode).toBe(200);

  // Seed a real platform admin so the approval's `requireAdmin` passes.
  await services
    .repos()
    .platformAdmins.save(
      createPlatformAdmin({ id: 'ops_1', email: 'ops@c1rcle.test', role: 'ops' }),
    );

  const approve = await server.inject({
    method: 'POST',
    url: `/api/v2/admin/onboarding/applications/${requestId}/approve`,
    headers: asUser('ops_1'),
    payload: {},
  });
  expect(approve.statusCode, JSON.stringify(approve.json())).toBe(200);
  const orgId: string = approve.json().organization.id;

  return { requestId, orgId };
}

/** Creates venue + event + a single ticket tier for a host org, then publishes. */
async function seedPublishedEvent(
  server: FastifyInstance,
  orgId: string,
): Promise<{ eventId: string; tierId: string }> {
  const venue = await server.inject({
    method: 'POST',
    url: `/api/v2/organizations/${orgId}/venues`,
    headers: host(orgId),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  expect(venue.statusCode, JSON.stringify(venue.json())).toBe(201);
  const venueId: string = venue.json().id;

  const event = await server.inject({
    method: 'POST',
    url: `/api/v2/organizations/${orgId}/events`,
    headers: host(orgId),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  expect(event.statusCode, JSON.stringify(event.json())).toBe(201);
  const eventId: string = event.json().id;

  const tier = await server.inject({
    method: 'POST',
    url: `/api/v2/events/${eventId}/ticket-tiers`,
    headers: host(orgId),
    payload: { name: 'General', priceInPaise: 150_000, quantity: 100 },
  });
  expect(tier.statusCode, JSON.stringify(tier.json())).toBe(201);
  const tierId: string = tier.json().id;

  const review = await server.inject({
    method: 'POST',
    url: `/api/v2/events/${eventId}/review`,
    headers: host(orgId),
  });
  expect(review.statusCode, JSON.stringify(review.json())).toBe(200);

  const publish = await server.inject({
    method: 'POST',
    url: `/api/v2/events/${eventId}/publish`,
    headers: host(orgId),
  });
  expect(publish.statusCode, JSON.stringify(publish.json())).toBe(200);
  expect(publish.json().isPublic).toBe(true);

  return { eventId, tierId };
}

function clearRepos(): void {
  const repos = services.repos();
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.organizations as unknown as { members: Map<string, unknown> }).members.clear();
  (repos.venues as unknown as { venues: Map<string, unknown> }).venues.clear();
  (repos.events as unknown as { events: Map<string, unknown> }).events.clear();
  (repos.catalog as unknown as { tiers: Map<string, unknown> }).tiers.clear();
  (repos.catalog as unknown as { promos: Map<string, unknown> }).promos.clear();
  (repos.catalog as unknown as { tables: Map<string, unknown> }).tables.clear();
  (repos.catalog as unknown as { assignments: Map<string, unknown> }).assignments.clear();
  (
    repos.cartReservations as unknown as { reservations: Map<string, unknown> }
  ).reservations.clear();
  (
    repos.cartReservations as unknown as { byIdempotencyKey: Map<string, unknown> }
  ).byIdempotencyKey.clear();
  (repos.orders as unknown as { orders: Map<string, unknown> }).orders.clear();
  (repos.orders as unknown as { byPaymentId: Map<string, unknown> }).byPaymentId.clear();
  (repos.entitlements as unknown as { entitlements: Map<string, unknown> }).entitlements.clear();
  (repos.ledger as unknown as { entries: Map<string, unknown> }).entries.clear();
  (repos.ledger as unknown as { byIdempotencyKey: Map<string, unknown> }).byIdempotencyKey.clear();
  (
    repos.eventCodes as unknown as { codes: Map<string, unknown>; byCode: Map<string, string> }
  ).codes.clear();
  (
    repos.eventCodes as unknown as { codes: Map<string, unknown>; byCode: Map<string, string> }
  ).byCode.clear();
  (
    repos.scannerSessions as unknown as {
      sessions: Map<string, unknown>;
      byTokenHash: Map<string, string>;
    }
  ).sessions.clear();
  (
    repos.scannerSessions as unknown as {
      sessions: Map<string, unknown>;
      byTokenHash: Map<string, string>;
    }
  ).byTokenHash.clear();
  (repos.scanLedger as unknown as { scans: Map<string, unknown> }).scans.clear();
  (repos.onboarding as unknown as { requests: Map<string, unknown> }).requests.clear();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.proposals as unknown as { proposals: Map<string, unknown> }).proposals.clear();
  (repos.verificationAttempts as unknown as { attempts: unknown[] }).attempts.length = 0;
  // The idempotency store's maps are `private`; clear them for a clean slate.
  const idem = services.idempotency as unknown as {
    store: { records: Map<string, unknown>; inFlight: Set<string> };
  };
  idem.store.records.clear();
  idem.store.inFlight.clear();
}

let server: FastifyInstance;

beforeEach(async () => {
  clearRepos();
  server = await buildApp({});
});

afterEach(async () => {
  await server.close();
});

describe('scenario: host lifecycle (onboarding -> publish -> public discovery)', () => {
  it('walks a host from application to a published, publicly discoverable event', async () => {
    const { orgId } = await onboardAndApproveHost(server);
    expect(orgId).toBeTruthy();

    const { eventId } = await seedPublishedEvent(server, orgId);

    // The same host (owner) can list the org's events.
    const list = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${orgId}/events`,
      headers: { 'x-user-id': 'host_1', 'x-organization-id': orgId },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(1);

    // Anonymous guest sees the published event in public discovery.
    const publicList = await server.inject({
      method: 'GET',
      url: '/api/v2/public/events',
    });
    expect(publicList.statusCode).toBe(200);
    const items = publicList.json().items;
    expect(items.map((e: { id: string }) => e.id)).toContain(eventId);

    const byId = await server.inject({
      method: 'GET',
      url: `/api/v2/public/events/${eventId}`,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().id).toBe(eventId);
  });
});

describe('scenario: guest purchase + door check-in + finance settlement', () => {
  it('lets a guest buy a ticket, be admitted at the door, and settle the host ledger', async () => {
    const { orgId } = await onboardAndApproveHost(server);
    const { eventId, tierId } = await seedPublishedEvent(server, orgId);

    // ── Guest checkout ─────────────────────────────────────────────────────
    const quote = await server.inject({
      method: 'POST',
      url: '/api/v2/checkout/quote',
      headers: { 'x-user-id': 'guest_1' },
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });
    expect(quote.statusCode).toBe(200);
    const grandTotalPaise: number = quote.json().grandTotalPaise;
    expect(grandTotalPaise).toBeGreaterThan(0);

    const hold = await server.inject({
      method: 'POST',
      url: '/api/v2/checkout/holds',
      headers: { 'x-user-id': 'guest_1', 'idempotency-key': ik('hold') },
      payload: { eventId, lines: [{ tierId, quantity: 1 }] },
    });
    expect(hold.statusCode, JSON.stringify(hold.json())).toBe(201);
    const holdId: string = hold.json().holdId;

    const attempt = await server.inject({
      method: 'POST',
      url: '/api/v2/payments/attempts',
      headers: { 'x-user-id': 'guest_1', 'idempotency-key': ik('attempt') },
      payload: { holdId },
    });
    expect(attempt.statusCode, JSON.stringify(attempt.json())).toBe(201);
    const paymentIntentId: string = attempt.json().paymentIntentId;

    // ── Capture + webhook fulfilment ────────────────────────────────────────
    const paymentId = `pay_scenario_${keySeq}`;
    memoryProvider().simulateCapture(paymentId, grandTotalPaise);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });
    const webhook = await server.inject({
      method: 'POST',
      url: '/api/v2/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toEqual({ received: true });

    // ── Guest reads their paid order + wallet ticket ───────────────────────
    const orderId = `ORD-${paymentId}`;
    const order = await server.inject({
      method: 'GET',
      url: `/api/v2/orders/${orderId}`,
      headers: { 'x-user-id': 'guest_1' },
    });
    expect(order.statusCode, JSON.stringify(order.json())).toBe(200);
    expect(order.json().status).toBe('paid');

    const wallet = await server.inject({
      method: 'GET',
      url: '/api/v2/wallet/tickets',
      headers: { 'x-user-id': 'guest_1' },
    });
    expect(wallet.statusCode).toBe(200);
    const tickets = wallet.json().items;
    expect(tickets.length).toBe(1);
    const entitlementId: string = tickets[0].id;

    // ── Door admission (standard event-code path) ───────────────────────────
    const eventCode = await services.scanner.createEventCode(
      {
        eventId,
        organizationId: orgId,
        venueId: null,
        type: 'full',
        gate: null,
        createdBy: STAFF.userId,
        createdByName: 'Staff One',
        expiresAt: null,
      },
      { ...STAFF, organizationId: orgId },
    );

    const deviceId = `device_scenario_${keySeq}`;
    const session = await server.inject({
      method: 'POST',
      url: '/api/v2/door/sessions',
      headers: { 'x-organization-id': orgId },
      payload: {
        eventId,
        code: eventCode.code,
        deviceId,
        deviceName: 'Gate iPad 1',
        sessionType: 'staff',
      },
    });
    expect(session.statusCode, JSON.stringify(session.json())).toBe(201);

    const checkIn = await server.inject({
      method: 'POST',
      url: '/api/v2/door/check-ins',
      headers: { 'x-organization-id': orgId },
      payload: {
        eventId,
        qrPayload: entitlementId,
        scannedBy: { uid: STAFF.userId, name: 'Staff One', role: 'staff' },
        deviceId,
      },
    });
    expect(checkIn.statusCode, JSON.stringify(checkIn.json())).toBe(200);
    expect(checkIn.json()).toMatchObject({ status: 'consumed', checkInId: expect.any(String) });

    // ── Host finance ledger has the settlement split ────────────────────────
    const ledger = await server.inject({
      method: 'GET',
      url: `/api/v2/organizations/${orgId}/finance/ledger`,
      headers: { 'x-organization-id': orgId },
    });
    expect(ledger.statusCode, JSON.stringify(ledger.json())).toBe(200);
    const entryTypes = ledger.json().items.map((e: { entryType: string }) => e.entryType);
    for (const expected of ['ticket_revenue', 'platform_fee', 'venue_share', 'host_payout']) {
      expect(entryTypes).toContain(expected);
    }
  });
});
