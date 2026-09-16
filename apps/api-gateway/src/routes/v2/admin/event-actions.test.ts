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
