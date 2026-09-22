import {
  createEvent,
  createOnboardingRequest,
  createOrganization,
  createPromoCode,
  createPromoterAssignment,
  createRefundRequest,
  createTicketTier,
  createVenue,
  createOrder,
  issueEntitlements,
} from '@c1rcle/core/domain';

import type { PricingBreakdown } from '@c1rcle/core/domain';

import { richestV1Docs } from '../lib/v1-read-only-client.js';
import { createV2Services } from '../lib/v2-services.js';

/**
 * ─── One-off: sample v1 → v2 migration + downstream dev seed ────────────────
 *
 * v1's `thec1rcle-india` Firestore project holds only mock/test data (per
 * the product owner) — this deliberately does NOT do a full migration. It
 * copies the 10 richest (most-populated-field) documents from v1's `hosts`
 * and `venues`/`events` collections into `c1rcle-v2` as real v2 domain
 * entities (organizations/venues/events), preserving the recognisable name
 * data, then seeds realistic downstream records (onboarding requests,
 * promoter assignments, ticket tiers + promo codes, paid orders with
 * entitlements, refund requests) referencing those migrated entities so
 * every admin desk has non-empty, internally-consistent data to show.
 *
 * v1 credentials come from `thec1rcle/apps/api-gateway/.env.development`
 * (read-only connection, never written to). v2 credentials come from this
 * app's own `.env.local` via `getGatewayConfig()` (same as every other
 * script in this directory).
 *
 * Usage: `pnpm --filter api-gateway exec tsx src/scripts/migrate-and-seed-v1-sample.ts`
 *
 * Idempotent-ish: re-running overwrites the same `seed_*`-prefixed ids
 * rather than creating duplicates, but does not delete anything a prior run
 * created that this run no longer produces.
 */

function str(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function num(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function slugify(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : fallback;
}

async function main(): Promise<void> {
  const services = createV2Services();
  const repos = services.repos();
  const now = new Date();

  console.info('Reading v1 (thec1rcle-india)…');
  const [v1Hosts, v1Venues, v1Events] = await Promise.all([
    richestV1Docs('hosts', 10),
    richestV1Docs('venues', 10),
    richestV1Docs('events', 10),
  ]);
  console.info(
    `Found ${v1Hosts.length} hosts, ${v1Venues.length} venues, ${v1Events.length} events in v1.`,
  );

  // ─── Migrate: organizations (from v1 hosts) ────────────────────────────────
  const orgIds: string[] = [];
  for (const [index, host] of v1Hosts.entries()) {
    const id = `seed_org_${index + 1}`;
    const name =
      str(host.data, 'name', 'businessName', 'legalName') ?? `Migrated Host ${index + 1}`;
    const org = createOrganization({
      id,
      name,
      slug: slugify(name, id),
      ownerId: `seed_user_owner_${index + 1}`,
      platformFeePercent: num(host.data, 'platformFeePercent', 'commissionPercent') ?? 15,
      settings: { defaultCurrency: 'INR', timezone: 'Asia/Kolkata' },
      now,
    });
    await repos.organizations.save(org);
    orgIds.push(id);
  }
  console.info(`Migrated ${orgIds.length} organizations.`);

  // ─── Migrate: venues (from v1 venues), attached round-robin to migrated orgs ─
  const venueIds: string[] = [];
  for (const [index, venue] of v1Venues.entries()) {
    const id = `seed_venue_${index + 1}`;
    const organizationId = orgIds[index % orgIds.length] ?? orgIds[0];
    if (organizationId === undefined) break; // no orgs migrated — nothing to attach to
    const name = str(venue.data, 'name', 'venueName') ?? `Migrated Venue ${index + 1}`;
    const v = createVenue({
      id,
      organizationId,
      ownerId: `seed_user_owner_${(index % orgIds.length) + 1}`,
      name,
      slug: slugify(name, id),
      description: str(venue.data, 'description', 'about') ?? '',
      capacity: num(venue.data, 'capacity', 'maxCapacity') ?? null,
      city: str(venue.data, 'city', 'address.city') ?? null,
      now,
    });
    await repos.venues.save(v);
    venueIds.push(id);
  }
  console.info(`Migrated ${venueIds.length} venues.`);

  // ─── Migrate: events (from v1 events), attached round-robin to migrated venues/orgs ─
  const eventIds: string[] = [];
  for (const [index, event] of v1Events.entries()) {
    const id = `seed_evt_${index + 1}`;
    const organizationId = orgIds[index % orgIds.length];
    const venueId = venueIds[index % Math.max(venueIds.length, 1)];
    if (organizationId === undefined || venueId === undefined) break;
    const title = str(event.data, 'title', 'name') ?? `Migrated Event ${index + 1}`;
    const startAt = new Date(now.getTime() + (index + 1) * 3 * 24 * 60 * 60 * 1000).toISOString();
    const e = createEvent({
      id,
      organizationId,
      venueId,
      title,
      summary: str(event.data, 'summary', 'shortDescription') ?? '',
      description: str(event.data, 'description', 'about') ?? '',
      startAt,
      endAt: new Date(new Date(startAt).getTime() + 4 * 60 * 60 * 1000).toISOString(),
      tags: [],
      now,
    });
    const priceInPaise = (num(event.data, 'price', 'ticketPrice') ?? 500) * 100;
    const published = {
      ...e,
      status: 'published' as const,
      isPublic: true,
      startingPricePaise: priceInPaise,
      isFree: priceInPaise === 0,
    };
    await repos.events.save(published);
    eventIds.push(id);
  }
  console.info(`Migrated ${eventIds.length} events.`);

  if (orgIds.length === 0 || venueIds.length === 0 || eventIds.length === 0) {
    console.warn(
      'Nothing to attach downstream seed data to — v1 source collections came back empty. Stopping.',
    );
    return;
  }

  // ─── Seed: onboarding requests (mixed statuses, for the KYC/onboarding desk) ─
  const onboardingStatuses = [
    'submitted',
    'submitted',
    'approved',
    'rejected',
    'changes_requested',
  ] as const;
  for (let i = 0; i < 8; i++) {
    const id = `seed_ob_${i + 1}`;
    const status = onboardingStatuses[i % onboardingStatuses.length];
    let request = createOnboardingRequest({
      id,
      userId: `seed_user_applicant_${i + 1}`,
      requestedType: (['venue', 'host', 'promoter'] as const)[i % 3] ?? 'venue',
      plan: (['basic', 'silver', 'diamond'] as const)[i % 3] ?? 'basic',
      profile: {
        legalName: `Seed Applicant ${i + 1}`,
        contactPerson: `Contact Person ${i + 1}`,
        phone: `+9198765432${(10 + i).toString().slice(-2)}`,
        city: ['Mumbai', 'Bengaluru', 'Delhi', 'Pune'][i % 4] ?? 'Mumbai',
        businessType: 'nightlife',
      },
      now,
    });
    request = { ...request, status: 'submitted', submittedAt: now.toISOString() };
    if (status === 'approved' || status === 'rejected') {
      request = {
        ...request,
        status,
        reviewedBy: 'seed_admin_reviewer',
        reviewedAt: now.toISOString(),
        reviewNote: status === 'approved' ? 'Looks good, approved.' : 'Documents incomplete.',
        provisionedOrganizationId:
          status === 'approved' ? (orgIds[i % orgIds.length] ?? null) : null,
      };
    } else if (status === 'changes_requested') {
      request = { ...request, status, reviewNote: 'Please resubmit ID proof.' };
    }
    await repos.onboarding.save(request);
  }
  console.info('Seeded 8 onboarding requests.');

  // ─── Seed: ticket tiers + promo codes per migrated event ───────────────────
  const tierIdsByEvent = new Map<string, string>();
  for (const [index, eventId] of eventIds.entries()) {
    const organizationId = orgIds[index % orgIds.length];
    if (organizationId === undefined) continue;
    const tierId = `seed_tier_${index + 1}`;
    const tier = createTicketTier({
      id: tierId,
      eventId,
      organizationId,
      name: 'General Entry',
      priceInPaise: 50000 + index * 5000,
      quantity: 200,
      now,
    });
    await repos.catalog.saveTier(tier);
    tierIdsByEvent.set(eventId, tierId);

    if (index < 6) {
      const promo = createPromoCode({
        id: `seed_promo_${index + 1}`,
        eventId,
        organizationId,
        code: `EARLY${index + 1}`,
        discountType: index % 2 === 0 ? 'percent' : 'fixed',
        discountValue: index % 2 === 0 ? 15 : 10000,
        maxRedemptions: 100,
        now,
      });
      await repos.catalog.savePromo(promo);
    }
  }
  console.info(`Seeded ${tierIdsByEvent.size} ticket tiers and up to 6 promo codes.`);

  // ─── Seed: promoter assignments per migrated event ─────────────────────────
  const assignmentStatuses = ['active', 'active', 'active', 'ended'] as const;
  for (let i = 0; i < Math.min(8, eventIds.length * 2); i++) {
    const eventId = eventIds[i % eventIds.length];
    if (eventId === undefined) continue;
    let assignment = createPromoterAssignment({
      id: `seed_promoter_assign_${i + 1}`,
      eventId,
      promoterId: `seed_user_promoter_${(i % 4) + 1}`,
      terms: { version: 1, ratePercent: 10 + (i % 3) * 5, flatPaise: 0 },
      now,
    });
    const status = assignmentStatuses[i % assignmentStatuses.length];
    if (status === 'ended') {
      assignment = { ...assignment, status, endedAt: now.toISOString() };
    }
    await repos.catalog.saveAssignment(assignment);
  }
  console.info('Seeded promoter assignments.');

  // ─── Seed: paid orders + entitlements, so Orders/Tickets desks show data ───
  const orderIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const eventId = eventIds[i % eventIds.length];
    const organizationId = orgIds[i % orgIds.length];
    const tierId = eventId === undefined ? undefined : tierIdsByEvent.get(eventId);
    if (eventId === undefined || organizationId === undefined || tierId === undefined) continue;

    const quantity = 1 + (i % 3);
    const unitPricePaise = 50000 + (i % eventIds.length) * 5000;
    const subtotalPaise = unitPricePaise * quantity;
    const pricing: PricingBreakdown = {
      lines: [{ tierId, tierName: 'General Entry', quantity, unitPricePaise, subtotalPaise }],
      subtotalPaise,
      discountPaise: 0,
      discountedSubtotalPaise: subtotalPaise,
      platformFeePaise: Math.round(subtotalPaise * 0.15),
      paymentFeePaise: Math.round(subtotalPaise * 0.02),
      gstPaise: 0,
      grandTotalPaise: subtotalPaise + Math.round(subtotalPaise * 0.17),
      appliedPromoCode: null,
      currency: 'INR',
    };
    const orderId = `seed_order_${i + 1}`;
    let order = createOrder({
      id: orderId,
      eventId,
      organizationId,
      contact: {
        name: `Seed Guest ${i + 1}`,
        email: `guest${i + 1}@example.test`,
        phone: '+919876500000',
      },
      pricing,
      now,
    });
    order = {
      ...order,
      status: 'paid',
      paymentIntentId: `pi_seed_${i + 1}`,
      paymentId: `pay_seed_${i + 1}`,
      paidAt: now.toISOString(),
    };
    await repos.orders.save(order);
    orderIds.push(orderId);

    const entitlements = issueEntitlements({ order, now });
    await repos.entitlements.saveMany(entitlements);

    // A couple of scanned tickets, so the Tickets desk shows some redeemed state.
    if (i % 4 === 0 && entitlements[0] !== undefined) {
      const scanned = {
        ...entitlements[0],
        status: 'redeemed' as const,
        scanCount: 1,
        scannedAt: [now.toISOString()],
      };
      await repos.entitlements.save(scanned);
    }
  }
  console.info(`Seeded ${orderIds.length} paid orders with entitlements.`);

  // ─── Seed: refund requests against a few of the seeded orders ──────────────
  for (let i = 0; i < Math.min(6, orderIds.length); i++) {
    const orderId = orderIds[i];
    const organizationId = orgIds[i % orgIds.length];
    if (orderId === undefined || organizationId === undefined) continue;
    const amountPaise = [10000, 60000, 550000, 20000, 45000, 700000][i] ?? 20000;
    let refund = createRefundRequest({
      id: `seed_refund_${i + 1}`,
      orderId,
      organizationId,
      amountPaise,
      requestedBy: 'seed_admin_reviewer',
      reason:
        ['Guest could not attend', 'Duplicate charge', 'Event cancelled'][i % 3] ?? 'Guest request',
      hasRedeemedEntitlement: false,
      now,
    });
    if (i === 3)
      refund = {
        ...refund,
        status: 'rejected',
        rejectedBy: 'seed_admin_reviewer',
        rejectionReason: 'Outside refund window',
      };
    if (i === 4) refund = { ...refund, status: 'settled', providerRefundId: `rfnd_seed_${i + 1}` };
    await repos.refundRequests.save(refund);
  }
  console.info('Seeded refund requests.');

  console.info('Done.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
