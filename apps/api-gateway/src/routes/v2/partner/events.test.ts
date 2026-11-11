import { createEvent as makeEvent } from '@c1rcle/core/domain';
import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes, { eventToDto } from './events.js';

const buildServer = () => buildPartnerTestServer({ routes: [partnerEventRoutes] });

const VALID_HEADERS = { 'x-organization-id': 'org_1' };
const CREATE_HEADERS = { 'x-organization-id': 'org_1', 'idempotency-key': 'idem-event-1' };

const CREATE_BODY = {
  title: 'Sky Night',
  venueId: 'ven_1',
  startAt: '2026-08-01T18:00:00Z',
  summary: 'An evening of music and dancing.',
  description: 'Join us for live music, dancing, and a night out with friends.',
};

describe('restricted event projection privacy', () => {
  it.each(['code', 'invited'] as const)('omits historical poster URLs for %s events', (mode) => {
    const event = makeEvent({
      id: 'evt_private',
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Private',
      startAt: '2026-08-01T18:00:00Z',
      visibilityMode: mode,
      imageUrl: 'https://storage.example.test/legacy-public-poster.jpg',
    });

    expect(eventToDto(event).imageUrl).toBeNull();
  });
});

describe('event media', () => {
  const media = {
    youtubeUrl: 'https://www.youtube.com/watch?v=abc123',
    gallery: [{ url: 'https://example.test/gallery.jpg', alt: 'Dance floor' }],
    spotlights: [
      {
        id: 'artist-1',
        title: 'Artist One',
        link: 'https://example.test/artist',
        imageUrl: null,
        description: 'Live set',
        startTime: '23:00',
        endTime: '01:00',
      },
    ],
  };
  it('persists media through the authenticated create and read projection', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { ...VALID_HEADERS, 'idempotency-key': 'media-create-1' },
      payload: { ...CREATE_BODY, media },
    });
    expect(response.statusCode).toBe(201);
    const event = response.json();
    expect(event.media).toEqual(media);
    const read = await server.inject({
      method: 'GET',
      url: `/events/${event.id}`,
      headers: VALID_HEADERS,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().media).toEqual(media);
    await server.close();
  });
  it('rejects unsafe video URLs at the API boundary', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { ...VALID_HEADERS, 'idempotency-key': 'media-invalid' },
      payload: { ...CREATE_BODY, media: { ...media, youtubeUrl: 'https://attacker.test/video' } },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });
  it('does not expose media from historical restricted records', () => {
    const event = makeEvent({
      id: 'private-media',
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Private',
      startAt: CREATE_BODY.startAt,
      visibilityMode: 'code',
    });
    expect(eventToDto({ ...event, media }).media).toBeUndefined();
  });
});

describe('server-backed Host event drafts', () => {
  it('restores drafts only for the authenticated user and matching organization, then discards them', async () => {
    const server = await buildServer();
    const headers = { 'x-organization-id': 'org_draft_a', 'x-user-id': 'draft_user' };
    const path = '/organizations/org_draft_a/event-draft';
    const empty = await server.inject({ method: 'GET', url: path, headers });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ draft: null });

    const saved = await server.inject({
      method: 'PUT',
      url: path,
      headers,
      payload: {
        schemaVersion: 1,
        data: {
          name: 'Restored event',
          description: 'Saved before submission.',
          externalVenue: {
            name: 'Independent Hall',
            address: '12 Example Road',
            managerName: 'Manager',
            managerPhone: '+91 98765 43210',
            managerEmail: 'manager@example.test',
          },
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    const restored = await server.inject({ method: 'GET', url: path, headers });
    expect(restored.json().draft.data).toMatchObject({
      name: 'Restored event',
      externalVenue: { name: 'Independent Hall', managerEmail: 'manager@example.test' },
    });

    const anotherOrganization = await server.inject({
      method: 'GET',
      url: '/organizations/org_draft_b/event-draft',
      headers: { ...headers, 'x-organization-id': 'org_draft_b' },
    });
    expect(anotherOrganization.json()).toEqual({ draft: null });

    const discarded = await server.inject({ method: 'DELETE', url: path, headers });
    expect(discarded.statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: path, headers })).json()).toEqual({
      draft: null,
    });
    await server.close();
  });

  it('rejects unsafe credentials and signed media URLs', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'PUT',
      url: '/organizations/org_1/event-draft',
      headers: { 'x-organization-id': 'org_1', 'x-user-id': 'draft_user' },
      payload: {
        schemaVersion: 1,
        data: { name: 'Event', media: { imageUrl: 'https://storage.test/image?token=secret' } },
      },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });
});

describe('external venue contact privacy', () => {
  it('creates an external-location event without a C1RCLE Venue or slot request', async () => {
    const server = await buildPartnerTestServer({
      routes: [partnerEventRoutes],
      actorRole: 'owner',
      actorCapabilities: ['host'],
    });
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': nextEventKey() },
      payload: {
        externalLocation: {
          name: 'Independent Hall',
          address: '12 Example Road',
          city: 'Pune',
          contact: { managerName: 'Private Manager', phone: '+91 98765 43210' },
        },
        title: 'External event',
        summary: 'An external venue event.',
        description: 'Guests can attend this event at an approved external location.',
        startAt: '2026-12-01T18:00:00Z',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      venueId: null,
      externalVenueReviewStatus: 'pending',
      externalLocation: { name: 'Independent Hall', address: '12 Example Road' },
      status: 'draft',
    });
    expect(JSON.stringify(response.json())).not.toContain('Private Manager');
    await server.close();
  });

  it('returns private contact only through the Host-scoped endpoint', async () => {
    const services = (await import('../../../lib/v2-services.js')).createV2Services();
    const event = makeEvent({
      id: `evt_contact_${++eventSeq}`,
      organizationId: 'org_contact_host',
      venueId: null,
      externalLocation: {
        name: 'Independent Hall',
        address: '12 Example Road',
        contact: {
          managerName: 'Private Manager',
          phone: '+91 98765 43210',
          email: 'private@example.test',
        },
        review: {
          status: 'pending',
          submittedAt: new Date().toISOString(),
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
        },
      },
      title: 'Contact privacy event',
      startAt: '2026-12-01T18:00:00Z',
    });
    await services.repos().events.save(event);
    const hostServer = await buildPartnerTestServer({
      routes: [partnerEventRoutes],
      actorRole: 'owner',
      actorCapabilities: ['host'],
    });
    const hostResponse = await hostServer.inject({
      method: 'GET',
      url: `/events/${event.id}/external-location/contact`,
      headers: { 'x-organization-id': event.organizationId },
    });
    expect(hostResponse.statusCode).toBe(200);
    expect(hostResponse.json()).toEqual({
      managerName: 'Private Manager',
      phone: '+91 98765 43210',
      email: 'private@example.test',
    });
    expect(JSON.stringify(eventToDto(event))).not.toContain('Private Manager');
    const unrelatedOrganization = await hostServer.inject({
      method: 'GET',
      url: `/events/${event.id}/external-location/contact`,
      headers: { 'x-organization-id': 'org_unrelated' },
    });
    expect(unrelatedOrganization.statusCode).toBe(404);
    await hostServer.close();

    const nonHostServer = await buildServer();
    const denied = await nonHostServer.inject({
      method: 'GET',
      url: `/events/${event.id}/external-location/contact`,
      headers: { 'x-organization-id': event.organizationId },
    });
    expect(denied.statusCode).toBe(403);
    await nonHostServer.close();
  });
});

// The services (and their idempotency store) are memoized per test file, so
// every test needs a unique idempotency-key — reusing one replays a previous
// test's result instead of creating a fresh event.
let eventSeq = 0;
function nextEventKey() {
  eventSeq += 1;
  return `idem-event-${eventSeq}`;
}

async function createEvent(server: Awaited<ReturnType<typeof buildServer>>) {
  const response = await server.inject({
    method: 'POST',
    url: '/organizations/org_1/events',
    headers: { 'x-organization-id': 'org_1', 'idempotency-key': nextEventKey() },
    payload: CREATE_BODY,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe('V2 partners events slice — validation layers', () => {
  it('rejects bad body with 422 + fieldErrors (body layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: CREATE_HEADERS,
      payload: { title: '', venueId: 'bad id!', startAt: 'not-a-date' },
    });
    const body = response.json();
    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('validation');
    expect(body.status).toBe(422);
    expect(body.fieldErrors).toHaveProperty('title');
    expect(body.fieldErrors).toHaveProperty('venueId');
    expect(body.fieldErrors).toHaveProperty('startAt');
    await server.close();
  });

  it('rejects unknown body keys with 422 (strict body)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: CREATE_HEADERS,
      payload: {
        title: 'Night',
        venueId: 'ven_1',
        startAt: '2026-08-02T18:00:00Z',
        hackerField: 'leak',
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
    await server.close();
  });

  it('rejects bad params with 422 + fieldErrors (params layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/events/not@valid',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('eventId');
    await server.close();
  });

  it('rejects bad query with 422 + fieldErrors (query layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/org_1/events?limit=9999',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('limit');
    await server.close();
  });

  it('rejects missing/bad headers with 422 + fieldErrors (headers layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('x-organization-id');
    await server.close();
  });

  it('creates an event and returns a response that passes the response schema', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': nextEventKey() },
      payload: {
        title: 'Sky Night',
        venueId: 'ven_1',
        startAt: '2026-08-01T18:00:00Z',
        entryRules: {
          doorsOpenAt: '2026-08-01T17:00:00.000Z',
          lastEntryAt: null,
          reentryAllowed: false,
          minimumAge: 21,
          idRequired: true,
          accessibilityNotes: null,
          dressCode: null,
          alcoholPolicy: null,
          prohibitedItems: [],
          supportDetails: null,
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Sky Night',
      organizationId: 'org_1',
      status: 'draft',
      isPublic: false,
      version: 1,
      entryRules: { reentryAllowed: false, minimumAge: 21, idRequired: true },
    });
    expect(typeof body.id).toBe('string');
    await server.close();
  });

  it('accepts a numeric salary payout and preserves its period', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': 'salary-event-1' },
      payload: {
        title: 'Salary Night',
        venueId: 'ven_1',
        startAt: '2026-08-02T18:00:00Z',
        compensation: {
          model: 'salary',
          globalRatePercent: null,
          tierRates: {},
          salaryAmountPaise: 125050,
          salaryPeriod: 'per_event',
          salaryNotes: 'Flat promoter payout',
        },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().compensation).toMatchObject({
      model: 'salary',
      salaryAmountPaise: 125050,
      salaryPeriod: 'per_event',
    });
    await server.close();
  });

  it('rejects a zero salary payout at the API boundary', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': 'salary-invalid-1' },
      payload: {
        title: 'Invalid Salary',
        venueId: 'ven_1',
        startAt: '2026-08-01T18:00:00Z',
        compensation: {
          model: 'salary',
          globalRatePercent: null,
          tierRates: {},
          salaryAmountPaise: 0,
          salaryPeriod: 'per_event',
          salaryNotes: null,
        },
      },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('GET one returns 404 with V2 shape for unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/events/nope_1',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });
});

describe('V2 partners events slice — listing and update', () => {
  it('lists org-scoped events with the pagination envelope', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/org_1/events?limit=10',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(id);
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10, nextCursor: null });
    expect(body.items.find((item: { id: string }) => item.id === id)).toMatchObject({
      capacity: null,
      venueName: null,
      ticketsSold: 0,
      salesCountComplete: true,
    });
    expect(body.pageInfo.total).toBeGreaterThanOrEqual(1);
    await server.close();
  });

  it('returns bounded sales and capacity evidence on tenant-scoped event detail', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'GET',
      url: `/events/${id}`,
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      capacity: null,
      venueName: null,
      ticketsSold: 0,
      salesCountComplete: true,
    });
    await server.close();
  });

  it('returns 403 when the path organization does not match the actor', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/org_999/events',
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
    await server.close();
  });

  it('patches an event via If-Match and bumps the version', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/events/${id}`,
      headers: {
        'x-organization-id': 'org_1',
        'idempotency-key': nextEventKey(),
        'if-match': '1',
      },
      payload: {
        title: 'Sky Night Reloaded',
        tags: ['party'],
        startingPricePaise: 19900,
        entryRules: {
          doorsOpenAt: null,
          lastEntryAt: null,
          reentryAllowed: false,
          minimumAge: 21,
          idRequired: true,
          accessibilityNotes: 'Step-free entrance',
          dressCode: null,
          alcoholPolicy: null,
          prohibitedItems: [],
          supportDetails: null,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      title: 'Sky Night Reloaded',
      tags: ['party'],
      startingPricePaise: 19900,
      version: 2,
      entryRules: {
        reentryAllowed: false,
        minimumAge: 21,
        accessibilityNotes: 'Step-free entrance',
      },
    });
    await server.close();
  });

  it('returns 409 when the if-match version is stale', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const bump = await server.inject({
      method: 'PATCH',
      url: `/events/${id}`,
      headers: {
        'x-organization-id': 'org_1',
        'idempotency-key': nextEventKey(),
        'if-match': '1',
      },
      payload: { title: 'Sky Night Reloaded' },
    });
    expect(bump.statusCode).toBe(200);
    const stale = await server.inject({
      method: 'PATCH',
      url: `/events/${id}`,
      headers: {
        'x-organization-id': 'org_1',
        'idempotency-key': nextEventKey(),
        'if-match': '1',
      },
      payload: { title: 'Third Title' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', status: 409 });
    expect(stale.json().details.currentVersion).toBe(2);
    await server.close();
  });

  it('returns 422 for unknown patch body keys (strict body)', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/events/${id}`,
      headers: {
        'x-organization-id': 'org_1',
        'idempotency-key': nextEventKey(),
        'if-match': '1',
      },
      payload: { title: 'X', hackerField: 'leak' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
    await server.close();
  });
});

describe('V2 partners events slice — poster upload URLs', () => {
  it('issues a bounded, time-limited PUT grant with a public read URL', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/poster/upload-url',
      headers: VALID_HEADERS,
      payload: { contentType: 'image/jpeg' },
    });
    expect(response.statusCode).toBe(200);
    const grant = response.json();
    expect(grant.method).toBe('PUT');
    expect(grant.uploadUrl).toEqual(expect.any(String));
    expect(grant.headers['content-type']).toBe('image/jpeg');
    // The signed PUT must set the *object's* ACL to public-read so the
    // returned `publicUrl` actually resolves on the guest surface (the bucket
    // and every KYC/private object stay credential-only).
    expect(grant.headers['x-goog-acl']).toBe('public-read');
    expect(grant.storagePath).toMatch(/^posters\/org_1\/[0-9a-f-]+\.jpg$/);
    expect(grant.publicUrl).toBe(`https://uploads.invalid/${grant.storagePath}`);
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    await server.close();
  });

  it('rejects a non-image content type with 422', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/poster/upload-url',
      headers: VALID_HEADERS,
      payload: { contentType: 'application/pdf' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('contentType');
    await server.close();
  });

  it('returns 403 when the path organization does not match the actor', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/organizations/org_999/poster/upload-url',
      headers: VALID_HEADERS,
      payload: { contentType: 'image/png' },
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });
});

describe('V2 partners events slice — previews and lifecycle', () => {
  it('returns the preview with the public visibility flag for a draft', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'GET',
      url: `/events/${id}/previews`,
      headers: VALID_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      event: { id, status: 'draft' },
      isPublic: false,
    });
    await server.close();
  });

  it('hides a draft preview from another organization (no cross-tenant IDOR)', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'GET',
      url: `/events/${id}/previews`,
      headers: { 'x-organization-id': 'org_2' },
    });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('walks draft → review → published → sales_paused → published → cancelled', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);

    const review = await server.inject({
      method: 'POST',
      url: `/events/${id}/review`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ id, status: 'review' });

    const published = await server.inject({
      method: 'POST',
      url: `/events/${id}/publish`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ id, status: 'published', isPublic: true });

    const paused = await server.inject({
      method: 'POST',
      url: `/events/${id}/pause-sales`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ id, status: 'sales_paused' });

    const resumed = await server.inject({
      method: 'POST',
      url: `/events/${id}/resume-sales`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ id, status: 'published' });

    const cancelled = await server.inject({
      method: 'POST',
      url: `/events/${id}/cancel`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
      payload: { reason: 'Venue flooded' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id, status: 'cancelled', isPublic: false });
    await server.close();
  });

  it('refuses to publish straight from draft (reviews not skippable)', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'POST',
      url: `/events/${id}/publish`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict', status: 409 });
    await server.close();
  });

  it('rejects blank cancellation reasons before starting a cancellation workflow', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'POST',
      url: `/events/${id}/cancel`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
      payload: { reason: '   ' },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('duplicates a source event and returns a fresh draft', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'POST',
      url: `/events/${id}/duplicate`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      title: 'Sky Night',
      venueId: 'ven_1',
      status: 'draft',
    });
    expect(response.json().id).not.toBe(id);
    await server.close();
  });

  it('carries the commission terms through duplicate', async () => {
    const server = await buildServer();
    const created = await server.inject({
      method: 'POST',
      url: '/organizations/org_1/events',
      headers: { 'x-organization-id': 'org_1', 'idempotency-key': nextEventKey() },
      payload: {
        ...CREATE_BODY,
        compensation: {
          model: 'standard',
          globalRatePercent: 12,
          tierRates: {},
          salaryAmountPaise: null,
          salaryPeriod: null,
          salaryNotes: null,
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const response = await server.inject({
      method: 'POST',
      url: `/events/${created.json().id}/duplicate`,
      headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().compensation).toMatchObject({
      model: 'standard',
      globalRatePercent: 12,
    });
    await server.close();
  });
});

describe('M3 explicit event lifecycle HTTP commands', () => {
  it('validates ownership/reason, postpones idempotently and announces an explicit replacement date', async () => {
    const server = await buildServer();
    try {
      const { id } = await createEvent(server);
      for (const action of ['review', 'publish']) {
        const response = await server.inject({
          method: 'POST',
          url: `/events/${id}/${action}`,
          headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
        });
        expect(response.statusCode, response.body).toBe(200);
      }
      const url = `/events/${id}/lifecycle`;
      const blank = await server.inject({
        method: 'POST',
        url,
        headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
        payload: { action: 'postpone', reason: ' ' },
      });
      expect(blank.statusCode).toBe(422);
      const foreign = await server.inject({
        method: 'POST',
        url,
        headers: { 'x-organization-id': 'org_foreign', 'idempotency-key': nextEventKey() },
        payload: { action: 'postpone', reason: 'Foreign update' },
      });
      expect(foreign.statusCode).toBe(404);
      const headers = { ...VALID_HEADERS, 'idempotency-key': nextEventKey() };
      const payload = { action: 'postpone', reason: 'Weather safety hold' };
      const postponed = await server.inject({ method: 'POST', url, headers, payload });
      const replay = await server.inject({ method: 'POST', url, headers, payload });
      expect(postponed.statusCode, postponed.body).toBe(200);
      expect(postponed.json()).toMatchObject({
        status: 'postponed',
        isPublic: false,
        postponement: { reason: payload.reason, initiatedBy: 'host', organizationId: 'org_1' },
      });
      expect(replay.json()).toEqual(postponed.json());
      const changedIntent = await server.inject({
        method: 'POST',
        url,
        headers,
        payload: { ...payload, reason: 'A different command' },
      });
      expect(changedIntent.statusCode).toBe(409);
      const expectedVersion = postponed.json<{ version: number }>().version;
      const past = await server.inject({
        method: 'POST',
        url,
        headers: { ...VALID_HEADERS, 'idempotency-key': nextEventKey() },
        payload: { action: 'reschedule', expectedVersion, startAt: '2000-01-01T00:00:00.000Z' },
      });
      expect(past.statusCode).toBe(400);
      const replacement = {
        action: 'reschedule',
        expectedVersion,
        startAt: '2099-12-01T18:00:00.000Z',
        endAt: '2099-12-01T23:00:00.000Z',
      };
      const replacementHeaders = { ...VALID_HEADERS, 'idempotency-key': nextEventKey() };
      const announced = await server.inject({
        method: 'POST',
        url,
        headers: replacementHeaders,
        payload: replacement,
      });
      const announcementReplay = await server.inject({
        method: 'POST',
        url,
        headers: replacementHeaders,
        payload: replacement,
      });
      expect(announced.statusCode, announced.body).toBe(200);
      expect(announced.json()).toMatchObject({
        status: 'published',
        isPublic: true,
        startAt: replacement.startAt,
        endAt: replacement.endAt,
      });
      expect(announcementReplay.json()).toEqual(announced.json());
      const stored = await server.inject({
        method: 'GET',
        url: `/events/${id}`,
        headers: VALID_HEADERS,
      });
      expect(stored.json()).toMatchObject({
        status: 'published',
        version: announced.json().version,
      });
    } finally {
      await server.close();
    }
  });
});
