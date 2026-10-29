import {
  createOnboardingRequest,
  createOrganization,
  createOrder,
  calculatePricing,
  createPromoterAssignment,
  PROMOTER_AGREEMENT_TEST_FIXTURE,
  revokePromoterAssignment,
  recordPromoterAgreementAcceptance,
} from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventCatalogRoutes from './event-catalog.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerReferralLinkRoutes from './referral-links.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Referral links over HTTP (Phase 1) ──────────────────────────────────────
 * The rule under test: a link carries attribution but never owns it, so
 * deactivating one must not erase what it already produced.
 */

let keySeq = 0;
const buildServer = () =>
  buildPartnerTestServer({
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerEventCatalogRoutes,
      partnerReferralLinkRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const services = createV2Services();
const read = (org: string) => ({ 'x-organization-id': org });
const write = (org: string) => ({ ...read(org), 'idempotency-key': `ref-key-${++keySeq}` });

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
  const event = await server.inject({
    method: 'POST',
    url: `/organizations/${org}/events`,
    headers: write(org),
    payload: {
      title: 'Sky Night',
      venueId: venue.json().id,
      startAt: '2026-09-01T18:00:00Z',
    },
  });
  const eventId: string = event.json().id;
  return { org, eventId };
}

async function seedAcceptedAssignment(
  eventId: string,
  promoterId: string,
  assignmentId = 'assignment-' + promoterId,
) {
  const repos = services.repos();
  const now = new Date('2026-10-28T12:00:00.000Z');
  if (!(await repos.organizations.getById(promoterId))) {
    await repos.organizations.save(
      createOrganization({
        id: promoterId,
        name: 'Promoter',
        slug: 'promoter-' + promoterId,
        ownerId: 'user-' + promoterId,
        now,
      }),
    );
  }
  const application = createOnboardingRequest({
    id: 'onboarding-' + promoterId,
    userId: 'user-' + promoterId,
    requestedType: 'promoter',
    plan: 'basic',
    profile: { legalName: 'Promoter', contactPerson: 'Owner', phone: '9876543210', city: 'Pune' },
    now,
  });
  await repos.onboarding.save(application);
  const withAgreement = recordPromoterAgreementAcceptance(
    application,
    PROMOTER_AGREEMENT_TEST_FIXTURE,
    'user-' + promoterId,
    now,
    true,
  );
  await repos.onboarding.save({
    ...withAgreement,
    status: 'approved',
    submittedAt: now.toISOString(),
    reviewedBy: 'admin_test',
    reviewedAt: now.toISOString(),
    provisionedOrganizationId: promoterId,
    version: withAgreement.version,
    updatedAt: now.toISOString(),
  });
  const assignment = createPromoterAssignment({
    id: assignmentId,
    eventId,
    promoterId,
    terms: { version: 1, ratePercent: 15, flatPaise: 0 },
    status: 'accepted',
    now,
  });
  await repos.catalog.saveAssignment(assignment);
  return assignment;
}

describe('creating referral links', () => {
  it('creates a new assignment-scoped link after a prior assignment was revoked', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const repos = services.repos();
    const firstAssignment = await seedAcceptedAssignment(eventId, org, `assignment-${org}-first`);

    const firstResponse = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${firstAssignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'First campaign' },
    });
    expect(firstResponse.statusCode).toBe(201);
    const firstLink = firstResponse.json();
    expect(firstLink.vanitySlug).toMatch(/^[a-z0-9-]+-[0-9a-f]{24}$/u);
    expect(firstLink.vanitySlug.length).toBeLessThanOrEqual(60);

    await repos.catalog.saveAssignment(
      revokePromoterAssignment(firstAssignment, 'host_test', 'Campaign replaced'),
    );
    const secondAssignment = await seedAcceptedAssignment(eventId, org, `assignment-${org}-second`);
    const secondResponse = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${secondAssignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'Replacement campaign' },
    });
    expect(secondResponse.statusCode, JSON.stringify(secondResponse.json())).toBe(201);
    expect(secondResponse.json()).toMatchObject({
      assignmentId: secondAssignment.id,
      eventId,
      promoterId: org,
      label: 'Replacement campaign',
    });
    expect(secondResponse.json().id).not.toBe(firstLink.id);
    expect(secondResponse.json().code).not.toBe(firstLink.code);
    expect(secondResponse.json().vanitySlug).not.toBe(firstLink.vanitySlug);
    expect(await repos.referralLinks.getById(firstLink.id)).toMatchObject({
      assignmentId: firstAssignment.id,
      code: firstLink.code,
    });

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${secondAssignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'Replacement campaign' },
    });
    expect(retryResponse.statusCode).toBe(201);
    expect(retryResponse.json()).toMatchObject({
      id: secondResponse.json().id,
      code: secondResponse.json().code,
    });
    await server.close();
  });

  it('lets an assigned promoter generate a referral link without event-owner permissions', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const assignment = await seedAcceptedAssignment(eventId, org);

    const created = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'Guest portal' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      eventId,
      promoterId: org,
      organizationId: org,
      label: 'Guest portal',
      isActive: true,
    });
    await server.close();
  });

  it('lists only the authenticated promoter organization referral links', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const assignment = await seedAcceptedAssignment(eventId, org);
    const created = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'M4 campaign' },
    });

    const own = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/referral-links`,
      headers: read(org),
    });
    const other = await server.inject({
      method: 'GET',
      url: '/promoters/promoter_other/referral-links',
      headers: read(org),
    });

    expect(own.statusCode, JSON.stringify(own.json())).toBe(200);
    expect(own.json().items).toHaveLength(1);
    expect(own.json().items[0].id).toBe(created.json().id);
    expect(other.statusCode).toBe(404);
    await server.close();
  });

  it('returns a next cursor for the promoter link list and advances pages', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const assignments = [];
    for (const suffix of ['first', 'second', 'third']) {
      assignments.push(await seedAcceptedAssignment(eventId, org, `assignment-${org}-${suffix}`));
    }
    for (const assignment of assignments) {
      const created = await server.inject({
        method: 'POST',
        url: `/promoter-assignments/${assignment.id}/referral-links`,
        headers: write(org),
        payload: { label: assignment.id },
      });
      expect(created.statusCode).toBe(201);
    }

    const first = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/referral-links?limit=2`,
      headers: read(org),
    });
    expect(first.statusCode, JSON.stringify(first.json())).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().pageInfo).toMatchObject({
      page: 1,
      pageSize: 2,
      total: 3,
      hasNextPage: true,
      nextCursor: '2',
    });

    const second = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/referral-links?limit=2&cursor=2`,
      headers: read(org),
    });
    expect(second.statusCode, JSON.stringify(second.json())).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().pageInfo).toMatchObject({
      page: 2,
      pageSize: 2,
      total: 3,
      hasNextPage: false,
      nextCursor: null,
    });

    const invalidCursor = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/referral-links?limit=2&cursor=invalid`,
      headers: read(org),
    });
    expect(invalidCursor.statusCode).toBe(422);
    const misalignedCursor = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/referral-links?limit=2&cursor=1`,
      headers: read(org),
    });
    expect(misalignedCursor.statusCode).toBe(422);
    await server.close();
  });

  it('returns server-computed campaign activity for the authenticated Promoter only', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const assignment = await seedAcceptedAssignment(eventId, org);
    const created = await server.inject({
      method: 'POST',
      url: `/promoter-assignments/${assignment.id}/referral-links`,
      headers: write(org),
      payload: { label: 'Summary campaign' },
    });
    const linkId = created.json().id as string;
    await services.repos().referralLinks.recordClick(linkId, 'click-test-1', new Date());
    await services.repos().referralLinks.recordSale(linkId, 'order_summary_1', 2500, 375);

    const own = await server.inject({
      method: 'GET',
      url: `/promoters/${org}/campaign-summary`,
      headers: read(org),
    });
    const other = await server.inject({
      method: 'GET',
      url: '/promoters/promoter_other/campaign-summary',
      headers: read(org),
    });

    expect(own.statusCode, JSON.stringify(own.json())).toBe(200);
    expect(own.json()).toMatchObject({
      linkCount: 1,
      clicks: 1,
      conversions: 1,
      grossAttributedTicketRevenuePaise: 2500,
      hasMoreLinks: false,
    });
    expect(other.statusCode).toBe(404);
    await server.close();
  });

  it('creates a link with a supplied code and lists it', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedAcceptedAssignment(eventId, 'promoter_a');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_a', code: 'summer-24', label: 'Instagram' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      // Normalized: a flyer may print it lower-case or hyphenated.
      code: 'SUMMER24',
      label: 'Instagram',
      isActive: true,
      clicks: 0,
      lastClickedAt: null,
      conversions: 0,
    });

    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/referral-links`,
      headers: read(org),
    });
    expect(listed.json().items).toHaveLength(1);
    await server.close();
  });

  it('generates a code when none is given', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedAcceptedAssignment(eventId, 'promoter_b');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_b' },
    });

    const code: string = created.json().code;
    expect(code).toHaveLength(8);
    // No look-alike characters: these get read aloud and typed by hand.
    expect(code).not.toMatch(/[O0IL1]/);
    await server.close();
  });

  it('refuses a duplicate code for the same event', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const payload = { promoterId: 'promoter_c', code: 'DUPE24' };
    await seedAcceptedAssignment(eventId, payload.promoterId);
    await seedAcceptedAssignment(eventId, 'promoter_d');

    await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { ...payload, promoterId: 'promoter_d' },
    });

    // A collision would silently hand one promoter another's attribution.
    expect(second.statusCode).toBe(400);
    await server.close();
  });

  it('rejects a code with unusable characters', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_e', code: 'BAD!!CODE' },
    });

    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const { org } = await seed(server);

    const response = await server.inject({
      method: 'POST',
      url: '/events/evt_someone_else/referral-links',
      headers: write(org),
      payload: { promoterId: 'promoter_f' },
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('lets an event owner page only privacy-minimized orders attributed to that event and Promoter', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    const promoterId = 'org_promoter_event_orders';
    const assignment = await seedAcceptedAssignment(eventId, promoterId);
    const now = new Date('2026-10-28T12:00:00.000Z');
    const tier = {
      id: 'tier_host_orders',
      eventId,
      organizationId: org,
      name: 'General',
      description: '',
      entryType: 'general' as const,
      currency: 'INR',
      priceInPaise: 22_500,
      quantity: 100,
      status: 'active' as const,
      salesStartAt: null,
      salesEndAt: null,
      maxPerOrder: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const order = {
      ...createOrder({
        id: 'order_host_attributed',
        eventId,
        organizationId: org,
        userId: 'guest_host_private',
        contact: { name: 'Private Guest', email: 'host-private@example.test', phone: '5551234' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
        now,
      }),
      status: 'paid' as const,
      paymentId: 'host-payment-private',
      attribution: {
        referralLinkId: 'host-link-private',
        promoterId,
        code: 'PRIVATE-CODE',
        assignmentId: assignment.id,
        assignmentVersion: 1,
        termsSnapshot: assignment.terms,
        eligibleTierIds: null,
        commissionPolicyVersion: 'commission-v1',
        commercialPolicyVersion: 'commercial-v1',
        attributedAt: now.toISOString(),
        attributionSignature: 'private-signature',
        promoterCommissionPaise: 4_500,
      },
    };
    await services.repos().orders.save(order);
    const otherEventOrder = {
      ...order,
      id: 'order_other_event_attributed',
      eventId: 'event_other_owner',
    };
    await services.repos().orders.save(otherEventOrder);

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoters/${promoterId}/attributed-orders?limit=20`,
      headers: read(org),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      {
        id: order.id,
        bookingReference: order.bookingReference,
        eventId,
        status: 'paid',
        ticketCount: 2,
        attributedTicketValuePaise: 45_000,
        promoterCommissionPaise: 4_500,
        attributedAt: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain('host-private@example.test');
    expect(JSON.stringify(response.json())).not.toContain('host-payment-private');
    expect(JSON.stringify(response.json())).not.toContain('PRIVATE-CODE');
    expect(JSON.stringify(response.json())).not.toContain('private-signature');

    const denied = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoters/${promoterId}/attributed-orders`,
      headers: read('another-organization'),
    });
    expect(denied.statusCode).toBe(404);
    const invalidCursor = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoters/${promoterId}/attributed-orders?cursor=not-an-offset`,
      headers: read(org),
    });
    expect(invalidCursor.statusCode).toBe(422);
    await server.close();
  });
});

describe('deactivating a link', () => {
  it('stops new attributions but keeps the record', async () => {
    const server = await buildServer();
    const { org, eventId } = await seed(server);
    await seedAcceptedAssignment(eventId, 'promoter_g');

    const created = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/referral-links`,
      headers: write(org),
      payload: { promoterId: 'promoter_g', code: 'OLDLINK' },
    });
    const linkId: string = created.json().id;

    const deactivated = await server.inject({
      method: 'POST',
      url: `/referral-links/${linkId}/deactivate`,
      headers: write(org),
    });

    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ isActive: false, code: 'OLDLINK' });

    // Still listed: past attributions must stay explicable.
    const listed = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/referral-links`,
      headers: read(org),
    });
    expect(listed.json().items).toHaveLength(1);
    await server.close();
  });
});

describe('Promoter attributed-order privacy projection', () => {
  it('returns only this Promoter’s attributed order fields and no guest/payment/link secrets', async () => {
    const server = await buildServer();
    const { eventId } = await seed(server);
    const promoterId = 'promoter_privacy';
    const assignment = await seedAcceptedAssignment(eventId, promoterId);
    const now = new Date('2026-10-28T12:00:00.000Z');
    const tier = {
      id: 'tier_privacy',
      eventId,
      organizationId: 'event-owner',
      name: 'General',
      description: '',
      entryType: 'general' as const,
      currency: 'INR',
      priceInPaise: 22_500,
      quantity: 100,
      status: 'active' as const,
      salesStartAt: null,
      salesEndAt: null,
      maxPerOrder: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const draft = createOrder({
      id: 'order_attributed_private',
      eventId,
      organizationId: 'event-owner',
      userId: 'guest_private',
      contact: { name: 'Private Guest', email: 'guest-private@example.test', phone: '5551234' },
      pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
      now,
    });
    const order = {
      ...draft,
      status: 'paid' as const,
      paymentId: 'payment_private',
      attribution: {
        referralLinkId: 'link_private',
        promoterId,
        code: 'SECRET-CODE',
        assignmentId: assignment.id,
        assignmentVersion: 1,
        termsSnapshot: assignment.terms,
        eligibleTierIds: null,
        commissionPolicyVersion: 'commission-v1',
        commercialPolicyVersion: 'commercial-v1',
        attributedAt: now.toISOString(),
        attributionSignature: 'signature_private',
        promoterCommissionPaise: 4_500,
      },
    };
    await services.repos().orders.save(order);

    const response = await server.inject({
      method: 'GET',
      url: `/promoters/${promoterId}/attributed-orders?limit=20`,
      headers: read(promoterId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      {
        id: order.id,
        bookingReference: order.bookingReference,
        eventId,
        status: 'paid',
        ticketCount: 2,
        attributedTicketValuePaise: 45_000,
        promoterCommissionPaise: 4_500,
        attributedAt: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(response.json())).not.toContain('guest-private@example.test');
    expect(JSON.stringify(response.json())).not.toContain('payment_private');
    expect(JSON.stringify(response.json())).not.toContain('SECRET-CODE');
    expect(JSON.stringify(response.json())).not.toContain('signature_private');

    const denied = await server.inject({
      method: 'GET',
      url: '/promoters/promoter_other/attributed-orders',
      headers: read(promoterId),
    });
    expect(denied.statusCode).toBe(404);
    await server.close();
  });
});
