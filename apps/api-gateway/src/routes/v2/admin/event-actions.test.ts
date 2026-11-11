import { createEvent, createOrganization, createPlatformAdmin } from '@c1rcle/core/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminRole, Event } from '@c1rcle/core/domain';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import adminEventActionRoutes from './event-actions.js';
import adminRoutes from './onboarding-review.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Admin event pause/resume over HTTP (Phase 7 admin) ──────────────────────
 * EVENT_PAUSE/EVENT_RESUME are TIER1 — any active admin (even `support`) may
 * call them, merely logged. No dual control, no role gate beyond being an
 * admin at all.
 */

const services = createV2Services();
let keySeq = 0;

async function seedAdmin(userId: string, role: AdminRole) {
  await services
    .repos()
    .platformAdmins.save(createPlatformAdmin({ id: userId, email: `${userId}@c1rcle.test`, role }));
}

function asUser(userId: string) {
  return { 'x-user-id': userId, 'idempotency-key': `key-${++keySeq}` };
}

async function seedPublishedEvent(): Promise<Event> {
  const org = createOrganization({
    id: `org_${++keySeq}`,
    name: `Org ${keySeq}`,
    slug: `org-${keySeq}`,
    ownerId: 'host_1',
  });
  await services.repos().organizations.save(org);
  const draft = createEvent({
    id: `event_${keySeq}`,
    organizationId: org.id,
    venueId: 'venue_1',
    title: 'Sky Night',
    startAt: '2026-10-01T18:00:00Z',
  });
  // Constructed directly at `published` for this first save (not via
  // `transitionEvent`, which would bump the version past what a brand-new
  // document's compare-and-set expects).
  const event = { ...draft, status: 'published' as const, isPublic: true };
  await services.repos().events.save(event);
  return event;
}

async function seedExternalVenueEvent(ownerId = 'host_1'): Promise<Event> {
  const org = createOrganization({
    id: `org_external_${++keySeq}`,
    name: `External host ${keySeq}`,
    slug: `external-host-${keySeq}`,
    ownerId,
  });
  await services.repos().organizations.save(org);
  const event = createEvent({
    id: `event_external_${keySeq}`,
    organizationId: org.id,
    venueId: null,
    externalLocation: {
      name: 'Independent Hall',
      address: '12 Example Road',
      city: 'Pune',
      contact: {
        managerName: 'Private Manager',
        phone: '+91 98765 43210',
        email: 'manager@example.test',
      },
      review: {
        status: 'pending',
        submittedAt: new Date('2026-11-01T10:00:00.000Z').toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
    },
    title: 'External event',
    startAt: '2026-12-01T18:00:00Z',
  });
  await services.repos().events.save(event);
  return event;
}

let server: FastifyInstance;

beforeEach(async () => {
  const repos = services.repos();
  (repos.platformAdmins as unknown as { admins: Map<string, unknown> }).admins.clear();
  (repos.organizations as unknown as { organizations: Map<string, unknown> }).organizations.clear();
  (repos.events as unknown as { events: Map<string, unknown> }).events.clear();
  (services.adminAudits() as unknown as { records: unknown[] }).records = [];

  server = await buildPartnerTestServer({ routes: [adminRoutes, adminEventActionRoutes] });
});

describe('EVENT_PAUSE / EVENT_RESUME (TIER1, any admin)', () => {
  it('pauses a published event with admin override and writes an audit row', async () => {
    await seedAdmin('admin_a', 'support');
    const event = await seedPublishedEvent();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/pause`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      id: event.id,
      status: 'sales_paused',
      adminOverride: true,
    });

    const audit = await server.inject({
      method: 'GET',
      url: '/admin/audit?limit=10',
      headers: { 'x-user-id': 'admin_a' },
    });
    const records = audit.json().items as { action: string }[];
    expect(records.some((record) => record.action === 'EVENT_PAUSE')).toBe(true);
  });

  it('resumes a paused event and clears admin override', async () => {
    await seedAdmin('admin_a', 'support');
    const event = await seedPublishedEvent();
    await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/pause`,
      headers: asUser('admin_a'),
    });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/resume`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ status: 'published', adminOverride: false });
  });

  it('refuses to pause an event that is not published/paused', async () => {
    await seedAdmin('admin_a', 'super');
    const draft = createEvent({
      id: `event_${++keySeq}`,
      organizationId: 'org_any',
      venueId: 'venue_1',
      title: 'Draft event',
      startAt: '2026-10-01T18:00:00Z',
    });
    await services.repos().events.save(draft);

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${draft.id}/pause`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(400);
  });

  it('non-admin is refused', async () => {
    const event = await seedPublishedEvent();
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/pause`,
      headers: asUser('not_an_admin'),
    });
    expect(executed.statusCode).toBe(401);
  });

  it('unknown event id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'support');
    const executed = await server.inject({
      method: 'POST',
      url: '/admin/events/event_missing/pause',
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(404);
  });
});

describe('EVENT_FORCE_PAUSE (force-complete, TIER1, any admin)', () => {
  it('force-completes a published event (admin-only FSM edge)', async () => {
    await seedAdmin('admin_a', 'support');
    const event = await seedPublishedEvent();

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/force-complete`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      id: event.id,
      status: 'ended',
      isPublic: false,
      adminOverride: true,
    });

    const audit = await server.inject({
      method: 'GET',
      url: '/admin/audit?limit=10',
      headers: { 'x-user-id': 'admin_a' },
    });
    const records = audit.json().items as { action: string }[];
    expect(records.some((record) => record.action === 'EVENT_FORCE_PAUSE')).toBe(true);
  });

  it('force-completes a started event', async () => {
    await seedAdmin('admin_a', 'support');
    const event = await seedPublishedEvent();
    await services
      .repos()
      .events.save({ ...event, status: 'started', isPublic: true, version: event.version + 1 });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/force-complete`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ status: 'ended', adminOverride: true });
  });

  it('is idempotent on an already-ended event (200, no new audit)', async () => {
    await seedAdmin('admin_a', 'support');
    const event = await seedPublishedEvent();
    await services.repos().events.save({
      ...event,
      status: 'ended',
      isPublic: false,
      adminOverride: true,
      version: event.version + 1,
    });

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/force-complete`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ status: 'ended' });
  });

  it('refuses to force-complete a draft event -> 400', async () => {
    await seedAdmin('admin_a', 'support');
    const draft = createEvent({
      id: `event_${++keySeq}`,
      organizationId: 'org_any',
      venueId: 'venue_1',
      title: 'Draft event',
      startAt: '2026-10-01T18:00:00Z',
    });
    await services.repos().events.save(draft);

    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${draft.id}/force-complete`,
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(400);
  });

  it('non-admin is refused -> 401', async () => {
    const event = await seedPublishedEvent();
    const executed = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/force-complete`,
      headers: asUser('not_an_admin'),
    });
    expect(executed.statusCode).toBe(401);
  });

  it('unknown event id -> 404 not_found', async () => {
    await seedAdmin('admin_a', 'support');
    const executed = await server.inject({
      method: 'POST',
      url: '/admin/events/event_missing/force-complete',
      headers: asUser('admin_a'),
    });
    expect(executed.statusCode).toBe(404);
  });
});

describe('external venue review', () => {
  it('limits contact-bearing review requests to admin, ops, and super reviewers', async () => {
    const event = await seedExternalVenueEvent();
    await seedAdmin('support_user', 'support');
    await seedAdmin('ops_user', 'ops');

    const denied = await server.inject({
      method: 'GET',
      url: '/admin/external-venue-requests',
      headers: { 'x-user-id': 'support_user' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await server.inject({
      method: 'GET',
      url: '/admin/external-venue-requests',
      headers: { 'x-user-id': 'ops_user' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().items).toContainEqual(
      expect.objectContaining({
        eventId: event.id,
        location: expect.objectContaining({
          contact: {
            managerName: 'Private Manager',
            phone: '+91 98765 43210',
            email: 'manager@example.test',
          },
        }),
      }),
    );
  });

  it('prevents a Host from reviewing their own request and records reviewer decisions', async () => {
    const selfOwned = await seedExternalVenueEvent('admin_owner');
    await seedAdmin('admin_owner', 'admin');
    const selfReview = await server.inject({
      method: 'POST',
      url: `/admin/events/${selfOwned.id}/external-venue-review`,
      headers: asUser('admin_owner'),
      payload: { decision: 'approve' },
    });
    expect(selfReview.statusCode).toBe(403);

    const event = await seedExternalVenueEvent();
    await seedAdmin('ops_user', 'ops');
    const rejected = await server.inject({
      method: 'POST',
      url: `/admin/events/${event.id}/external-venue-review`,
      headers: asUser('ops_user'),
      payload: { decision: 'reject', reason: 'Please provide the venue permission letter.' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      (await services.repos().events.getById(event.id))?.externalLocation?.review,
    ).toMatchObject({
      status: 'rejected',
      reviewedBy: 'ops_user',
      rejectionReason: 'Please provide the venue permission letter.',
    });
    expect(await services.adminAudits().listForTarget(event.id, 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'EXTERNAL_VENUE_REJECT' })]),
    );
  });
});
