import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getV2Services } from '../../../lib/v2-services.js';
import { buildTestApp, signInPartner, type Partner } from '../../../test-utils/app-harness.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── The partner journey (task.md §9 definition of done) ─────────────────────
 * "org → venue → slot request → event create → publish → previews", run through
 * the real HTTP surface with a real session — the closest thing to the staging
 * smoke test that can run in CI.
 */

let app: FastifyInstance;
let partner: Partner;

beforeEach(async () => {
  app = await buildTestApp();
  partner = await signInPartner(app);
});

afterEach(async () => {
  await app.close();
});

describe('partner journey', () => {
  it('runs org → venue → slot request → event → publish → previews', async () => {
    // ── venue ──────────────────────────────────────────────────────────────
    const venueResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/organizations/${partner.organizationId}/venues`,
      headers: partner.write(),
      payload: { name: 'Sky Bar', slug: 'sky-bar' },
    });
    expect(venueResponse.statusCode).toBe(201);
    const venue: { id: string; version: number } = venueResponse.json();

    // The public projection must never carry contact details.
    const profile = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/venues/${venue.id}/profile`,
      headers: partner.read(),
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).not.toHaveProperty('contactEmail');
    expect(profile.json()).not.toHaveProperty('contactPhone');

    // ── slot request ───────────────────────────────────────────────────────
    const slotRequest = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/venues/${venue.id}/slot-requests`,
      headers: partner.write(),
      payload: { message: 'Friday night, please' },
    });
    expect(slotRequest.statusCode).toBe(201);
    expect(slotRequest.json()).toMatchObject({ status: 'pending', venueId: venue.id });

    const slotRequests = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/venues/${venue.id}/slot-requests`,
      headers: partner.read(),
    });
    expect(slotRequests.json().items).toHaveLength(1);

    // ── event ──────────────────────────────────────────────────────────────
    const eventResponse = await app.inject({
      method: 'POST',
      url: '/api/v2/partner/events',
      headers: partner.write(),
      payload: { title: 'Sky Night', venueId: venue.id, startAt: '2026-09-01T18:00:00Z' },
    });
    expect(eventResponse.statusCode).toBe(201);
    const event: { id: string; version: number } = eventResponse.json();
    expect(event).toMatchObject({ status: 'draft', isPublic: false });

    // ── review → publish ───────────────────────────────────────────────────
    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/review`,
      headers: partner.write({ 'if-match': String(event.version) }),
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ status: 'review' });

    const published = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/publish`,
      headers: partner.write({ 'if-match': String(reviewed.json().version) }),
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: 'published', isPublic: true });

    // ── previews ───────────────────────────────────────────────────────────
    const previews = await app.inject({
      method: 'GET',
      url: `/api/v2/partner/events/${event.id}/previews`,
      headers: partner.read(),
    });
    expect(previews.statusCode).toBe(200);
    expect(previews.json()).toMatchObject({ isPublic: true, event: { status: 'published' } });

    // ── the audit trail the outbox produced ────────────────────────────────
    const services = getV2Services();
    const drained = await services.relay.drain();
    expect(drained.failed).toBe(0);
    const audit = await services.repos().audit.listForOrganization(partner.organizationId);
    expect(audit.map((record) => record.action)).toEqual(
      expect.arrayContaining(['event.created', 'event.updated', 'event.published']),
    );
    // Exactly one publish record, however many times the relay runs.
    await services.relay.drain();
    const again = await services.repos().audit.listForOrganization(partner.organizationId);
    expect(again.filter((record) => record.action === 'event.published')).toHaveLength(1);
  });

  it('refuses a stale action and accepts the retry after refetch', async () => {
    const venue = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/organizations/${partner.organizationId}/venues`,
      headers: partner.write(),
      payload: { name: 'Stale Bar', slug: 'stale-bar' },
    });
    const event: { id: string; version: number } = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/partner/events',
        headers: partner.write(),
        payload: {
          title: 'Stale Night',
          venueId: venue.json().id,
          startAt: '2026-09-01T18:00:00Z',
        },
      })
    ).json();

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/review`,
      headers: partner.write({ 'if-match': '99' }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'conflict',
      details: { expectedVersion: 99, currentVersion: event.version },
    });

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/review`,
      headers: partner.write({ 'if-match': String(event.version) }),
    });
    expect(retried.statusCode).toBe(200);
  });

  it('replays a repeated publish instead of transitioning twice', async () => {
    const venue = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/organizations/${partner.organizationId}/venues`,
      headers: partner.write(),
      payload: { name: 'Replay Bar', slug: 'replay-bar' },
    });
    const event: { id: string; version: number } = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/partner/events',
        headers: partner.write(),
        payload: {
          title: 'Replay Night',
          venueId: venue.json().id,
          startAt: '2026-09-01T18:00:00Z',
        },
      })
    ).json();

    const reviewed = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/review`,
      headers: partner.write({ 'if-match': String(event.version) }),
    });

    const key = `publish-once-${event.id}`;
    const headers = {
      ...partner.write({ 'if-match': String(reviewed.json().version) }),
      'idempotency-key': key,
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/publish`,
      headers,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v2/partner/events/${event.id}/publish`,
      headers,
    });

    expect(first.statusCode).toBe(200);
    // Byte-identical replay: the second call never reached the FSM, so the
    // version did not advance a second time.
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
  });
});
