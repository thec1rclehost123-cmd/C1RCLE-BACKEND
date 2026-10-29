import {
  approveConnection,
  createOrganization,
  createOnboardingRequest,
  createPromoCode,
  createPromoterConnection,
  PROMOTER_AGREEMENT_TEST_FIXTURE,
  recordPromoterAgreementAcceptance,
} from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';
import { publishEventForTest } from '../../../test-utils/publish-event.js';
import checkoutRoutes from '../checkout/checkout-routes.js';
import notificationRoutes from '../notifications/notifications-routes.js';
import publicDiscoveryRoutes from '../public/discovery.js';

import partnerEventCatalogRoutes from './event-catalog.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Event catalog over HTTP (Phase 3) ───────────────────────────────────────
 * The services were built and tested long ago; only routes were missing. These
 * assert the transport contract — serialization, tenancy, idempotency — rather
 * than re-testing catalog rules already covered in `packages/core`.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      notificationRoutes,
      checkoutRoutes,
    ],
  });
const services = createV2Services();
const buildPublicServer = () => buildPartnerTestServer({ routes: [publicDiscoveryRoutes] });

type Server = Awaited<ReturnType<typeof buildServer>>;

const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({
  ...read(org),
  'idempotency-key': `catalog-key-${++keySeq}`,
});

/** Creates org → venue → event and returns the ids every catalog route needs. */
async function seed(server: Server): Promise<{ org: string; eventId: string }> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const org: string = created.json().id;

  const venue = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/venues`,
    headers: write(org),
    payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
  });
  const venueId: string = venue.json().id;

  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: { title: 'Sky Night', venueId, startAt: '2026-09-01T18:00:00Z' },
  });
  const eventId: string = event.json().id;
  return { org, eventId };
}

async function seedApprovedPromoter(targetId: string, promoterId: string, acceptAgreement = true) {
  const repos = services.repos();
  const now = new Date('2026-10-28T12:00:00.000Z');
  const promoter = createOrganization({
    id: promoterId,
    name: 'Approved Promoter',
    slug: 'promoter-' + promoterId,
    ownerId: 'user-' + promoterId,
    now,
  });
  await repos.organizations.save(promoter);

  const draft = createOnboardingRequest({
    id: 'onboarding-' + promoterId,
    userId: 'user-' + promoterId,
    requestedType: 'promoter',
    plan: 'basic',
    profile: {
      legalName: 'Approved Promoter',
      contactPerson: 'Promoter Owner',
      phone: '+911234567890',
      city: 'Mumbai',
    },
    now,
  });
  await repos.onboarding.save(draft);
  const withAgreement = acceptAgreement
    ? recordPromoterAgreementAcceptance(
        draft,
        PROMOTER_AGREEMENT_TEST_FIXTURE,
        'user-' + promoterId,
        now,
        true,
      )
    : draft;
  await repos.onboarding.save({
    ...withAgreement,
    status: 'approved',
    submittedAt: now.toISOString(),
    reviewedBy: 'admin_test',
    reviewedAt: now.toISOString(),
    provisionedOrganizationId: promoterId,
    version: 2,
    updatedAt: now.toISOString(),
  });

  const pending = createPromoterConnection({
    id: 'connection-' + promoterId,
    promoterId,
    targetId,
    targetType: 'host',
    initiatedBy: 'target',
    now,
  });
  await repos.promoterConnections.save(pending);
  await repos.promoterConnections.save(approveConnection(pending, promoterId, now));
}

describe('ticket tiers', () => {
  it('creates and lists event-scoped non-cover add-ons through the authorized catalog API', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-addons`,
      headers: write(org),
      payload: {
        name: 'Parking pass',
        description: 'One vehicle',
        kind: 'parking',
        priceInPaise: 25_000,
        quantity: 12,
        maxPerEntitlement: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      eventId,
      organizationId: org,
      kind: 'parking',
      currency: 'INR',
      priceInPaise: 25_000,
      quantity: 12,
      status: 'active',
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-addons`,
      headers: read(org),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toContain('no-store');
    expect(listed.json().items).toEqual([created.json()]);

    const foreign = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-addons`,
      headers: write('another-org'),
      payload: {
        name: 'Parking pass',
        kind: 'parking',
        priceInPaise: 25_000,
        quantity: 12,
      },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('proposes and accepts an exact-version cover policy with idempotent Venue retry', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const event = await services.repos().events.getById(eventId);
    const venue = event?.venueId ? await services.repos().venues.getById(event.venueId) : null;
    expect(event).not.toBeNull();
    expect(venue).not.toBeNull();

    const proposal = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/cover-policy`,
      headers: write(org),
      payload: {
        policyVersion: 'fixture-v1',
        terms: {
          coverAmountPaise: 150_000,
          minimumSpendPaise: 50_000,
          redemptionOpensAt: '2026-11-01T18:00:00.000Z',
          redemptionClosesAt: '2026-11-02T02:00:00.000Z',
          eligibleCategories: ['food'],
          excludedCategories: ['alcohol'],
          alcoholRule: 'exclude_alcohol',
          partialRedemption: true,
          splitTender: true,
          refundPolicy: 'unused_full_before_redemption',
          transferUnusedOnly: true,
          commissionBasis: 'net_admission_after_allocated_discount',
          unusedBalancePolicy: 'approved_minimum_spend_expiry',
        },
      },
    });
    expect(proposal.statusCode).toBe(201);
    expect(proposal.json()).toMatchObject({
      policyVersion: 'fixture-v1',
      termsDigest: expect.any(String),
    });
    const history = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/cover-policy`,
      headers: read(org),
    });
    expect(history.statusCode).toBe(200);
    expect(history.headers['cache-control']).toContain('no-store');
    expect(history.json()).toMatchObject({ acceptanceEnabled: true });
    expect(history.json().items).toHaveLength(1);
    expect(history.json().items[0]).toMatchObject({
      proposal: { id: proposal.json().id },
      acceptance: null,
    });

    const acceptanceHeaders = write(org);
    const acceptanceRequest = {
      method: 'POST' as const,
      url: `/events/${eventId}/cover-policy/${proposal.json().id}/accept`,
      headers: acceptanceHeaders,
      payload: {},
    };
    const accepted = await server.inject(acceptanceRequest);
    expect(accepted.statusCode).toBe(200);
    const acceptedHistory = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/cover-policy`,
      headers: read(org),
    });
    expect(acceptedHistory.json().items[0].acceptance).toMatchObject({
      proposalId: proposal.json().id,
      termsDigest: proposal.json().termsDigest,
    });
    const retried = await server.inject(acceptanceRequest);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(accepted.json());

    const wrongEvent = await server.inject({
      ...acceptanceRequest,
      url: `/events/another-event/cover-policy/${proposal.json().id}/accept`,
      headers: write(org),
    });
    expect(wrongEvent.statusCode).toBe(409);
  });

  it('creates a tier and lists it back', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'Early Bird',
        priceInPaise: 150_000,
        quantity: 100,
        pricingPhases: [
          {
            id: 'p1',
            name: 'Early Bird',
            priceInPaise: 150_000,
            startDate: '01-01',
            endDate: '02-01',
            quantity: 100,
          },
        ],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Early Bird',
      // Money stays integer paise on the wire, never rupees.
      priceInPaise: 150_000,
      quantity: 100,
      eventId,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });

  it('round-trips independent access, audience, phase, benefit, and table fields', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const response = await server.inject({
      method: 'POST',
      url: '/events/' + eventId + '/ticket-tiers',
      headers: write(org),
      payload: {
        name: 'VIP Table',
        priceInPaise: 2_500_000,
        quantity: 10,
        accessType: 'TABLE',
        audienceType: 'GENERAL',
        guestCount: 6,
        pricingPhases: [
          {
            id: 'phase-1',
            name: 'Early Bird',
            priceInPaise: 2_000_000,
            startDate: '01-01',
            endDate: '01-02',
            quantity: 5,
          },
        ],
        benefits: ['Entry', 'Bottle'],
        doorPriceInPaise: 3_000_000,
        minAge: 21,
        maxPerUser: 2,
        tableConfig: {
          capacity: 6,
          minimumSpendPaise: 1_000_000,
          redeemableAmountPaise: 500_000,
          tableCount: 10,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      accessType: 'TABLE',
      audienceType: 'GENERAL',
      guestCount: 6,
      doorPriceInPaise: 3_000_000,
      benefits: ['Entry', 'Bottle'],
      tableConfig: { capacity: 6, tableCount: 10 },
    });
    await server.close();
  });

  it('rejects a paid RSVP at the domain boundary', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const response = await server.inject({
      method: 'POST',
      url: '/events/' + eventId + '/ticket-tiers',
      headers: write(org),
      payload: { name: 'RSVP', priceInPaise: 1, quantity: 10, accessType: 'RSVP' },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('rejects a table ticket without table configuration', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const response = await server.inject({
      method: 'POST',
      url: '/events/' + eventId + '/ticket-tiers',
      headers: write(org),
      payload: {
        name: 'Table',
        priceInPaise: 1_000,
        quantity: 2,
        accessType: 'TABLE',
        pricingPhases: [
          {
            id: 'p1',
            name: 'Phase',
            priceInPaise: 1_000,
            startDate: '01-01',
            endDate: '02-01',
            quantity: 2,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('rejects overlapping pricing phases', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const response = await server.inject({
      method: 'POST',
      url: '/events/' + eventId + '/ticket-tiers',
      headers: write(org),
      payload: {
        name: 'Phased',
        priceInPaise: 1_000,
        quantity: 2,
        pricingPhases: [
          {
            id: 'phase-1',
            name: 'One',
            priceInPaise: 1_000,
            startDate: '01-01',
            endDate: '10-01',
            quantity: null,
          },
          {
            id: 'phase-2',
            name: 'Two',
            priceInPaise: 2_000,
            startDate: '09-01',
            endDate: '20-01',
            quantity: null,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a negative price at the schema boundary', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: { name: 'Broken', priceInPaise: -1, quantity: 10 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('priceInPaise');
    await server.close();
  });

  it('requires an idempotency key like every other write', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
      payload: {
        name: 'No Key',
        priceInPaise: 1000,
        quantity: 1,
        pricingPhases: [
          {
            id: 'p1',
            name: 'Phase',
            priceInPaise: 1000,
            startDate: '01-01',
            endDate: '02-01',
            quantity: 1,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idempotency-key');
    await server.close();
  });

  it('replays a repeated create instead of making a second tier', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const headers = write(org);
    const payload = {
      name: 'Replayed',
      priceInPaise: 5000,
      quantity: 5,
      pricingPhases: [
        {
          id: 'p1',
          name: 'Phase',
          priceInPaise: 5000,
          startDate: '01-01',
          endDate: '02-01',
          quantity: 5,
        },
      ],
    };

    const first = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers,
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ id: first.json().id });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-tiers`,
      headers: read(org),
    });
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });

  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const { org } = await seed(server);

    const response = await server.inject({
      method: 'GET',
      url: '/events/evt_someone_else/ticket-tiers',
      headers: read(org),
    });

    // Never confirms whether that event exists.
    expect(response.statusCode).toBe(404);
    await server.close();
  });
});

describe('private tier access codes', () => {
  it('returns the code once, binds redemption to a verified user, and unlocks only scoped tiers', async () => {
    const server = await buildServer();
    const publicServer = await buildPublicServer();
    const { org, eventId } = await seed(server);
    await publishEventForTest(eventId);
    const publicTier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'General Admission',
        priceInPaise: 10_000,
        quantity: 50,
        accessType: 'ENTRY',
        accessMode: 'public',
      },
    });
    expect(publicTier.statusCode).toBe(201);
    const tier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'Invite List',
        priceInPaise: 20_000,
        quantity: 20,
        accessType: 'ENTRY',
        accessMode: 'code',
      },
    });
    expect(tier.statusCode).toBe(201);
    const tierId = tier.json().id as string;
    const publicTierId = publicTier.json().id as string;

    const discoverableTiers = await publicServer.inject({
      method: 'GET',
      url: `/events/${eventId}/tiers`,
    });
    expect(discoverableTiers.statusCode).toBe(200);
    expect(discoverableTiers.json().items.map((item: { id: string }) => item.id)).toEqual([
      publicTierId,
    ]);

    const now = Date.now();
    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/access-codes`,
      headers: write(org),
      payload: {
        tierIds: [tierId],
        startsAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
        maxRedemptions: 1,
      },
    });
    expect(created.statusCode).toBe(201);
    const code = created.json().code as string;
    const accessCodeId = created.json().accessCode.id as string;

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/access-codes`,
      headers: read(org),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toContain('no-store');
    expect(listed.json().items).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain(code);

    const users = services.repos().users as unknown as { save(user: object): void };
    users.save({
      id: 'guest_access_code',
      email: 'guest-access@yopmail.com',
      name: 'Access Guest',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: now,
      updatedAt: now,
    });
    const redeemed = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'guest_access_code' },
      payload: { code },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.headers['cache-control']).toContain('no-store');
    expect(redeemed.json()).toMatchObject({ eventId, tierIds: [tierId] });
    expect(redeemed.json()).not.toHaveProperty('codeId');
    const redemptionRetry = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'guest_access_code' },
      payload: { code },
    });
    expect(redemptionRetry.statusCode).toBe(200);
    expect(redemptionRetry.json().id).toBe(redeemed.json().id);
    users.save({
      id: 'guest_access_code_other',
      email: 'guest-access-other@yopmail.com',
      name: 'Other Guest',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: now,
      updatedAt: now,
    });
    const exhausted = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'guest_access_code_other' },
      payload: { code },
    });
    const invalid = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'guest_access_code_other' },
      payload: { code: 'z'.repeat(24) },
    });
    expect(exhausted.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(404);
    expect(exhausted.json().message).toBe(invalid.json().message);

    const unlocked = await publicServer.inject({
      method: 'GET',
      url: `/events/${eventId}/tiers`,
      headers: {
        'x-user-id': 'guest_access_code',
        'x-ticket-access-grant-id': redeemed.json().id,
      },
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json().items.map((item: { id: string }) => item.id)).toContain(tierId);
    expect(unlocked.json().items.map((item: { id: string }) => item.id)).not.toContain(
      publicTierId,
    );

    const quote = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      headers: { 'x-user-id': 'guest_access_code' },
      payload: {
        eventId,
        lines: [{ tierId, quantity: 1, accessGrantId: redeemed.json().id }],
      },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json().grandTotalPaise).toBeGreaterThan(0);
    const hold = await server.inject({
      method: 'POST',
      url: '/checkout/holds',
      headers: {
        'x-user-id': 'guest_access_code',
        'idempotency-key': `private-tier-hold-${++keySeq}`,
      },
      payload: {
        eventId,
        lines: [{ tierId, quantity: 1, accessGrantId: redeemed.json().id }],
      },
    });
    expect(hold.statusCode).toBe(201);

    const revoked = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/access-codes/${accessCodeId}/revoke`,
      headers: read(org),
      payload: { reason: 'Partner stopped this allocation' },
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await publicServer.inject({
      method: 'GET',
      url: `/events/${eventId}/tiers`,
      headers: {
        'x-user-id': 'guest_access_code',
        'x-ticket-access-grant-id': redeemed.json().id,
      },
    });
    expect(afterRevoke.json().items.map((item: { id: string }) => item.id)).not.toContain(tierId);
    const deniedQuote = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      headers: { 'x-user-id': 'guest_access_code' },
      payload: {
        eventId,
        lines: [{ tierId, quantity: 1, accessGrantId: redeemed.json().id }],
      },
    });
    expect(deniedQuote.statusCode).toBe(404);

    const invitedTier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'Named invite',
        priceInPaise: 25_000,
        quantity: 5,
        accessType: 'ENTRY',
        accessMode: 'invited',
      },
    });
    expect(invitedTier.statusCode).toBe(201);
    const invite = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/access-invitations`,
      headers: write(org),
      payload: {
        tierIds: [invitedTier.json().id],
        recipientEmail: 'named-invite@yopmail.com',
        startsAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
      },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().accessCode).toMatchObject({ kind: 'invitation', maxRedemptions: 1 });
    expect(invite.json().accessCode).not.toHaveProperty('recipientEmailHash');
    const invitationVerifier = await services
      .repos()
      .ticketAccess.getCodeById(invite.json().accessCode.id);
    expect(invitationVerifier?.recipientEmailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(invitationVerifier?.recipientEmailHash).not.toBe('named-invite@yopmail.com');

    const wrongRecipient = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'guest_access_code_other' },
      payload: { code: invite.json().code },
    });
    expect(wrongRecipient.statusCode).toBe(404);
    users.save({
      id: 'named_invite_guest',
      email: 'named-invite@yopmail.com',
      name: 'Named Invite',
      image: null,
      emailVerified: true,
      role: 'guest',
      createdAt: now,
      updatedAt: now,
    });
    const acceptedInvitation = await publicServer.inject({
      method: 'POST',
      url: '/ticket-access-codes/redeem',
      headers: { 'x-user-id': 'named_invite_guest' },
      payload: { code: invite.json().code },
    });
    expect(acceptedInvitation.statusCode).toBe(200);
    const invitedTiers = await publicServer.inject({
      method: 'GET',
      url: `/events/${eventId}/tiers`,
      headers: {
        'x-user-id': 'named_invite_guest',
        'x-ticket-access-grant-id': acceptedInvitation.json().id,
      },
    });
    expect(invitedTiers.json().items.map((item: { id: string }) => item.id)).toEqual([
      invitedTier.json().id,
    ]);
    await publicServer.close();
    await server.close();
  });
});

describe('promo codes', () => {
  it('creates a percent promo and pages the list', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promo-codes`,
      headers: write(org),
      payload: {
        code: 'early25',
        discountType: 'percent',
        discountValue: 25,
        discountFundingOwner: 'host',
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      // v1 normalizes codes to uppercase so `early25` and `EARLY25` are one code.
      code: 'EARLY25',
      discountType: 'percent',
      discountValue: 25,
      discountFundingOwner: 'host',
      redemptionCount: 0,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promo-codes`,
      headers: read(org),
    });
    expect(listed.json()).toMatchObject({ pageInfo: { total: 1 } });
    await server.close();
  });

  it('rejects an unknown discount type', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promo-codes`,
      headers: write(org),
      payload: { code: 'BAD', discountType: 'buy-one-get-one', discountValue: 1 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });
});

describe('table packages', () => {
  it('creates a table package with integer-paise money', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/table-packages`,
      headers: write(org),
      payload: { name: 'VIP Booth', capacity: 6, pricePaise: 2_500_000, minSpendPaise: 1_000_000 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'VIP Booth',
      capacity: 6,
      pricePaise: 2_500_000,
      minSpendPaise: 1_000_000,
    });
    await server.close();
  });

  it('rejects a zero capacity — a table nobody can sit at is not a package', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/table-packages`,
      headers: write(org),
      payload: { name: 'Phantom', capacity: 0, pricePaise: 1000 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });
});

describe('promoter assignments', () => {
  it('keeps an approved Promoter without current agreement evidence out of assignments', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_missing_agreement', false);

    const candidates = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoter-candidates`,
      headers: read(org),
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toEqual([]);

    const invitation = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_missing_agreement' },
    });
    expect(invitation.statusCode).toBe(404);
    await server.close();
  });

  it('lists only approved Promoters with an active connection for an owned event', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_approved');
    const repos = services.repos();
    const unapproved = createOrganization({
      id: 'promoter_pending',
      name: 'Pending Promoter',
      slug: 'pending-promoter',
      ownerId: 'user-promoter-pending',
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    await repos.organizations.save(unapproved);
    const connection = createPromoterConnection({
      id: 'connection-promoter-pending',
      promoterId: unapproved.id,
      targetId: org,
      targetType: 'host',
      initiatedBy: 'target',
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    await repos.promoterConnections.save(
      approveConnection(connection, unapproved.id, new Date('2026-10-28T12:00:00.000Z')),
    );

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoter-candidates`,
      headers: read(org),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: 'promoter_approved', name: 'Approved Promoter', slug: 'promoter-promoter_approved' },
    ]);
    await server.close();
  });

  it('rejects terms that exceed the current distributable value before creating an invitation', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_overallocated');
    const tier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'Commissionable',
        priceInPaise: 10_000,
        quantity: 20,
        accessType: 'ENTRY',
        commissionEligible: true,
      },
    });
    expect(tier.statusCode).toBe(201);

    const assignment = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: {
        promoterId: 'promoter_overallocated',
        ratePercent: 100,
        eligibleTierIds: [tier.json().id],
      },
    });
    expect(assignment.statusCode).toBe(400);
    expect(assignment.json()).toMatchObject({ status: 400 });
    await server.close();
  });

  it('rejects a previously fitting commission after a high discount at Guest quote time', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const promoterId = 'promoter_high_discount';
    await seedApprovedPromoter(org, promoterId);
    await publishEventForTest(eventId);

    const tier = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/ticket-tiers`,
      headers: write(org),
      payload: {
        name: 'Commissionable',
        priceInPaise: 100_000,
        quantity: 20,
        accessType: 'ENTRY',
        commissionEligible: true,
      },
    });
    expect(tier.statusCode).toBe(201);

    const invitation = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId, ratePercent: 70, eligibleTierIds: [tier.json().id] },
    });
    expect(invitation.statusCode).toBe(201);
    const accepted = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${invitation.json().id}/respond`,
      headers: write(promoterId),
      payload: { decision: 'accept', expectedVersion: invitation.json().version },
    });
    expect(accepted.statusCode).toBe(200);

    const repos = services.repos();
    await repos.catalog.savePromo(
      createPromoCode({
        id: 'promo_high_discount',
        eventId,
        organizationId: org,
        code: 'HIGH25',
        discountType: 'percent',
        discountValue: 25,
        discountFundingOwner: 'host',
      }),
    );
    const link = await services.referralLinks.create(
      { userId: 'host_owner', organizationId: org, role: 'owner', capabilities: [] },
      { eventId, promoterId },
    );

    // At face value the frozen 70% commission (70,000 paise) fits the 85,000
    // left after the 15% platform allocation. The 25% discount reduces
    // distributable ticket value to 63,750, so quote must fail closed.
    const quote = await server.inject({
      method: 'POST',
      url: '/checkout/quote',
      payload: {
        eventId,
        lines: [{ tierId: tier.json().id, quantity: 1 }],
        promoCode: 'HIGH25',
        referralCode: link.code,
      },
    });

    expect(quote.statusCode).toBe(400);
    expect(quote.json()).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('assigned promoter commission exceeds'),
    });
    await server.close();
  });

  it('invites an approved connected Promoter who can accept and read frozen event terms', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const promoterId = 'promoter_owner';
    await seedApprovedPromoter(org, promoterId);
    const invitation = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId, ratePercent: 22, flatPaise: 5000 },
    });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json()).toMatchObject({ status: 'invited', invitedBy: expect.any(String) });

    const invitations = await server.inject({
      method: 'GET',
      url: `/promoters/${promoterId}/assignment-invitations`,
      headers: read(promoterId),
    });
    expect(invitations.statusCode).toBe(200);
    expect(invitations.json()).toHaveLength(1);

    const accepted = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${invitation.json().id}/respond`,
      headers: write(promoterId),
      payload: { decision: 'accept', expectedVersion: invitation.json().version },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('accepted');

    const assigned = await server.inject({
      method: 'GET',
      url: `/promoters/${promoterId}/events`,
      headers: read(promoterId),
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toHaveLength(1);
    expect(assigned.json()[0]).toMatchObject({
      event: { id: eventId, title: 'Sky Night' },
      assignment: {
        promoterId,
        status: 'accepted',
        terms: { ratePercent: 22, flatPaise: 5000 },
      },
    });

    const notifications = await server.inject({
      method: 'GET',
      url: `/organizations/${promoterId}/notifications`,
      headers: read(promoterId),
    });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientId: promoterId,
          recipientType: 'promoter',
          type: 'promoter.assignment.invited',
          title: 'You have been invited to promote an event',
          body: 'Review your assignment for "Sky Night".',
          data: expect.objectContaining({ eventTitle: 'Sky Night' }),
        }),
      ]),
    );

    const ownerNotifications = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/notifications`,
      headers: read(org),
    });
    expect(ownerNotifications.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'promoter.assignment.accepted',
          recipientId: org,
          data: expect.objectContaining({
            assignmentId: invitation.json().id,
            eventTitle: 'Sky Night',
          }),
        }),
      ]),
    );

    const otherPromoter = await server.inject({
      method: 'GET',
      url: `/promoters/another_promoter/events`,
      headers: read(promoterId),
    });
    expect(otherPromoter.statusCode).toBe(404);
    await server.close();
  });

  it('freezes the commission terms into the assignment', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_terms');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_terms', ratePercent: 18 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      promoterId: 'promoter_terms',
      status: 'invited',
      // Frozen at assignment time so a later rate change cannot rewrite what a
      // past order earned.
      terms: { ratePercent: 18, flatPaise: 0, version: 1 },
    });
    await server.close();
  });

  it('defaults to v1’s 15% when no rate is supplied', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_2');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_2' },
    });

    expect(created.json().terms.ratePercent).toBe(15);
    await server.close();
  });

  it('rejects a rate above 100 percent', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_3', ratePercent: 150 },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('ends an assignment without deleting the record of it', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_end');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_end' },
    });
    const assignmentId = created.json().id;

    const ended = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignmentId}/end`,
      headers: write(org),
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ status: 'ended' });
    expect(ended.json().endedAt).not.toBeNull();

    // Still listed: the assignment is history, not a deletion.
    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoter-assignments`,
      headers: read(org),
    });
    expect(listed.json()).toHaveLength(1);
    await server.close();
  });

  it('revokes with actor, reason, expected version, and idempotent history', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedApprovedPromoter(org, 'promoter_revoke');
    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/promoter-assignments`,
      headers: write(org),
      payload: { promoterId: 'promoter_revoke' },
    });
    const assignmentId = created.json().id as string;
    const body = {
      expectedVersion: created.json().version as number,
      reason: 'Campaign cancelled',
    };
    const headers = write(org);
    const first = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignmentId}/revoke`,
      headers,
      payload: body,
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignmentId}/revoke`,
      headers,
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'revoked',
      revokedBy: 'user_1',
      revocationReason: 'Campaign cancelled',
    });
    expect(replay.json()).toEqual(first.json());

    const notifications = await server.inject({
      method: 'GET',
      url: '/organizations/promoter_revoke/notifications',
      headers: read('promoter_revoke'),
    });
    expect(notifications.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'promoter.assignment.revoked',
          recipientId: 'promoter_revoke',
          data: expect.objectContaining({ assignmentId, eventTitle: 'Sky Night' }),
        }),
      ]),
    );
    await server.close();
  });
});
