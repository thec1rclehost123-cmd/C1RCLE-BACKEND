import { createHmac, randomUUID } from 'node:crypto';

import {
  MemoryPaymentProvider,
  bookingReferenceForOrderId,
  createPlatformAdmin,
} from '@c1rcle/core/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryUserAccountRepository } from '@c1rcle/core/infrastructure';

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

  // Approval is gated on every required document being verified on the KYC
  // desk first — a separate admin action from the application decision.
  // Prove the gate is real before proving it opens.
  const blocked = await server.inject({
    method: 'POST',
    url: `/api/v2/admin/onboarding/applications/${requestId}/approve`,
    headers: asUser('ops_1'),
    payload: {},
  });
  expect(blocked.statusCode, JSON.stringify(blocked.json())).toBe(400);

  for (const label of ['id_front', 'id_back', 'selfie']) {
    const verify = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/documents/${label}/verify`,
      headers: asUser('ops_1'),
      payload: {},
    });
    expect(verify.statusCode, JSON.stringify(verify.json())).toBe(200);
  }

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
): Promise<{ eventId: string; tierId: string; venueId: string }> {
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

  return { eventId, tierId, venueId };
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

describe('scenario: KYC document reject, re-upload, request-changes, and the approve gate', () => {
  it('walks the full document review lifecycle through the real HTTP routes', async () => {
    const applicantId = 'applicant_kyc_1';
    const start = await server.inject({
      method: 'POST',
      url: '/api/v2/onboarding/applications',
      headers: asUser(applicantId),
      payload: { requestedType: 'venue', plan: 'basic', profile: FULL_PROFILE },
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

    await services
      .repos()
      .platformAdmins.save(
        createPlatformAdmin({ id: 'ops_kyc', email: 'ops.kyc@c1rcle.test', role: 'ops' }),
      );
    const admin = { ...asUser('ops_kyc'), 'idempotency-key': ik('admin-kyc') };

    // An admin may mint a read URL for one document without it being a decision.
    const readUrl = await server.inject({
      method: 'GET',
      url: `/api/v2/admin/onboarding/applications/${requestId}/documents/id_front/read-url`,
      headers: { 'x-user-id': 'ops_kyc' },
    });
    expect(readUrl.statusCode, JSON.stringify(readUrl.json())).toBe(200);
    expect(typeof readUrl.json().readUrl).toBe('string');

    // Reject one document — a reason is required.
    const reject = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/documents/id_front/reject`,
      headers: admin,
      payload: { reason: 'Photo is blurry, re-upload needed' },
    });
    expect(reject.statusCode, JSON.stringify(reject.json())).toBe(200);
    const afterReject = reject
      .json()
      .documents.find((d: { label: string }) => d.label === 'id_front');
    expect(afterReject.status).toBe('rejected');
    expect(afterReject.rejectionReason).toBe('Photo is blurry, re-upload needed');

    // The applicant re-uploads — the new copy must be pending again, never
    // inheriting the stale rejected status.
    const reupload = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/documents`,
      headers: asUser(applicantId),
      payload: { label: 'id_front', storagePath: `kyc/${applicantId}/id_front-v2.jpg` },
    });
    expect(reupload.statusCode).toBe(200);
    const afterReupload = reupload
      .json()
      .documents.find((d: { label: string }) => d.label === 'id_front');
    expect(afterReupload.status).toBe('pending');
    expect(afterReupload.rejectionReason).toBeNull();

    // Approval is still blocked — id_front is pending again after the re-upload.
    const stillBlocked = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/approve`,
      headers: admin,
      payload: {},
    });
    expect(stillBlocked.statusCode).toBe(400);

    for (const label of ['id_front', 'id_back', 'selfie']) {
      const verify = await server.inject({
        method: 'POST',
        url: `/api/v2/admin/onboarding/applications/${requestId}/documents/${label}/verify`,
        headers: { ...asUser('ops_kyc'), 'idempotency-key': ik(`verify-kyc-${label}`) },
      });
      expect(verify.statusCode, JSON.stringify(verify.json())).toBe(200);
    }

    const approve = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/approve`,
      headers: { ...asUser('ops_kyc'), 'idempotency-key': ik('approve-kyc') },
      payload: {},
    });
    expect(approve.statusCode, JSON.stringify(approve.json())).toBe(200);
  });

  it('requests changes with a note the applicant can read back on their own application', async () => {
    const applicantId = 'applicant_kyc_2';
    const start = await server.inject({
      method: 'POST',
      url: '/api/v2/onboarding/applications',
      headers: asUser(applicantId),
      payload: { requestedType: 'venue', plan: 'basic', profile: FULL_PROFILE },
    });
    const requestId: string = start.json().id;

    for (const label of ['id_front', 'id_back', 'selfie']) {
      await server.inject({
        method: 'POST',
        url: `/api/v2/onboarding/applications/${requestId}/documents`,
        headers: asUser(applicantId),
        payload: { label, storagePath: `kyc/${applicantId}/${label}.jpg` },
      });
    }
    await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/submit`,
      headers: asUser(applicantId),
    });

    await services
      .repos()
      .platformAdmins.save(
        createPlatformAdmin({ id: 'ops_kyc2', email: 'ops.kyc2@c1rcle.test', role: 'ops' }),
      );

    const requestChanges = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/request-changes`,
      headers: { ...asUser('ops_kyc2'), 'idempotency-key': ik('request-changes-kyc') },
      payload: { note: 'Your ID photo is cropped — please re-upload showing all four corners.' },
    });
    expect(requestChanges.statusCode, JSON.stringify(requestChanges.json())).toBe(200);
    expect(requestChanges.json().status).toBe('changes_requested');

    // The applicant's own view of the application must carry the same note —
    // this is what the partner-dashboard's changes-requested banner reads.
    const mine = await server.inject({
      method: 'GET',
      url: '/api/v2/onboarding/me',
      headers: asUser(applicantId),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().request.status).toBe('changes_requested');
    expect(mine.json().request.reviewNote).toBe(
      'Your ID photo is cropped — please re-upload showing all four corners.',
    );
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
    memoryProvider().simulateCapture(paymentId, grandTotalPaise, paymentIntentId);
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

    // ── Door admission (mint a door code over HTTP, redeem it, scan) ────────
    const codeResponse = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${eventId}/door-codes`,
      headers: { 'x-organization-id': orgId },
      payload: { type: 'full', gate: null, expiresAt: null },
    });
    expect(codeResponse.statusCode, JSON.stringify(codeResponse.json())).toBe(201);
    const doorCode: string = codeResponse.json().code;

    const deviceId = `device_scenario_${keySeq}`;
    const session = await server.inject({
      method: 'POST',
      url: '/api/v2/door/sessions',
      headers: { 'x-organization-id': orgId },
      payload: {
        eventId,
        code: doorCode,
        deviceId,
        deviceName: 'Gate iPad 1',
        sessionType: 'staff',
      },
    });
    expect(session.statusCode, JSON.stringify(session.json())).toBe(201);
    const scannerToken: string = session.json().sessionToken;
    expect(scannerToken).toEqual(expect.any(String));

    const checkIn = await server.inject({
      method: 'POST',
      url: '/api/v2/door/check-ins',
      headers: { 'x-organization-id': orgId, 'x-scanner-session-token': scannerToken },
      payload: { eventId, qrPayload: entitlementId, operatorName: 'Staff One' },
    });
    expect(checkIn.statusCode, JSON.stringify(checkIn.json())).toBe(200);
    expect(checkIn.json()).toMatchObject({ status: 'consumed', checkInId: expect.any(String) });

    // The same ticket a second time is refused — the entitlement was actually
    // spent, not merely logged.
    const replay = await server.inject({
      method: 'POST',
      url: '/api/v2/door/check-ins',
      headers: { 'x-organization-id': orgId, 'x-scanner-session-token': scannerToken },
      payload: { eventId, qrPayload: entitlementId },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'denied', denyReason: 'already_used' });

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

describe('scenario: M4 Promoter campaign attribution over the full API', () => {
  it('connects a Promoter, accepts event terms, attributes a paid order, and exposes scoped evidence', async () => {
    const { orgId: hostOrgId } = await onboardAndApproveHost(server);
    const { eventId, tierId, venueId } = await seedPublishedEvent(server, hostOrgId);

    // The memory driver deliberately exposes only a TEST FIXTURE agreement.
    // This exercises acceptance plumbing; it is not approved legal wording.
    const promoterUserId = 'promoter_m4_scenario';
    const agreement = await server.inject({
      method: 'GET',
      url: '/api/v2/onboarding/promoter-agreement',
      headers: asUser(promoterUserId),
    });
    expect(agreement.statusCode).toBe(200);
    expect(agreement.json()).toMatchObject({
      activationAvailable: false,
      agreement: {
        status: 'test_fixture',
        text: expect.stringContaining('NOT A LEGAL AGREEMENT'),
      },
    });

    const application = await server.inject({
      method: 'POST',
      url: '/api/v2/onboarding/applications',
      headers: asUser(promoterUserId),
      payload: {
        requestedType: 'promoter',
        plan: 'basic',
        profile: { ...FULL_PROFILE, legalName: 'M4 Scenario Promoter' },
      },
    });
    expect(application.statusCode, JSON.stringify(application.json())).toBe(201);
    const requestId: string = application.json().id;

    const acceptedAgreement = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/promoter-agreement/accept`,
      headers: asUser(promoterUserId),
      payload: { version: agreement.json().agreement.version },
    });
    expect(acceptedAgreement.statusCode, JSON.stringify(acceptedAgreement.json())).toBe(200);
    expect(acceptedAgreement.json().promoterAgreementAcceptances[0]).toMatchObject({
      artifactStatus: 'test_fixture',
      acceptedBy: promoterUserId,
    });

    for (const label of ['id_front', 'id_back', 'selfie']) {
      const document = await server.inject({
        method: 'POST',
        url: `/api/v2/onboarding/applications/${requestId}/documents`,
        headers: asUser(promoterUserId),
        payload: { label, storagePath: `kyc/${promoterUserId}/${label}.jpg` },
      });
      expect(document.statusCode, JSON.stringify(document.json())).toBe(200);
    }
    const submit = await server.inject({
      method: 'POST',
      url: `/api/v2/onboarding/applications/${requestId}/submit`,
      headers: asUser(promoterUserId),
    });
    expect(submit.statusCode, JSON.stringify(submit.json())).toBe(200);

    for (const label of ['id_front', 'id_back', 'selfie']) {
      const verify = await server.inject({
        method: 'POST',
        url: `/api/v2/admin/onboarding/applications/${requestId}/documents/${label}/verify`,
        headers: asUser('ops_1'),
        payload: {},
      });
      expect(verify.statusCode, JSON.stringify(verify.json())).toBe(200);
    }
    const approvePromoter = await server.inject({
      method: 'POST',
      url: `/api/v2/admin/onboarding/applications/${requestId}/approve`,
      headers: asUser('ops_1'),
      payload: {},
    });
    expect(approvePromoter.statusCode, JSON.stringify(approvePromoter.json())).toBe(200);
    const promoterOrgId: string = approvePromoter.json().organization.id;

    const promoterHeaders = {
      'x-user-id': promoterUserId,
      'x-organization-id': promoterOrgId,
      'idempotency-key': ik('promoter'),
    };
    const promoterCommandHeaders = (prefix: string) => ({
      ...promoterHeaders,
      'idempotency-key': ik(prefix),
    });
    const connection = await server.inject({
      method: 'POST',
      url: '/api/v2/promoter-connections',
      headers: promoterCommandHeaders('promoter-connect'),
      payload: { counterpartyId: hostOrgId, targetType: 'host', initiatedBy: 'promoter' },
    });
    expect(connection.statusCode, JSON.stringify(connection.json())).toBe(201);
    const connectionId: string = connection.json().id;
    const connectionApproval = await server.inject({
      method: 'POST',
      url: `/api/v2/promoter-connections/${connectionId}/approve`,
      headers: host(hostOrgId),
    });
    expect(connectionApproval.statusCode, JSON.stringify(connectionApproval.json())).toBe(200);
    expect(connectionApproval.json().status).toBe('active');

    const freeEvent = await server.inject({
      method: 'POST',
      url: `/api/v2/organizations/${hostOrgId}/events`,
      headers: host(hostOrgId),
      payload: {
        title: 'M4 Free RSVP Night',
        venueId,
        startAt: '2026-11-01T18:00:00Z',
      },
    });
    expect(freeEvent.statusCode, JSON.stringify(freeEvent.json())).toBe(201);
    const freeEventId: string = freeEvent.json().id;
    const freeTier = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${freeEventId}/ticket-tiers`,
      headers: host(hostOrgId),
      payload: { name: 'Free RSVP', accessType: 'RSVP', quantity: 50 },
    });
    expect(freeTier.statusCode, JSON.stringify(freeTier.json())).toBe(201);
    for (const action of ['review', 'publish']) {
      const transition = await server.inject({
        method: 'POST',
        url: `/api/v2/events/${freeEventId}/${action}`,
        headers: host(hostOrgId),
      });
      expect(transition.statusCode, JSON.stringify(transition.json())).toBe(200);
    }

    const invalidFreeAssignment = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${freeEventId}/promoter-assignments`,
      headers: host(hostOrgId),
      payload: {
        promoterId: promoterOrgId,
        ratePercent: 1,
        flatPaise: 0,
        eligibleTierIds: [],
      },
    });
    expect(invalidFreeAssignment.statusCode).toBe(400);

    const freeAssignment = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${freeEventId}/promoter-assignments`,
      headers: host(hostOrgId),
      payload: {
        promoterId: promoterOrgId,
        ratePercent: 0,
        flatPaise: 0,
        eligibleTierIds: [],
      },
    });
    expect(freeAssignment.statusCode, JSON.stringify(freeAssignment.json())).toBe(201);
    const freeAssignmentAccept = await server.inject({
      method: 'POST',
      url: `/api/v2/promoter-assignments/${freeAssignment.json().id}/respond`,
      headers: promoterCommandHeaders('promoter-free-rsvp'),
      payload: { decision: 'accept', expectedVersion: freeAssignment.json().version },
    });
    expect(freeAssignmentAccept.statusCode, JSON.stringify(freeAssignmentAccept.json())).toBe(200);
    const freeLink = await server.inject({
      method: 'POST',
      url: `/api/v2/promoter-assignments/${freeAssignment.json().id}/referral-links`,
      headers: promoterCommandHeaders('promoter-free-link'),
      payload: { label: 'Free RSVP campaign' },
    });
    expect(freeLink.statusCode, JSON.stringify(freeLink.json())).toBe(201);
    const now = Date.now();
    (services.repos().users as MemoryUserAccountRepository).save({
      id: 'guest_m4_rsvp',
      email: 'guest-m4-rsvp@example.test',
      name: 'M4 RSVP Guest',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: now,
      updatedAt: now,
    });
    const rsvp = await server.inject({
      method: 'POST',
      url: '/api/v2/rsvp',
      headers: { 'x-user-id': 'guest_m4_rsvp', 'idempotency-key': ik('m4-rsvp') },
      payload: {
        eventId: freeEventId,
        tierId: freeTier.json().id,
        referralCode: freeLink.json().code,
      },
    });
    expect(rsvp.statusCode, JSON.stringify(rsvp.json())).toBe(201);
    const rsvpOrder = await services.repos().orders.getById(rsvp.json().order.id);
    expect(rsvpOrder).toMatchObject({
      subtotalPaise: 0,
      grandTotalPaise: 0,
      attribution: {
        promoterId: promoterOrgId,
        assignmentId: freeAssignment.json().id,
        referralLinkId: freeLink.json().id,
        promoterCommissionPaise: 0,
      },
    });

    const assignment = await server.inject({
      method: 'POST',
      url: `/api/v2/events/${eventId}/promoter-assignments`,
      headers: host(hostOrgId),
      payload: { promoterId: promoterOrgId, ratePercent: 10, eligibleTierIds: [tierId] },
    });
    expect(assignment.statusCode, JSON.stringify(assignment.json())).toBe(201);
    const assignmentId: string = assignment.json().id;
    const acceptedAssignment = await server.inject({
      method: 'POST',
      url: `/api/v2/promoter-assignments/${assignmentId}/respond`,
      headers: promoterCommandHeaders('promoter-paid-accept'),
      payload: { decision: 'accept', expectedVersion: assignment.json().version },
    });
    expect(acceptedAssignment.statusCode, JSON.stringify(acceptedAssignment.json())).toBe(200);
    expect(acceptedAssignment.json().status).toBe('accepted');

    const link = await server.inject({
      method: 'POST',
      url: `/api/v2/promoter-assignments/${assignmentId}/referral-links`,
      headers: promoterCommandHeaders('promoter-paid-link'),
      payload: { label: 'M4 API scenario' },
    });
    expect(link.statusCode, JSON.stringify(link.json())).toBe(201);
    const referralCode: string = link.json().code;

    const publicEvent = await server.inject({
      method: 'GET',
      url: `/api/v2/public/events/${eventId}`,
    });
    expect(publicEvent.statusCode).toBe(200);
    const clickId = randomUUID();
    const click = await server.inject({
      method: 'POST',
      url: '/api/v2/public/promoter-links/click',
      payload: { eventSlug: publicEvent.json().slug, code: referralCode, clickId },
    });
    expect(click.statusCode).toBe(200);
    expect(click.json()).toEqual({ accepted: true });
    const duplicateClick = await server.inject({
      method: 'POST',
      url: '/api/v2/public/promoter-links/click',
      payload: { eventSlug: publicEvent.json().slug, code: referralCode, clickId },
    });
    expect(duplicateClick.statusCode).toBe(200);
    expect(duplicateClick.json()).toEqual({ accepted: true });
    const invalidCodeClick = await server.inject({
      method: 'POST',
      url: '/api/v2/public/promoter-links/click',
      payload: { eventSlug: publicEvent.json().slug, code: 'UNKNOWN', clickId: randomUUID() },
    });
    expect(invalidCodeClick.statusCode).toBe(200);
    expect(invalidCodeClick.json()).toEqual({ accepted: true });

    const guestUserId = 'guest_m4_scenario';
    const checkoutLines = [{ tierId, quantity: 1 }];
    const quote = await server.inject({
      method: 'POST',
      url: '/api/v2/checkout/quote',
      headers: { 'x-user-id': guestUserId },
      payload: { eventId, lines: checkoutLines, referralCode },
    });
    expect(quote.statusCode, JSON.stringify(quote.json())).toBe(200);
    expect(quote.json()).not.toHaveProperty('referralAttributionStatus');

    const holdHeaders = { 'x-user-id': guestUserId, 'idempotency-key': ik('m4-hold') };
    const hold = await server.inject({
      method: 'POST',
      url: '/api/v2/checkout/holds',
      headers: holdHeaders,
      payload: { eventId, lines: checkoutLines, referralCode },
    });
    expect(hold.statusCode, JSON.stringify(hold.json())).toBe(201);
    const holdId: string = hold.json().holdId;
    const holdRetry = await server.inject({
      method: 'POST',
      url: '/api/v2/checkout/holds',
      headers: holdHeaders,
      payload: { eventId, lines: checkoutLines, referralCode },
    });
    expect(holdRetry.statusCode).toBe(201);
    expect(holdRetry.json().holdId).toBe(holdId);

    const attemptHeaders = { 'x-user-id': guestUserId, 'idempotency-key': ik('m4-attempt') };
    const attempt = await server.inject({
      method: 'POST',
      url: '/api/v2/payments/attempts',
      headers: attemptHeaders,
      payload: { holdId },
    });
    expect(attempt.statusCode, JSON.stringify(attempt.json())).toBe(201);
    const paymentIntentId: string = attempt.json().paymentIntentId;
    const attemptRetry = await server.inject({
      method: 'POST',
      url: '/api/v2/payments/attempts',
      headers: attemptHeaders,
      payload: { holdId },
    });
    expect(attemptRetry.statusCode).toBe(201);
    expect(attemptRetry.json().paymentIntentId).toBe(paymentIntentId);

    const paymentId = `pay_m4_scenario_${keySeq}`;
    memoryProvider().simulateCapture(paymentId, quote.json().grandTotalPaise, paymentIntentId);
    const body = webhookPayload({ id: paymentId, order_id: paymentIntentId, holdId });
    const webhook = await server.inject({
      method: 'POST',
      url: '/api/v2/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    expect(webhook.statusCode, JSON.stringify(webhook.json())).toBe(200);
    const webhookReplay = await server.inject({
      method: 'POST',
      url: '/api/v2/webhooks/payments/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': sign(body) },
      payload: body,
    });
    expect(webhookReplay.statusCode, JSON.stringify(webhookReplay.json())).toBe(200);

    const order = await services.repos().orders.getById(`ORD-${paymentId}`);
    expect(order?.status).toBe('paid');
    expect(order?.attribution).toMatchObject({
      promoterId: promoterOrgId,
      assignmentId,
      referralLinkId: link.json().id,
      code: referralCode,
    });
    const bookingReference =
      order?.bookingReference ?? bookingReferenceForOrderId(`ORD-${paymentId}`);

    const promoterSummary = await server.inject({
      method: 'GET',
      url: `/api/v2/promoters/${promoterOrgId}/campaign-summary`,
      headers: promoterHeaders,
    });
    expect(promoterSummary.statusCode, JSON.stringify(promoterSummary.json())).toBe(200);
    expect(promoterSummary.json()).toMatchObject({ clicks: 1, conversions: 2 });

    const attributedOrders = await server.inject({
      method: 'GET',
      url: `/api/v2/events/${eventId}/promoters/${promoterOrgId}/attributed-orders`,
      headers: host(hostOrgId),
    });
    expect(attributedOrders.statusCode, JSON.stringify(attributedOrders.json())).toBe(200);
    expect(attributedOrders.json().items).toHaveLength(1);
    expect(JSON.stringify(attributedOrders.json())).not.toContain(guestUserId);

    const investigation = await server.inject({
      method: 'GET',
      url: `/api/v2/admin/orders/by-booking-reference/${bookingReference}`,
      headers: asUser('ops_1'),
    });
    expect(investigation.statusCode, JSON.stringify(investigation.json())).toBe(200);
    expect(investigation.json().attribution).toMatchObject({
      promoterId: promoterOrgId,
      assignmentId,
      referralLinkId: link.json().id,
    });
    expect(investigation.json().journals.length).toBeGreaterThan(0);
  });
});
