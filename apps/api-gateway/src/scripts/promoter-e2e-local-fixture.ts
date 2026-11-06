/* eslint-disable no-restricted-syntax -- Loopback-only synthetic acceptance fixture with emulator cleanup. */
import { randomUUID } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';

import {
  MemoryPaymentProvider,
  createEvent,
  createOrganization,
  createPlatformAdmin,
  createTicketTier,
} from '@c1rcle/core/domain';

import { createPartnerRefinementFixture } from './partner-refinement-fixture.js';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulatorHost || !/^(127\.0\.0\.1|localhost):\d+$/u.test(emulatorHost)) {
  throw new Error('A loopback Firestore Emulator is required');
}
if (process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
  throw new Error('Set FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099');
}

const fixture = await createPartnerRefinementFixture({
  browserOrigins: ['http://localhost:3200', 'http://localhost:3300'],
});
const { app, db, services } = fixture;
const dataPath = '/tmp/c1rcle-promoter-e2e-local.json';
let fixtureClosed = false;
const closeFixture = async () => {
  if (fixtureClosed) return;
  fixtureClosed = true;
  try {
    await fixture.close();
  } finally {
    await rm(dataPath, { force: true });
  }
};
process.once('unhandledRejection', (reason: unknown) => {
  void closeFixture().finally(() => {
    console.error(reason instanceof Error ? reason.message : 'Local fixture failed');
    process.exit(1);
  });
});
process.once('uncaughtException', (error: Error) => {
  void closeFixture().finally(() => {
    console.error(error.message);
    process.exit(1);
  });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void closeFixture().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}
const provider = new MemoryPaymentProvider('synthetic-local-capture-key');
const mutableServices = services as unknown as {
  paymentProvider: MemoryPaymentProvider;
  checkout: { deps: { paymentProvider: MemoryPaymentProvider } };
};
mutableServices.paymentProvider = provider;
mutableServices.checkout.deps.paymentProvider = provider;
services.emailSender.sendOtpEmail = async () => {};
services.emailSender.sendPasswordResetEmail = async () => {};
services.emailSender.sendStaffInvitationEmail = async () => {};
services.emailSender.sendOnboardingChangesRequestedEmail = async () => {};

interface Identity {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

const accounts = new Map<string, Identity>();
for (const account of fixture.accounts) {
  const body = await accountBody(account.id);
  accounts.set(account.persona, body);
}

async function accountBody(id: string): Promise<Identity> {
  const user = await db.collection('v2_auth_users').doc(id).get();
  const email = String(user.get('email') ?? '');
  const existing = fixture.accounts.find((account) => account.id === id);
  return {
    id,
    email,
    password: existing?.password ?? '',
    accessToken: existing?.headers.authorization.replace(/^Bearer\s+/u, '') ?? '',
  };
}

async function signUp(key: string, displayName: string): Promise<Identity> {
  const email = `${key}@${fixture.projectId}.invalid`;
  const password = 'Synthetic-promoter-acceptance-2026';
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/partner/signup',
    payload: { email, password, displayName },
  });
  if (response.statusCode !== 201) throw new Error(`${key} signup failed: ${response.statusCode}`);
  const result = response.json<{ user: { id: string }; accessToken: string }>();
  await db.collection('v2_auth_users').doc(result.user.id).update({ emailVerified: true });
  const identity = { id: result.user.id, email, password, accessToken: result.accessToken };
  accounts.set(key, identity);
  return identity;
}

function auth(identity: Identity, organizationId?: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${identity.accessToken}`,
    ...(organizationId ? { 'x-organization-id': organizationId } : {}),
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

async function request<T>(options: {
  method: 'GET' | 'POST';
  path: string;
  identity?: Identity;
  organizationId?: string;
  body?: unknown;
}): Promise<T> {
  const headers: Record<string, string> = options.identity
    ? auth(options.identity, options.organizationId, `local-${randomUUID()}`)
    : {};
  const url = `/api/v2${options.path}`;
  const response =
    options.method === 'GET'
      ? await app.inject({ method: 'GET', url, headers })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify(options.body ?? {}),
        });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const failure = response.json<{ error?: string; message?: string }>();
    throw new Error(
      `${options.method} ${options.path} failed: ${response.statusCode} ${failure.error ?? 'unknown'} ${failure.message ?? ''}`.trim(),
    );
  }
  return response.json<T>();
}

async function assertDenied(options: {
  method: 'GET' | 'POST';
  path: string;
  identity: Identity;
  organizationId?: string;
  body?: unknown;
}) {
  const headers = auth(options.identity, options.organizationId, `local-${randomUUID()}`);
  const response =
    options.method === 'GET'
      ? await app.inject({ method: 'GET', url: `/api/v2${options.path}`, headers })
      : await app.inject({
          method: 'POST',
          url: `/api/v2${options.path}`,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify(options.body ?? {}),
        });
  if (response.statusCode !== 403 && response.statusCode !== 404) {
    throw new Error(
      `Expected cross-tenant denial for ${options.method} ${options.path}, got ${response.statusCode}`,
    );
  }
}

const promoterProfile = {
  legalName: 'Synthetic Night Shift Collective',
  contactPerson: 'Synthetic Promoter',
  phone: '9876543210',
  city: 'Mumbai',
  kyc: {
    identity: { idType: 'passport', idNumber: 'P1234567' },
    business: { pan: 'ABCDE1234F', address: 'Synthetic acceptance address' },
    signatory: {
      fullName: 'Synthetic Applicant',
      designation: 'director',
      email: 'promoter@example.invalid',
      idType: 'passport',
      idNumber: 'P1234567',
      declared: true,
    },
  },
};

const admin = await signUp('local-admin', 'Synthetic Admin');
await services
  .repos()
  .platformAdmins.save(createPlatformAdmin({ id: admin.id, email: admin.email, role: 'ops' }));

async function applyAndApprovePromoter(identity: Identity): Promise<string> {
  const agreement = await request<{ agreement: { version: string } }>({
    method: 'GET',
    path: '/onboarding/promoter-agreement',
    identity,
  });
  const application = await request<{ id: string }>({
    method: 'POST',
    path: '/onboarding/applications',
    identity,
    body: { requestedType: 'promoter', plan: 'basic', profile: promoterProfile },
  });
  await request({
    method: 'POST',
    path: `/onboarding/applications/${application.id}/promoter-agreement/accept`,
    identity,
    body: { version: agreement.agreement.version },
  });
  for (const label of ['id_front', 'id_back', 'selfie']) {
    await request({
      method: 'POST',
      path: `/onboarding/applications/${application.id}/documents`,
      identity,
      body: { label, storagePath: `kyc/${identity.id}/${application.id}/${label}` },
    });
  }
  await request({
    method: 'POST',
    path: `/onboarding/applications/${application.id}/submit`,
    identity,
  });
  for (const label of ['id_front', 'id_back', 'selfie']) {
    await request({
      method: 'POST',
      path: `/admin/onboarding/applications/${application.id}/documents/${label}/verify`,
      identity: admin,
    });
  }
  const approval = await request<{
    request: { provisionedOrganizationId: string };
  }>({
    method: 'POST',
    path: `/admin/onboarding/applications/${application.id}/approve`,
    identity: admin,
    body: { note: 'Synthetic local acceptance fixture approval' },
  });
  return approval.request.provisionedOrganizationId;
}

const promoterA = await signUp('local-promoter-a', 'Synthetic Promoter A');
const promoterB = await signUp('local-promoter-b', 'Synthetic Promoter B');
const promoterAOrgId = await applyAndApprovePromoter(promoterA);
const promoterBOrgId = await applyAndApprovePromoter(promoterB);
const hostA = accounts.get('partner');
if (!hostA) throw new Error('Host account missing');
const hostB = await signUp('local-host-b', 'Synthetic Host B');

const hostAOrgId = `local_host_a_${fixture.projectId.slice(-8)}`;
const hostBOrgId = `local_host_b_${fixture.projectId.slice(-8)}`;
for (const [id, owner, name] of [
  [hostAOrgId, hostA, 'Synthetic Host A'],
  [hostBOrgId, hostB, 'Synthetic Host B'],
] as const) {
  await services.repos().organizations.save(
    createOrganization({
      id,
      ownerId: owner.id,
      name,
      slug: id.replaceAll('_', '-'),
      capabilities: ['host'],
    }),
  );
}

async function connectPromoter(identity: Identity, promoterOrgId: string, hostOrgId: string) {
  const connection = await request<{ id: string }>({
    method: 'POST',
    path: '/promoter-connections',
    identity,
    organizationId: promoterOrgId,
    body: { counterpartyId: hostOrgId, targetType: 'host', initiatedBy: 'promoter' },
  });
  await request({
    method: 'POST',
    path: `/promoter-connections/${connection.id}/approve`,
    identity: hostA,
    organizationId: hostOrgId,
  });
}

await connectPromoter(promoterA, promoterAOrgId, hostAOrgId);
await connectPromoter(promoterB, promoterBOrgId, hostAOrgId);

const futureStart = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
async function seedEvent(hostOrgId: string, title: string) {
  const eventId = `local_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const draft = createEvent({
    id: eventId,
    organizationId: hostOrgId,
    venueId: `local_venue_${hostOrgId}`,
    title,
    startAt: futureStart,
    summary: 'Synthetic local Promoter acceptance event',
  });
  const event = {
    ...draft,
    status: 'published' as const,
    isPublic: true,
    isFree: false,
    startingPricePaise: 12_000,
    capacity: 100,
  };
  await services.repos().events.save(event);
  const paidTier = createTicketTier({
    id: `local_paid_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
    eventId,
    organizationId: hostOrgId,
    name: 'General Admission',
    priceInPaise: 12_000,
    quantity: 100,
  });
  const rsvpTier = createTicketTier({
    id: `local_rsvp_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
    eventId,
    organizationId: hostOrgId,
    name: 'Free RSVP',
    quantity: 100,
    accessType: 'RSVP',
  });
  await services.repos().catalog.saveTier(paidTier);
  await services.repos().catalog.saveTier(rsvpTier);
  return { eventId, slug: event.slug, paidTierId: paidTier.id, rsvpTierId: rsvpTier.id };
}

const eventA = await seedEvent(hostAOrgId, 'Synthetic Promoter Night A');
const eventB = await seedEvent(hostBOrgId, 'Synthetic Promoter Night B');
const eventUi = await seedEvent(hostAOrgId, 'Synthetic Host Invitation UI');
const eventUiDecline = await seedEvent(hostAOrgId, 'Synthetic Host Decline UI');

async function invite(
  hostOrgId: string,
  eventId: string,
  promoterId: string,
  owner: Identity,
  eligibleTierIds?: string[],
) {
  const assignment = await request<{ id: string; version: number }>({
    method: 'POST',
    path: `/events/${eventId}/promoter-assignments`,
    identity: owner,
    organizationId: hostOrgId,
    body: {
      promoterId,
      ratePercent: 10,
      flatPaise: 0,
      ...(eligibleTierIds ? { eligibleTierIds } : {}),
    },
  });
  return assignment;
}

const assignmentA = await invite(hostAOrgId, eventA.eventId, promoterAOrgId, hostA);
const assignmentB = await invite(hostAOrgId, eventA.eventId, promoterBOrgId, hostA);
const assignmentUi = await invite(hostAOrgId, eventUi.eventId, promoterAOrgId, hostA);
const assignmentUiDecline = await invite(hostAOrgId, eventUiDecline.eventId, promoterAOrgId, hostA);
for (const [assignment, identity, promoterOrgId] of [
  [assignmentA, promoterA, promoterAOrgId],
  [assignmentB, promoterB, promoterBOrgId],
] as const) {
  await request({
    method: 'POST',
    path: `/promoter-assignments/${assignment.id}/respond`,
    identity,
    organizationId: promoterOrgId,
    body: { decision: 'accept', expectedVersion: assignment.version },
  });
}

const linkA = await request<{ id: string; code: string }>({
  method: 'POST',
  path: `/promoter-assignments/${assignmentA.id}/referral-links`,
  identity: promoterA,
  organizationId: promoterAOrgId,
  body: { label: 'Synthetic A' },
});
const linkB = await request<{ id: string; code: string }>({
  method: 'POST',
  path: `/promoter-assignments/${assignmentB.id}/referral-links`,
  identity: promoterB,
  organizationId: promoterBOrgId,
  body: { label: 'Synthetic B' },
});

const guest = accounts.get('guest-a');
if (!guest) throw new Error('Guest account missing');
const click = async (code: string, previousToken?: string) =>
  request<{ accepted: true; contextToken: string }>({
    method: 'POST',
    path: '/public/promoter-links/click',
    body: {
      eventSlug: eventA.slug,
      code,
      clickId: randomUUID(),
      ...(previousToken ? { contextToken: previousToken } : {}),
    },
  });
const clickA = await click(linkA.code);
const clickB = await click(linkB.code, clickA.contextToken);

const quote = await request<{ grandTotalPaise: number }>({
  method: 'POST',
  path: '/checkout/quote',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    lines: [{ tierId: eventA.paidTierId, quantity: 1 }],
    referralContextTokens: [clickB.contextToken],
  },
});
const hold = await request<{ holdId: string; pricing: { grandTotalPaise: number } }>({
  method: 'POST',
  path: '/checkout/holds',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    lines: [{ tierId: eventA.paidTierId, quantity: 1 }],
    referralContextTokens: [clickB.contextToken],
  },
});
const attempt = await request<{
  paymentIntentId: string;
  amountPaise: number;
}>({
  method: 'POST',
  path: '/payments/attempts',
  identity: guest,
  body: { holdId: hold.holdId },
});
if (quote.grandTotalPaise !== attempt.amountPaise) {
  throw new Error('Synthetic checkout amount did not match its authoritative quote');
}
const paymentId = `pay_local_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
provider.simulateCapture(paymentId, attempt.amountPaise, attempt.paymentIntentId);
const signature = provider.generateSignature({
  paymentId,
  orderId: attempt.paymentIntentId,
});
const paid = await request<{ order: { id: string } }>({
  method: 'POST',
  path: `/payments/${paymentId}/verify`,
  identity: guest,
  body: { holdId: hold.holdId, paymentIntentId: attempt.paymentIntentId, signature },
});
const paidOrder = await services.repos().orders.getById(paid.order.id);
if (paidOrder?.attribution?.promoterId !== promoterBOrgId) {
  throw new Error('Latest valid promoter click did not receive the synthetic conversion');
}
await request({
  method: 'POST',
  path: `/payments/${paymentId}/verify`,
  identity: guest,
  body: { holdId: hold.holdId, paymentIntentId: attempt.paymentIntentId, signature },
});

const isolatedHoldResponse = await request<{ holdId: string }>({
  method: 'POST',
  path: '/checkout/holds',
  identity: guest,
  body: {
    eventId: eventB.eventId,
    lines: [{ tierId: eventB.paidTierId, quantity: 1 }],
    referralContextTokens: [clickB.contextToken],
  },
});
const isolatedHold = await services.repos().cartReservations.getById(isolatedHoldResponse.holdId);
if (isolatedHold?.attribution) throw new Error('Event A context leaked into Event B');

const abandonedHold = await request<{ holdId: string }>({
  method: 'POST',
  path: '/checkout/holds',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    lines: [{ tierId: eventA.paidTierId, quantity: 1 }],
    referralContextTokens: [clickB.contextToken],
  },
});
const abandonedAttempt = await request<{ paymentIntentId: string }>({
  method: 'POST',
  path: '/payments/attempts',
  identity: guest,
  body: { holdId: abandonedHold.holdId },
});
const abandonedReservation = await services.repos().cartReservations.getById(abandonedHold.holdId);
if (!abandonedAttempt.paymentIntentId || abandonedReservation?.convertedOrderId !== null) {
  throw new Error('Abandoned checkout unexpectedly created an order');
}

const rsvp = await request<{
  order: { id: string; attribution: { promoterId: string } | null };
}>({
  method: 'POST',
  path: '/rsvp',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    tierId: eventA.rsvpTierId,
    referralContextTokens: [clickB.contextToken],
  },
});
const storedRsvpOrder = await services.repos().orders.getById(rsvp.order.id);
if (storedRsvpOrder?.attribution?.promoterId !== promoterBOrgId) {
  const liveContext = await services.referralLinks.resolveClickContexts(
    eventA.eventId,
    [clickB.contextToken],
    guest.id,
  );
  throw new Error(
    `Free RSVP attribution mismatch (order=${rsvp.order.id}, context=${String(liveContext?.promoterId ?? null)}, stored=${String(storedRsvpOrder?.attribution?.promoterId ?? null)})`,
  );
}

const guestB = accounts.get('guest-b');
if (!guestB) throw new Error('Second synthetic Guest account missing');
const summaryBeforeTransfer = await request<{
  conversions: number;
  grossAttributedTicketSalesPaise: number;
  netAttributedTicketSalesPaise: number;
}>({
  method: 'GET',
  path: `/promoters/${promoterBOrgId}/campaign-summary`,
  identity: promoterB,
  organizationId: promoterBOrgId,
});
const paidEntitlements = await services.repos().entitlements.getByOrderId(paid.order.id);
const firstPaidEntitlement = paidEntitlements[0];
if (!firstPaidEntitlement) throw new Error('Synthetic paid order did not issue a ticket');
// Online ticket transfers are an existing V1 path. The local test disables
// only offline manifests so the API can exercise the online transfer flow.
services.config().features.m5OfflineTicketManifests = false;
const transfer = await request<{ id: string }>({
  method: 'POST',
  path: `/tickets/${firstPaidEntitlement.id}/transfers`,
  identity: guest,
  body: { recipientEmail: guestB.email },
});
await request({
  method: 'POST',
  path: `/ticket-transfers/${transfer.id}/accept`,
  identity: guestB,
});
const transferredEntitlement = await services.repos().entitlements.getById(firstPaidEntitlement.id);
const summaryAfterTransfer = await request<{ conversions: number }>({
  method: 'GET',
  path: `/promoters/${promoterBOrgId}/campaign-summary`,
  identity: promoterB,
  organizationId: promoterBOrgId,
});
if (
  transferredEntitlement?.currentHolderUserId !== guestB.id ||
  summaryAfterTransfer.conversions !== summaryBeforeTransfer.conversions ||
  (await services.repos().orders.getById(paid.order.id))?.attribution?.promoterId !== promoterBOrgId
) {
  throw new Error('Ticket transfer changed the original Promoter acquisition');
}

const paidOrderForRefund = await services.repos().orders.getById(paid.order.id);
if (!paidOrderForRefund) throw new Error('Synthetic paid order missing before refund');
const refund = await request<{ request: { id: string } }>({
  method: 'POST',
  path: '/admin/refunds',
  identity: admin,
  body: {
    orderId: paidOrderForRefund.id,
    refundCause: 'guest_request',
    reason: 'Synthetic local Promoter analytics acceptance refund',
  },
});
await request({
  method: 'POST',
  path: `/admin/refunds/${refund.request.id}/execute`,
  identity: admin,
});
const refundedOrder = await services.repos().orders.getById(paid.order.id);
const refundedTicket = await services.repos().entitlements.getById(firstPaidEntitlement.id);
const summaryAfterRefund = await request<{
  conversions: number;
  grossAttributedTicketSalesPaise: number;
  refundedAttributedTicketSalesPaise: number;
  netAttributedTicketSalesPaise: number;
  refundValueComplete: boolean;
}>({
  method: 'GET',
  path: `/promoters/${promoterBOrgId}/campaign-summary`,
  identity: promoterB,
  organizationId: promoterBOrgId,
});
if (
  !refundedOrder ||
  refundedOrder.refundedPaise <= 0 ||
  !refundedOrder.refundedTicketClaims?.some(
    (claim) => claim.entitlementId === firstPaidEntitlement.id,
  ) ||
  refundedTicket?.status !== 'void' ||
  summaryAfterRefund.conversions !== summaryBeforeTransfer.conversions ||
  summaryAfterRefund.grossAttributedTicketSalesPaise !==
    summaryBeforeTransfer.grossAttributedTicketSalesPaise ||
  !summaryAfterRefund.refundValueComplete ||
  summaryAfterRefund.netAttributedTicketSalesPaise !==
    summaryAfterRefund.grossAttributedTicketSalesPaise -
      summaryAfterRefund.refundedAttributedTicketSalesPaise
) {
  throw new Error(
    `Refund acceptance mismatch: status=${String(refundedOrder?.status)}, refundedPaise=${String(refundedOrder?.refundedPaise)}, ticketStatus=${String(refundedTicket?.status)}, conversions=${summaryAfterRefund.conversions}/${summaryBeforeTransfer.conversions}, gross=${summaryAfterRefund.grossAttributedTicketSalesPaise}/${summaryBeforeTransfer.grossAttributedTicketSalesPaise}, refunded=${summaryAfterRefund.refundedAttributedTicketSalesPaise}, net=${summaryAfterRefund.netAttributedTicketSalesPaise}, refundComplete=${summaryAfterRefund.refundValueComplete}`,
  );
}

const hostAnalytics = await request<{
  eventId: string;
  historicalConversionCount: number;
  historicalRsvpConversionCount: number;
  activeRsvpCount: number;
  grossAttributedTicketValuePaise: number;
  refundedAttributedTicketValuePaise: number;
  netAttributedTicketValuePaise: number;
}>({
  method: 'GET',
  path: `/events/${eventA.eventId}/promoter-analytics`,
  identity: hostA,
  organizationId: hostAOrgId,
});
if (
  hostAnalytics.eventId !== eventA.eventId ||
  hostAnalytics.historicalConversionCount !== summaryAfterRefund.conversions ||
  hostAnalytics.historicalRsvpConversionCount !== 1 ||
  hostAnalytics.activeRsvpCount !== 1 ||
  hostAnalytics.grossAttributedTicketValuePaise !==
    summaryAfterRefund.grossAttributedTicketSalesPaise ||
  hostAnalytics.refundedAttributedTicketValuePaise !==
    summaryAfterRefund.refundedAttributedTicketSalesPaise ||
  hostAnalytics.netAttributedTicketValuePaise !== summaryAfterRefund.netAttributedTicketSalesPaise
) {
  throw new Error('Host Promoter analytics do not match canonical acquisition and refund state');
}

const assignmentABeforeRevocation = await services
  .repos()
  .catalog.getAssignmentById(assignmentA.id);
if (!assignmentABeforeRevocation) throw new Error('Synthetic assignment A missing before revoke');
await request({
  method: 'POST',
  path: `/promoter-assignments/${assignmentA.id}/revoke`,
  identity: hostA,
  organizationId: hostAOrgId,
  body: {
    expectedVersion: assignmentABeforeRevocation.version,
    reason: 'Synthetic local revocation acceptance',
  },
});
const revokedClick = await click(linkA.code);
const revokedQuote = await request<{
  attribution: { promoterId: string } | null;
}>({
  method: 'POST',
  path: '/checkout/quote',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    lines: [{ tierId: eventA.paidTierId, quantity: 1 }],
    referralContextTokens: [revokedClick.contextToken],
  },
});
if (
  (revokedQuote.attribution !== null && revokedQuote.attribution !== undefined) ||
  (await services.repos().orders.getById(paid.order.id))?.attribution?.promoterId !==
    promoterBOrgId ||
  storedRsvpOrder?.attribution?.promoterId !== promoterBOrgId
) {
  throw new Error('Revocation acceptance failed to deny future attribution or preserve history');
}

await assertDenied({
  method: 'GET',
  path: `/promoters/${promoterBOrgId}/campaign-summary`,
  identity: promoterA,
  organizationId: promoterAOrgId,
});
await assertDenied({
  method: 'GET',
  path: `/organizations/${hostBOrgId}/finance/balance`,
  identity: promoterA,
  organizationId: promoterAOrgId,
});
await assertDenied({
  method: 'POST',
  path: `/promoter-assignments/${assignmentB.id}/referral-links`,
  identity: promoterA,
  organizationId: promoterAOrgId,
  body: { label: 'Cross-tenant denial probe' },
});
await assertDenied({
  method: 'POST',
  path: `/events/${eventB.eventId}/promoter-assignments`,
  identity: hostA,
  organizationId: hostAOrgId,
  body: { promoterId: promoterAOrgId, ratePercent: 10, flatPaise: 0 },
});
await assertDenied({
  method: 'GET',
  path: `/events/${eventB.eventId}/promoter-analytics`,
  identity: hostA,
  organizationId: hostAOrgId,
});
await assertDenied({
  method: 'GET',
  path: `/events/${eventA.eventId}/promoter-analytics`,
  identity: promoterB,
  organizationId: promoterBOrgId,
});

await services.adminOps.suspendPromoter(
  admin.id,
  promoterBOrgId,
  'Synthetic local suspension acceptance',
);
await services.adminOps.suspendPromoter(
  admin.id,
  promoterBOrgId,
  'Synthetic repeated suspension acceptance',
);
const suspendedClick = await request<{ accepted: true; contextToken: string }>({
  method: 'POST',
  path: '/public/promoter-links/click',
  body: {
    eventSlug: eventA.slug,
    code: linkB.code,
    clickId: randomUUID(),
  },
});
const suspendedQuote = await request<{
  grandTotalPaise: number;
  attribution: { promoterId: string } | null;
}>({
  method: 'POST',
  path: '/checkout/quote',
  identity: guest,
  body: {
    eventId: eventA.eventId,
    lines: [{ tierId: eventA.paidTierId, quantity: 1 }],
    referralContextTokens: [suspendedClick.contextToken, clickB.contextToken],
  },
});
const suspendedRsvp = await request<{ order: { id: string } }>({
  method: 'POST',
  path: '/rsvp',
  // RSVP is one-per-user/event. Use a second synthetic Guest so this probe
  // creates a new RSVP instead of returning the earlier attributed record.
  identity: guestB,
  body: {
    eventId: eventA.eventId,
    tierId: eventA.rsvpTierId,
    referralContextTokens: [suspendedClick.contextToken, clickB.contextToken],
  },
});
const suspendedRsvpOrder = await services.repos().orders.getById(suspendedRsvp.order.id);
if (
  (suspendedQuote.attribution !== null && suspendedQuote.attribution !== undefined) ||
  (suspendedRsvpOrder?.attribution !== null && suspendedRsvpOrder?.attribution !== undefined) ||
  (await services.repos().orders.getById(paid.order.id))?.attribution?.promoterId !==
    promoterBOrgId ||
  storedRsvpOrder?.attribution?.promoterId !== promoterBOrgId
) {
  throw new Error(
    `Suspension acceptance mismatch: quoteAttribution=${suspendedQuote.attribution?.promoterId ?? 'null'}, rsvpAttribution=${suspendedRsvpOrder?.attribution?.promoterId ?? 'null'}, paidHistory=${(await services.repos().orders.getById(paid.order.id))?.attribution?.promoterId ?? 'null'}, rsvpHistory=${storedRsvpOrder?.attribution?.promoterId ?? 'null'}, expected=${promoterBOrgId}`,
  );
}

await writeFile(
  dataPath,
  JSON.stringify({
    api: 'http://127.0.0.1:4301',
    guestPortal: 'http://127.0.0.1:3100',
    partnerDashboard: 'http://127.0.0.1:3200',
    adminConsole: 'http://127.0.0.1:3300',
    projectId: fixture.projectId,
    accounts: Object.fromEntries(
      [...accounts.entries()].map(([key, identity]) => [
        key,
        { email: identity.email, password: identity.password },
      ]),
    ),
    organizations: { hostAOrgId, hostBOrgId, promoterAOrgId, promoterBOrgId },
    events: { eventA, eventB, eventUi, eventUiDecline },
    assignments: {
      promoterUiAssignmentId: assignmentUi.id,
      promoterUiDeclineAssignmentId: assignmentUiDecline.id,
    },
    links: { codeA: linkA.code, codeB: linkB.code },
    acceptance: {
      paymentAttributedToLatestPromoter: true,
      duplicatePaymentVerificationSafe: true,
      eventIsolation: true,
      authenticatedContinuationPreservesAttribution: true,
      abandonedCheckoutHasNoOrder: true,
      rsvpAttributedToOriginalPromoter: true,
      transferPreservesOriginalAcquisition: true,
      refundPreservesHistoryAndUpdatesNetSales: true,
      hostAnalyticsMatchesPromoterAcquisitionAndRefunds: true,
      revocationBlocksFutureAttributionAndPreservesHistory: true,
      crossTenantReadsAndWritesDenied: true,
      suspensionBlocksFutureAttributionAndPreservesHistory: true,
      provider: 'MemoryPaymentProvider using signature-verified API fulfillment',
      emailProvider: 'disabled',
    },
  }),
  { mode: 0o600 },
);
await chmod(dataPath, 0o600);
await app.listen({ host: '127.0.0.1', port: 4301 });
console.info(`Synthetic Promoter fixture ready at loopback; private fixture file: ${dataPath}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void closeFixture().finally(async () => {
      await import('node:fs/promises').then(({ rm }) => rm(dataPath, { force: true }));
      process.exit(0);
    });
  });
}
