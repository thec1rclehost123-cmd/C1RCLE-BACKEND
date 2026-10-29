import {
  attachPaymentIntent,
  calculatePricing,
  createOrder,
  createLedgerEntry,
  createPostedJournal,
  createTicketTier,
  issueEntitlements,
  markPaid,
} from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import type { MemoryAnalyticsReadModelRepository } from '@c1rcle/core/infrastructure/memory';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerAnalyticsRoutes from './analytics.js';
import partnerEventRoutes from './events.js';
import partnerOrganizationRoutes from './organizations.js';
import partnerVenueRoutes from './venues.js';

/**
 * ─── Partner analytics over HTTP (Phase 1) ───────────────────────────────────
 * Read-model routes. The interesting cases are the empty state (a legitimate
 * answer, not an error) and the tenancy guard.
 */

let keySeq = 0;
const buildServer = (cache = false) =>
  buildPartnerTestServer({
    cache,
    routes: [
      partnerOrganizationRoutes,
      partnerVenueRoutes,
      partnerEventRoutes,
      partnerAnalyticsRoutes,
    ],
  });

type Server = Awaited<ReturnType<typeof buildServer>>;
const read = (org: string) => ({ 'x-organization-id': org });

async function seedOrganization(server: Server): Promise<string> {
  const created = await server.inject({
    method: 'POST',
    url: '/organizations',
    headers: { 'x-organization-id': 'org_seed', 'idempotency-key': `seed-${++keySeq}` },
    payload: { name: 'Skyline', slug: `skyline-${keySeq}` },
  });
  const id: string = created.json().id;
  return id;
}

describe('organization analytics overview', () => {
  it('returns real zeroes for an organization with no history', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    // An empty dashboard is a legitimate state — not a 404, not an error.
    expect(response.json()).toMatchObject({
      organizationId: org,
      totalEvents: 0,
      totalRevenuePaise: 0,
      topEvents: [],
      lastEventAt: null,
    });
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/overview',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('refreshes cached published-event totals after the event is published', async () => {
    const server = await buildServer(true);
    server.addHook('onRequest', async (request) => {
      request.actor = {
        userId: String(request.headers['x-test-user'] ?? 'user_analytics'),
        organizationId: String(request.headers['x-organization-id'] ?? ''),
        role: 'owner',
        capabilities: [],
        platformRole: 'partner',
      };
    });
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'M3 Cache Venue', slug: `m3-cache-${keySeq}` },
    });
    expect(venue.statusCode).toBe(201);

    const before = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });
    expect(before.json()).toMatchObject({ totalEvents: 0, publishedEvents: 0 });
    expect(before.headers['x-cache']).toBe('MISS');

    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'M3 cache freshness event',
        venueId: venue.json().id,
        startAt: '2099-09-01T18:00:00Z',
      },
    });
    expect(created.statusCode).toBe(201);
    const eventId: string = created.json().id;

    const afterCreate = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });
    expect(afterCreate.json()).toMatchObject({ totalEvents: 1, publishedEvents: 0 });
    expect(afterCreate.headers['x-cache']).toBe('MISS');

    await server.inject({
      method: 'POST',
      url: `/events/${eventId}/review`,
      headers: { ...read(org), 'idempotency-key': `review-${++keySeq}` },
    });
    await server.inject({
      method: 'POST',
      url: `/events/${eventId}/publish`,
      headers: { ...read(org), 'idempotency-key': `publish-${++keySeq}` },
    });

    const afterPublish = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/overview`,
      headers: read(org),
    });
    expect(afterPublish.json()).toMatchObject({ totalEvents: 1, publishedEvents: 1 });
    expect(afterPublish.headers['x-cache']).toBe('MISS');
    await server.close();
  });
});

describe('organization analytics sales breakdown', () => {
  it('returns ticket, RSVP, order and collection components from source records', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'M3 Analytics Venue', slug: `m3-analytics-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'M3 analytics breakdown',
        venueId: venue.json().id,
        startAt: '2099-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const paidTier = createTicketTier({
      id: `tier_paid_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'Paid',
      priceInPaise: 10_000,
      quantity: 10,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const rsvpTier = createTicketTier({
      id: `tier_rsvp_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'RSVP',
      accessType: 'RSVP',
      quantity: 10,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const repos = createV2Services().repos();
    const now = new Date('2026-01-01T00:00:00Z');
    let paidOrder = createOrder({
      id: `ord_analytics_${keySeq}`,
      eventId,
      organizationId: org,
      userId: `user_analytics_${keySeq}`,
      contact: { name: 'M3 Analytics Guest', email: 'unused@example.test', phone: '' },
      pricing: calculatePricing({ lines: [{ tier: paidTier, quantity: 2 }] }),
      now,
    });
    await repos.orders.save(paidOrder);
    paidOrder = attachPaymentIntent(paidOrder, `provider-order-${keySeq}`, now);
    await repos.orders.save(paidOrder);
    paidOrder = markPaid(paidOrder, `provider-payment-${keySeq}`, now);
    await repos.orders.save(paidOrder);

    const rsvpDraft = createOrder({
      id: `RSVP-analytics-${keySeq}`,
      eventId,
      organizationId: org,
      userId: `user_rsvp_${keySeq}`,
      contact: { name: 'M3 RSVP Guest', email: '', phone: '' },
      pricing: calculatePricing({ lines: [{ tier: rsvpTier, quantity: 1 }] }),
      now,
    });
    const rsvpOrder = {
      ...rsvpDraft,
      status: 'paid' as const,
      paymentIntentId: null,
      paymentId: `rsvp-${keySeq}`,
      paidAt: now.toISOString(),
    };
    await repos.orders.save(rsvpOrder);

    for (const order of [paidOrder, rsvpOrder]) {
      await Promise.all(
        issueEntitlements({ order, now }).map((ticket) => repos.entitlements.save(ticket)),
      );
    }

    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/sales-breakdown`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalTicketsIssued: 3,
      paidTickets: 2,
      freeRsvpTickets: 1,
      paidOrderCount: 1,
      guestGrossCollectedPaise: paidOrder.grandTotalPaise,
      ticketRevenuePaise: 20_000,
    });

    const trends = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/trends?from=2026-01-01&to=2026-01-02`,
      headers: read(org),
    });
    expect(trends.statusCode).toBe(200);
    expect(trends.json().totals).toMatchObject({
      totalTicketsIssued: 3,
      paidTickets: 2,
      freeRsvpTickets: 1,
      paidOrderCount: 1,
      guestGrossCollectedPaise: paidOrder.grandTotalPaise,
      ticketRevenuePaise: 20_000,
    });
    expect(trends.json().totals).toEqual(
      Object.fromEntries(
        Object.keys(trends.json().totals).map((key) => [
          key,
          trends
            .json()
            .buckets.reduce(
              (sum: number, bucket: Record<string, number>) => sum + (bucket[key] ?? 0),
              0,
            ),
        ]),
      ),
    );
    await server.close();
  });

  it('returns zeroes for an empty organization and enforces tenant scope', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/sales-breakdown`,
      headers: read(org),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalTicketsIssued: 0,
      paidTickets: 0,
      freeRsvpTickets: 0,
      paidOrderCount: 0,
      guestGrossCollectedPaise: 0,
      ticketRevenuePaise: 0,
    });

    const denied = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/sales-breakdown',
      headers: read(org),
    });
    expect(denied.statusCode).toBe(403);
    await server.close();
  });
});

describe('event analytics', () => {
  it('hides another tenant’s event behind not-found', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/events/evt_someone_else/analytics',
      headers: read(org),
    });

    // Never confirms whether that event exists.
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('computes event analytics on request when no read model exists yet', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}`, capacity: 250 },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Sky Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const tier = createTicketTier({
      id: `tier_inventory_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'M3 inventory',
      priceInPaise: 100,
      quantity: 10,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await createV2Services().repos().catalog.saveTier(tier);

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/analytics`,
      headers: read(org),
    });

    // The projection has not run, so the read model is absent — the service
    // falls back to a bounded compute-on-request instead of a fabricated 404.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      totalRevenuePaise: 0,
      ticketsSold: 0,
      capacity: null,
      totalTicketInventory: 10,
      occupancyRate: null,
      sellThroughRate: null,
      noShowRate: null,
    });
    await server.close();
  });

  it('returns event-scoped Promoter metrics derived from captured attribution snapshots', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}`, capacity: 250 },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Sky Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const now = new Date('2026-08-01T12:00:00.000Z');
    const tier = createTicketTier({
      id: `tier_promoter_metrics_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'General',
      priceInPaise: 20_000,
      quantity: 10,
      now,
    });
    const order = {
      ...createOrder({
        id: `order_promoter_metrics_${keySeq}`,
        eventId,
        organizationId: org,
        contact: { name: 'Guest', email: 'guest@example.test', phone: '5550100' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
        now,
      }),
      status: 'paid' as const,
      attribution: {
        referralLinkId: `link_${keySeq}`,
        promoterId: 'org_promoter_metrics',
        code: 'METRICS',
        assignmentId: `assignment_${keySeq}`,
        assignmentVersion: 1,
        termsSnapshot: { version: 1, ratePercent: 10, flatPaise: 0 },
        eligibleTierIds: null,
        commissionPolicyVersion: 'commission-v1',
        commercialPolicyVersion: 'commercial-v1',
        attributedAt: now.toISOString(),
        attributionSignature: 'test-signature',
        promoterCommissionPaise: 4_000,
      },
    };
    const repositories = createV2Services().repos();
    await repositories.orders.save(order);
    await repositories.ledger.createBatch([
      createLedgerEntry({
        id: `ledger_promoter_metrics_${keySeq}`,
        organizationId: 'org_promoter_metrics',
        orderId: order.id,
        eventId,
        entryType: 'promoter_commission',
        amount: 3_000,
        status: 'pending',
        idempotencyKey: `promoter-metrics:${keySeq}`,
        now,
      }),
    ]);

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/promoter-analytics`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      complete: true,
      capturedTicketCount: 2,
      attributedTicketCount: 2,
      attributedTicketValuePaise: 40_000,
      recordedCommissionPaise: 4_000,
      netAttributedValuePaise: 36_000,
      commissionPayableBalancePaise: 3_000,
      liabilityComplete: true,
      liabilityReadModel: 'legacy_ledger_v1',
      items: [
        {
          promoterOrganizationId: 'org_promoter_metrics',
          attributedOrderCount: 1,
          attributedTicketCount: 2,
          attributedTicketValuePaise: 40_000,
          recordedCommissionPaise: 4_000,
          netAttributedValuePaise: 36_000,
          commissionPayableBalancePaise: 3_000,
          liabilityComplete: true,
          liabilityReadModel: 'legacy_ledger_v1',
        },
      ],
    });
    expect(response.json()).not.toHaveProperty('contact');
    await server.close();
  });

  it('reconciles journal-backed Promoter payable balance separately from captured attribution', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}`, capacity: 250 },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Sky Night',
        venueId: venue.json().id,
        startAt: '2026-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const now = new Date('2026-08-01T12:00:00.000Z');
    const tier = createTicketTier({
      id: `tier_promoter_journal_metrics_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'General',
      priceInPaise: 20_000,
      quantity: 10,
      now,
    });
    const order = {
      ...createOrder({
        id: `order_promoter_journal_metrics_${keySeq}`,
        eventId,
        organizationId: org,
        contact: { name: 'Guest', email: 'guest@example.test', phone: '5550100' },
        pricing: calculatePricing({ lines: [{ tier, quantity: 2 }] }),
        now,
      }),
      status: 'paid' as const,
      attribution: {
        referralLinkId: `link_${keySeq}`,
        promoterId: 'org_promoter_journal_metrics',
        code: 'JOURNAL',
        assignmentId: `assignment_${keySeq}`,
        assignmentVersion: 1,
        termsSnapshot: { version: 1, ratePercent: 10, flatPaise: 0 },
        eligibleTierIds: null,
        commissionPolicyVersion: 'commission-v1',
        commercialPolicyVersion: 'commercial-v1',
        attributedAt: now.toISOString(),
        attributionSignature: 'test-signature',
        promoterCommissionPaise: 4_000,
      },
    };
    const repositories = createV2Services().repos();
    await repositories.orders.save(order);
    const promoterOrganizationId = 'org_promoter_journal_metrics';
    const journalSource = {
      type: 'online_payment_capture' as const,
      id: order.id,
      orderId: order.id,
      paymentId: null,
      eventId,
    };
    const policy = {
      version: 'analytics-test-v1',
      capturedAt: now.toISOString(),
      settlementDelayDays: 0,
      reserveBasisPoints: 0,
      requiresEventCompletion: false,
      holdsOnCancellation: false,
      holdsOnDispute: false,
      holdsOnUnresolvedReconciliation: false,
    };
    await repositories.financialJournals.postBatch([
      createPostedJournal({
        organizationId: promoterOrganizationId,
        currency: 'INR',
        lines: [
          {
            account: 'ticket_collection_control',
            side: 'debit',
            amountPaise: 3_000,
            organizationId: null,
            component: null,
            memo: 'test commission posting',
          },
          {
            account: 'promoter_payable',
            side: 'credit',
            amountPaise: 3_000,
            organizationId: promoterOrganizationId,
            component: 'promoterAllocationPaise',
            memo: 'test commission payable',
          },
        ],
        source: journalSource,
        idempotencyKey: `analytics-journal-posting:${keySeq}`,
        accountingPolicy: policy,
        postedAt: now,
      }),
      createPostedJournal({
        organizationId: promoterOrganizationId,
        currency: 'INR',
        lines: [
          {
            account: 'promoter_payable',
            side: 'debit',
            amountPaise: 1_000,
            organizationId: promoterOrganizationId,
            component: 'promoterAllocationPaise',
            memo: 'test commission reversal',
          },
          {
            account: 'refund_clearing',
            side: 'credit',
            amountPaise: 1_000,
            organizationId: null,
            component: 'refundPaise',
            memo: 'test refund counterpart',
          },
        ],
        source: {
          ...journalSource,
          type: 'refund',
          id: `refund_${keySeq}`,
        },
        idempotencyKey: `analytics-journal-reversal:${keySeq}`,
        accountingPolicy: policy,
        postedAt: now,
      }),
    ]);

    const transition = await repositories.journalTransition.get();
    await repositories.journalTransition.save({
      ...transition,
      phase: 'journal_reads',
      readModel: 'financial_journal_v2',
      version: transition.version + 1,
    });
    let response;
    try {
      response = await server.inject({
        method: 'GET',
        url: `/events/${eventId}/promoter-analytics`,
        headers: read(org),
      });
    } finally {
      const currentTransition = await repositories.journalTransition.get();
      await repositories.journalTransition.save({
        ...currentTransition,
        phase: 'legacy_reads',
        readModel: 'legacy_ledger_v1',
        version: currentTransition.version + 1,
      });
    }

    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toMatchObject({
      eventId,
      complete: true,
      capturedTicketCount: 2,
      attributedTicketCount: 2,
      attributedTicketValuePaise: 40_000,
      recordedCommissionPaise: 4_000,
      netAttributedValuePaise: 36_000,
      commissionPayableBalancePaise: 2_000,
      liabilityComplete: true,
      liabilityReadModel: 'financial_journal_v2',
      items: [
        {
          promoterOrganizationId,
          recordedCommissionPaise: 4_000,
          commissionPayableBalancePaise: 2_000,
          liabilityReadModel: 'financial_journal_v2',
        },
      ],
    });
    await server.close();
  });

  it('does not count unscanned tickets as no-shows before an event ends', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `sky-bar-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Future night',
        venueId: venue.json().id,
        startAt: '2099-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const tier = createTicketTier({
      id: `tier_${keySeq}`,
      eventId,
      organizationId: org,
      name: 'General',
      priceInPaise: 10_000,
      quantity: 10,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const pricing = calculatePricing({ lines: [{ tier, quantity: 1 }] });
    const services = createV2Services();
    let order = createOrder({
      id: `ord_future_${keySeq}`,
      eventId,
      organizationId: org,
      userId: `user_future_${keySeq}`,
      contact: { name: 'Test Guest', email: 'guest@example.test', phone: '' },
      pricing,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    await services.repos().orders.save(order);
    order = attachPaymentIntent(
      order,
      `order_provider_${keySeq}`,
      new Date('2026-01-01T00:00:00Z'),
    );
    await services.repos().orders.save(order);
    order = markPaid(order, `pay_future_${keySeq}`, new Date('2026-01-01T00:00:00Z'));
    await services.repos().orders.save(order);
    await Promise.all(
      issueEntitlements({ order, now: new Date('2026-01-01T00:00:00Z') }).map((entitlement) =>
        services.repos().entitlements.save(entitlement),
      ),
    );

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/analytics`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ticketsSold: 1, totalCheckIns: 0, noShowRate: null });
    await server.close();
  });

  it('recomputes source-backed metrics instead of trusting a stale read model', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `venue-${++keySeq}` },
      payload: { name: 'Unconfigured venue', slug: `unconfigured-${keySeq}` },
    });
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `event-${++keySeq}` },
      payload: {
        title: 'Future event with old projection',
        venueId: venue.json().id,
        startAt: '2099-09-01T18:00:00Z',
      },
    });
    const eventId: string = event.json().id;
    const analytics = createV2Services().repos().analytics as MemoryAnalyticsReadModelRepository;
    analytics.eventAnalytics.set(eventId, {
      eventId,
      totalRevenuePaise: 0,
      ticketsSold: 0,
      totalCheckIns: 0,
      totalTicketInventory: 0,
      capacity: 0,
      views: 17,
      guestlistSignups: 3,
      avgTicketPricePaise: 0,
      occupancyRate: 0,
      sellThroughRate: 0,
      refundAmountPaise: 0,
      refundRate: 0,
      noShowRate: 1,
      repeatGuests: 0,
      conversionRate: 0.25,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/analytics`,
      headers: read(org),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      capacity: null,
      occupancyRate: null,
      sellThroughRate: null,
      noShowRate: null,
      views: 17,
      guestlistSignups: 3,
      conversionRate: 0.25,
    });
    await server.close();
  });
});

/**
 * ─── Organization trends + calendar ──────────────────────────────────────────
 * Both are derived, not projected, so the cases that matter are the ones a
 * "just return an array" implementation gets wrong: gaps, reversed bounds, and
 * events that should not be on a calendar at all.
 */

describe('GET /organizations/:organizationId/analytics/trends', () => {
  const trends = (server: Server, org: string, query: string) =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/trends?${query}`,
      headers: read(org),
    });

  it('returns a dense zero-filled series for an org with no sales', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(server, org, 'from=2026-09-01&to=2026-09-07');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Granularity defaults to `day`, so a caller that does not ask still gets
    // the documented default rather than an error.
    expect(body.granularity).toBe('day');
    // Seven days requested, seven days returned — a gap here would let a chart
    // compress a quiet week into a busy one.
    expect(body.buckets).toHaveLength(7);
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
      '2026-09-07',
    ]);
    expect(body.buckets.every((b: { tickets: number }) => b.tickets === 0)).toBe(true);
    expect(body.totals).toEqual({
      revenuePaise: 0,
      tickets: 0,
      checkIns: 0,
      totalTicketsIssued: 0,
      paidTickets: 0,
      freeRsvpTickets: 0,
      paidOrderCount: 0,
      guestGrossCollectedPaise: 0,
      ticketRevenuePaise: 0,
    });
    await server.close();
  });

  it('buckets a single day into 24 hourly points', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-09-01&to=2026-09-01&granularity=hour')
    ).json();

    // "Today, by the hour" needs hours; a single daily point would be a
    // one-bar chart, which is not a chart.
    expect(body.granularity).toBe('hour');
    expect(body.buckets).toHaveLength(24);
    expect(body.buckets[0].key).toBe('2026-09-01T00:00');
    expect(body.buckets[23].key).toBe('2026-09-01T23:00');
    await server.close();
  });

  it('buckets by month across a long range', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-01-01&to=2026-09-30&granularity=month')
    ).json();

    expect(body.granularity).toBe('month');
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    await server.close();
  });

  it('does not drift month boundaries when the range starts mid-month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (
      await trends(server, org, 'from=2026-01-31&to=2026-04-30&granularity=month')
    ).json();

    // `addMonths` normalises to the 1st first; a naive `getUTCMonth() + n` on
    // Jan 31 would roll into March and produce a duplicate or missing month.
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    await server.close();
  });

  it('rejects an unknown granularity rather than falling back silently', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(
      server,
      org,
      'from=2026-09-01&to=2026-09-07&granularity=fortnight',
    );

    // A typo'd granularity that quietly became `day` would return a plausible
    // series at the wrong width — the exact failure this param exists to avoid.
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('swaps reversed bounds instead of returning an empty series', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // A mistyped range must not 500 a dashboard, and must not silently answer
    // "nothing happened" — it should read the range the user obviously meant.
    const response = await trends(server, org, 'from=2026-09-07&to=2026-09-01');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.from).toBe('2026-09-01');
    expect(body.to).toBe('2026-09-07');
    expect(body.buckets).toHaveLength(7);
    await server.close();
  });

  it('clamps an oversized range rather than scanning one', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await trends(server, org, 'from=2000-01-01&to=2026-09-07');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The contract caps the series; the scan is bounded by the same constant,
    // so an unbounded range cannot turn one request into a full-history walk.
    expect(body.buckets.length).toBeLessThanOrEqual(400);
    expect(body.from).toBe('2000-01-01');
    await server.close();
  });

  it('rejects a malformed bound rather than guessing at it', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // 422 is the gateway's schema-validation status (see `validateV2`), not 400.
    expect((await trends(server, org, 'from=nonsense&to=2026-09-07')).statusCode).toBe(422);
    expect((await trends(server, org, 'from=2026-09-07')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/trends?from=2026-09-01&to=2026-09-07',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('GET /organizations/:organizationId/analytics/events', () => {
  const cards = (server: Server, org: string, query = '') =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/events${query}`,
      headers: read(org),
    });

  /** A venue that *has* declared a capacity, so `capacity` is not `null`. */
  async function seedVenueWithCapacity(
    server: Server,
    org: string,
    capacity: number,
  ): Promise<string> {
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `card-venue-${++keySeq}` },
      payload: { name: `Hall ${keySeq}`, slug: `hall-${keySeq}`, capacity },
    });
    return created.json().id;
  }

  /**
   * `venueId` is always supplied: `createEventSchema` requires it, so an event
   * with no venue is not reachable through the public write path. The
   * `venueId: null` branch in the service is therefore defensive rather than
   * covered here.
   */
  async function seedEvent(
    server: Server,
    org: string,
    startAt: string,
    venueId: string,
  ): Promise<string> {
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `card-event-${++keySeq}` },
      payload: { title: `Show ${keySeq}`, startAt, venueId },
    });
    return created.json().id;
  }

  it('returns an empty list for an org with no events', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await cards(server, org);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ organizationId: org, items: [] });
    await server.close();
  });

  it('resolves the venue name and capacity server-side', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 400);
    await seedEvent(server, org, '2099-06-01T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    // The client never has to join these; it gets a card it can render as-is.
    expect(body.items[0]).toMatchObject({
      venueName: expect.stringContaining('Hall'),
      capacity: 400,
    });
    await server.close();
  });

  it('keeps capacity null when the venue never declared one', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    // The default venue has no capacity — the create payload omits it.
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `card-venue-${++keySeq}` },
      payload: { name: 'Unlisted Room', slug: `unlisted-${keySeq}` },
    });
    await seedEvent(server, org, '2099-06-02T18:00:00Z', created.json().id);

    const body = (await cards(server, org)).json();

    // `null` means "not declared". `0` here would make the card divide by zero,
    // and would be indistinguishable from a sold-out zero-capacity room.
    expect(body.items[0].capacity).toBeNull();
    await server.close();
  });

  it('resolves one venue once across several cards', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 250);
    await seedEvent(server, org, '2099-06-03T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-06-04T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    // Both cards carry the same resolved venue; the service fetches it once.
    expect(body.items).toHaveLength(2);
    expect(body.items.every((c: { venueId: string }) => c.venueId === venueId)).toBe(true);
    expect(new Set(body.items.map((c: { venueName: string }) => c.venueName)).size).toBe(1);
    await server.close();
  });

  it('orders cards soonest-first and honours the limit', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 100);
    await seedEvent(server, org, '2099-09-01T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-07-01T18:00:00Z', venueId);
    await seedEvent(server, org, '2099-08-01T18:00:00Z', venueId);

    const body = (await cards(server, org, '?limit=2')).json();

    // "Next event" must be the *next* one, not the first inserted.
    expect(body.items.map((c: { startAt: string }) => c.startAt)).toEqual([
      '2099-07-01T18:00:00Z',
      '2099-08-01T18:00:00Z',
    ]);
    await server.close();
  });

  it('omits events that have already started', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    const venueId = await seedVenueWithCapacity(server, org, 100);
    await seedEvent(server, org, '2000-01-01T18:00:00Z', venueId);

    const body = (await cards(server, org)).json();

    expect(body.items).toEqual([]);
    await server.close();
  });

  it('rejects an out-of-range limit instead of clamping silently', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // An unbounded limit would let one request ask for every event in the org.
    expect((await cards(server, org, '?limit=0')).statusCode).toBe(422);
    expect((await cards(server, org, '?limit=5000')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/events',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('GET /organizations/:organizationId/analytics/calendar', () => {
  const calendar = (server: Server, org: string, month: string) =>
    server.inject({
      method: 'GET',
      url: `/organizations/${org}/analytics/calendar?month=${month}`,
      headers: read(org),
    });

  async function seedEvent(server: Server, org: string, startAt: string): Promise<void> {
    const venue = await server.inject({
      method: 'POST',
      url: `/organizations/${org}/venues`,
      headers: { ...read(org), 'idempotency-key': `cal-venue-${++keySeq}` },
      payload: { name: 'Sky Bar', slug: `cal-venue-${keySeq}` },
    });
    await server.inject({
      method: 'POST',
      url: `/organizations/${org}/events`,
      headers: { ...read(org), 'idempotency-key': `cal-event-${++keySeq}` },
      payload: { title: `Event ${keySeq}`, venueId: venue.json().id, startAt },
    });
  }

  it('returns every day of the month, zero-filled', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await calendar(server, org, '2026-09');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.days).toHaveLength(30);
    expect(body.days[0]).toEqual({ day: 1, eventCount: 0 });
    expect(body.days[29]).toEqual({ day: 30, eventCount: 0 });
    await server.close();
  });

  it('counts events on their start day', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedEvent(server, org, '2026-09-14T18:00:00Z');
    await seedEvent(server, org, '2026-09-14T21:00:00Z');

    const body = (await calendar(server, org, '2026-09')).json();

    // Two events on the same day — a date-truncated match, not a day-1 bucket.
    expect(body.days[13]).toEqual({ day: 14, eventCount: 2 });
    await server.close();
  });

  it('does not count events from another month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);
    await seedEvent(server, org, '2026-10-05T18:00:00Z');

    const body = (await calendar(server, org, '2026-09')).json();

    expect(body.days.every((d: { eventCount: number }) => d.eventCount === 0)).toBe(true);
    await server.close();
  });

  it('handles a leap February', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const body = (await calendar(server, org, '2028-02')).json();

    expect(body.days).toHaveLength(29);
    expect(body.days[28]).toEqual({ day: 29, eventCount: 0 });
    await server.close();
  });

  it('reports the weekday of the 1st with Monday as 0', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    // 2026-09-01 is a Tuesday → offset 1. Computed server-side so client and
    // server cannot disagree about where the month starts.
    expect((await calendar(server, org, '2026-09')).json().firstDayOffset).toBe(1);
    // 2026-06-01 is a Monday → offset 0.
    expect((await calendar(server, org, '2026-06')).json().firstDayOffset).toBe(0);
    // 2026-09-06 is a Sunday → offset 6.
    expect((await calendar(server, org, '2026-09')).json().firstDayOffset).toBe(1);
    await server.close();
  });

  it('rejects a malformed month', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    expect((await calendar(server, org, '2026-9')).statusCode).toBe(422);
    expect((await calendar(server, org, 'september')).statusCode).toBe(422);
    await server.close();
  });

  it('refuses an organization the caller is not scoped to', async () => {
    const server = await buildServer();
    const org = await seedOrganization(server);

    const response = await server.inject({
      method: 'GET',
      url: '/organizations/not_mine/analytics/calendar?month=2026-09',
      headers: read(org),
    });

    expect(response.statusCode).toBe(403);
    await server.close();
  });
});
