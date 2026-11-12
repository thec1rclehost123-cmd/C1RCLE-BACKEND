import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';
import partnerPartnershipRoutes from './partnerships.js';
import partnerVenueRoutes from './venues.js';

const buildServer = () =>
  buildPartnerTestServer({ routes: [partnerVenueRoutes, partnerPartnershipRoutes] });
const services = createV2Services();

async function buildSlotRequestServer() {
  const server = await buildPartnerTestServer({
    routes: [partnerVenueRoutes, partnerPartnershipRoutes, partnerEventRoutes],
  });
  server.addHook('onRequest', async (request) => {
    const organizationId = String(request.headers['x-organization-id'] ?? '');
    const isVenue = organizationId === ORG;
    request.actor = {
      userId: isVenue ? 'venue_owner_test' : 'host_owner_test',
      organizationId,
      role: 'owner',
      capabilities: [isVenue ? 'venue' : 'host'],
      platformRole: 'partner',
    };
  });
  return server;
}

const ORG = 'org_1';
const READ_HEADERS = { 'x-organization-id': ORG };

const CREATE_BODY = {
  name: 'Aurora Hall',
  slug: 'aurora-hall',
  description: 'A grand hall with a stage',
  capacity: 500,
  city: 'Pune',
};

// The services (and their idempotency store) are memoized per test file, so
// every test needs a unique idempotency-key — reusing one replays a previous
// test's result instead of creating a fresh venue.
let venueSeq = 0;
function nextVenueKey() {
  venueSeq += 1;
  return `idem-venue-${venueSeq}`;
}

async function createVenue(server: Awaited<ReturnType<typeof buildServer>>) {
  const response = await server.inject({
    method: 'POST',
    url: `/organizations/${ORG}/venues`,
    headers: { 'x-organization-id': ORG, 'idempotency-key': nextVenueKey() },
    payload: CREATE_BODY,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function activateHostPartnership(
  server: Awaited<ReturnType<typeof buildServer>>,
  venueId: string,
  hostOrganizationId: string,
) {
  const requested = await server.inject({
    method: 'POST',
    url: '/partnerships',
    headers: {
      'x-organization-id': hostOrganizationId,
      'idempotency-key': nextVenueKey(),
    },
    payload: { venueId, initiatedBy: 'host' },
  });
  expect(requested.statusCode).toBe(201);
  const approved = await server.inject({
    method: 'POST',
    url: `/partnerships/${requested.json().id}/approve`,
    headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
  });
  expect(approved.statusCode).toBe(200);
}

async function createHostSlotRequestFixture(
  server: Awaited<ReturnType<typeof buildServer>>,
  linkLiveEvent = false,
  eventDraft?: (venueId: string) => Record<string, unknown>,
) {
  const { id: venueId } = await createVenue(server);
  const hostOrganizationId = `org_host_slot_test_${String(venueSeq)}`;
  await activateHostPartnership(server, venueId, hostOrganizationId);
  const slotResponse = await server.inject({
    method: 'POST',
    url: `/venues/${venueId}/calendar/availability`,
    headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    payload: {
      label: 'M3 Host slot-request test',
      startTime: '2030-11-04T12:30:00.000Z',
      endTime: '2030-11-04T16:30:00.000Z',
      timezone: 'Asia/Kolkata',
      visibleToHostIds: [hostOrganizationId],
    },
  });
  expect(slotResponse.statusCode).toBe(201);
  const requestResponse = await server.inject({
    method: 'POST',
    url: `/venues/${venueId}/slot-requests`,
    headers: {
      'x-organization-id': hostOrganizationId,
      'idempotency-key': nextVenueKey(),
    },
    payload: {
      slotId: slotResponse.json().id,
      message: 'M3 slot request fixture',
      ...(eventDraft ? { eventDraft: eventDraft(venueId) } : {}),
    },
  });
  expect(requestResponse.statusCode).toBe(201);
  let request = requestResponse.json();
  if (linkLiveEvent) {
    const accepted = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(accepted.statusCode).toBe(200);
    const created = await server.inject({
      method: 'POST',
      url: `/organizations/${hostOrganizationId}/events`,
      headers: { 'x-organization-id': hostOrganizationId, 'idempotency-key': nextVenueKey() },
      payload: {
        title: 'Live event linked to a Venue booking',
        venueId,
        slotRequestId: request.id,
        startAt: '2030-11-04T12:30:00.000Z',
        endAt: '2030-11-04T16:30:00.000Z',
        summary: 'A concise guest-facing summary.',
        description: 'A complete guest-facing description for the linked event.',
      },
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const eventId = String(created.json().id);
    const review = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/review`,
      headers: { 'x-organization-id': hostOrganizationId, 'idempotency-key': nextVenueKey() },
    });
    expect(review.statusCode).toBe(200);
    const published = await server.inject({
      method: 'POST',
      url: `/events/${eventId}/publish`,
      headers: { 'x-organization-id': hostOrganizationId, 'idempotency-key': nextVenueKey() },
    });
    expect(published.statusCode).toBe(200);
    const outgoing = await server.inject({
      method: 'GET',
      url: `/organizations/${hostOrganizationId}/slot-requests?limit=10`,
      headers: { 'x-organization-id': hostOrganizationId },
    });
    expect(outgoing.statusCode).toBe(200);
    request = outgoing.json().items.find((item: { id: string }) => item.id === request.id);
  }
  return {
    venueId,
    hostOrganizationId,
    slot: slotResponse.json(),
    request,
  };
}

describe('V2 partners venues slice — validation layers', () => {
  it('rejects a malformed create body with 422 + fieldErrors (body layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      headers: { 'x-organization-id': ORG, 'idempotency-key': nextVenueKey() },
      payload: { name: '', slug: 'Bad Slug!', capacity: -2 },
    });
    const body = response.json();
    expect(response.statusCode).toBe(422);
    expect(body.code).toBe('validation');
    expect(body.fieldErrors).toHaveProperty('name');
    expect(body.fieldErrors).toHaveProperty('slug');
    expect(body.fieldErrors).toHaveProperty('capacity');
    await server.close();
  });

  it('rejects unknown create body keys (create schema is not strict; a venue is made)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      headers: { 'x-organization-id': ORG, 'idempotency-key': nextVenueKey() },
      payload: { ...CREATE_BODY, hackerField: 'leak' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'Aurora Hall' });
    await server.close();
  });

  it('rejects unknown patch body keys with 422 (strict body)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': nextVenueKey(),
        'if-match': '1',
      },
      payload: { public: { name: 'X' }, hackerField: 'leak' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('_root');
    await server.close();
  });

  it('rejects a missing x-organization-id header with 422 (headers layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      payload: CREATE_BODY,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('x-organization-id');
    await server.close();
  });

  it('rejects a bad venueId param with 422 (params layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/venues/not@valid',
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('venueId');
    await server.close();
  });

  it('rejects an out-of-range list limit with 422 (query layer)', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${ORG}/venues?limit=500`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('limit');
    await server.close();
  });
});

describe('V2 partners venues slice — venues CRUD', () => {
  it('creates a venue and returns a response matching the wire schema', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      headers: { 'x-organization-id': ORG, 'idempotency-key': nextVenueKey() },
      payload: CREATE_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: 'Aurora Hall',
      slug: 'aurora-hall',
      description: 'A grand hall with a stage',
      capacity: 500,
      city: 'Pune',
      organizationId: ORG,
      status: 'active',
      version: 1,
    });
    expect(typeof response.json().id).toBe('string');
    await server.close();
  });

  it('replays the same create for an idempotency-key instead of duplicating', async () => {
    const server = await buildServer();
    const headers = { 'x-organization-id': ORG, 'idempotency-key': 'idem-venue-replay' };
    const first = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      headers,
      payload: CREATE_BODY,
    });
    const second = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/venues`,
      headers,
      payload: CREATE_BODY,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    await server.close();
  });

  it('lists org-scoped venues with the pagination envelope', async () => {
    const server = await buildServer();
    const { id, version } = await createVenue(server);
    expect(version).toBe(1);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${ORG}/venues?limit=10`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(id);
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    expect(body.pageInfo.total).toBeGreaterThanOrEqual(1);
    await server.close();
  });

  it('returns 403 when the path organization does not match the actor', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/organizations/org_999/venues',
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
    await server.close();
  });

  it('gets one venue by id', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: 'Aurora Hall' });
    await server.close();
  });

  it('returns 404 for an unknown venue id', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: '/venues/nope_1',
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('hides cross-tenant venue existence as 404 (IDOR guard)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}`,
      headers: { 'x-organization-id': 'org_2' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it('lets an active host partner read the public venue summary', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const hostOrganizationId = `org_host_summary_${String(venueSeq)}`;
    await activateHostPartnership(server, id, hostOrganizationId);

    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}`,
      headers: { 'x-organization-id': hostOrganizationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: 'Aurora Hall' });
    await server.close();
  });

  it('keeps the private venue profile hidden from an active host partner', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const hostOrganizationId = `org_host_private_${String(venueSeq)}`;
    await activateHostPartnership(server, id, hostOrganizationId);

    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/profile`,
      headers: { 'x-organization-id': hostOrganizationId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it('patches the public profile with optimistic concurrency', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-upd-1',
        'if-match': '1',
      },
      payload: { public: { name: 'Aurora Grand' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, name: 'Aurora Grand', version: 2 });
    await server.close();
  });

  it('returns 409 when the if-match version is stale', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const bump = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-upd-bump',
        'if-match': '1',
      },
      payload: { public: { name: 'Aurora Grand' } },
    });
    expect(bump.statusCode).toBe(200);
    const stale = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-upd-stale',
        'if-match': '1',
      },
      payload: { public: { name: 'Third Name' } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'conflict', status: 409 });
    expect(stale.json().details.currentVersion).toBe(2);
    await server.close();
  });
});

describe('V2 partners venues slice — profile, calendar, menu, availability', () => {
  it('gets the owner-scoped profile with public + private fields', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/profile`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      public: { name: 'Aurora Hall', slug: 'aurora-hall', facilities: [] },
      private: { contactEmail: null, contactPhone: null, internalNotes: '' },
    });
    await server.close();
  });

  it('updates the profile via PATCH /profile', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}/profile`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-profile-1',
        'if-match': '1',
      },
      payload: {
        public: { name: 'Aurora Loft' },
        private: { contactEmail: 'bookings@aurora.test' },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      public: { name: 'Aurora Loft' },
      private: { contactEmail: 'bookings@aurora.test' },
    });
    await server.close();
  });

  it('sets venue coordinates via PATCH /profile (D-030 geofence)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}/profile`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-profile-address-1',
        'if-match': '1',
      },
      payload: {
        public: { address: { city: 'Pune', lat: 18.5204, lng: 73.8567 } },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().public.address).toMatchObject({
      city: 'Pune',
      lat: 18.5204,
      lng: 73.8567,
    });
    await server.close();
  });

  it('address update is a shallow merge — omitting an existing field drops it (documents the gotcha the route comment warns about)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    // First write establishes city + lat/lng.
    await server.inject({
      method: 'PATCH',
      url: `/venues/${id}/profile`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-profile-address-2a',
        'if-match': '1',
      },
      payload: { public: { address: { city: 'Pune', lat: 18.5204, lng: 73.8567 } } },
    });
    // Second write sends lat/lng only, as a naive caller might.
    const response = await server.inject({
      method: 'PATCH',
      url: `/venues/${id}/profile`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-profile-address-2b',
        'if-match': '2',
      },
      payload: { public: { address: { lat: 19, lng: 74 } } },
    });
    expect(response.statusCode).toBe(200);
    // `city` is gone — this is the exact shallow-merge behavior the fix's
    // own code comment warns callers about, not a bug in this route.
    expect(response.json().public.address).toEqual({ lat: 19, lng: 74 });
    await server.close();
  });

  it('returns the calendar slots for a window', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/calendar?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    await server.close();
  });

  it('creates a blocked calendar slot and returns it from the calendar', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Private event',
        startTime: '2026-09-17T19:00:00.000Z',
        endTime: '2026-09-17T23:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      venueId: id,
      label: 'Private event',
      recurring: false,
      status: 'blocked',
    });

    const calendar = await server.inject({
      method: 'GET',
      url: `/venues/${id}/calendar?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
      headers: READ_HEADERS,
    });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toContainEqual(
      expect.objectContaining({ id: response.json().id, status: 'blocked' }),
    );
    await server.close();
  });

  it('unblocks a blocked calendar slot so the date reads open again', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Private event',
        startTime: '2026-09-17T19:00:00.000Z',
        endTime: '2026-09-17T23:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);
    const blockId = created.json().id as string;

    const unblocked = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/${blockId}`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json()).toMatchObject({ id: blockId, status: 'cancelled' });

    // Cancelled tombstones stay out of the calendar read …
    const calendar = await server.inject({
      method: 'GET',
      url: `/venues/${id}/calendar?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
      headers: READ_HEADERS,
    });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toEqual([]);

    // … and re-unblocking is safe both as an idempotency replay and as a
    // fresh retry after a client lost the original response.
    const again = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/${blockId}`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(unblocked.json());

    const replay = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/${blockId}`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'calendar-unblock-replay' },
    });
    const replayed = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/${blockId}`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'calendar-unblock-replay' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(replay.json());
    await server.close();
  });

  it('rejects a block that overlaps an existing slot but allows adjacent ones', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const seed = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Evening hold',
        startTime: '2026-09-17T19:00:00.000Z',
        endTime: '2026-09-17T23:00:00.000Z',
      },
    });
    expect(seed.statusCode).toBe(201);

    const overlapping = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Overlapping hold',
        startTime: '2026-09-17T22:00:00.000Z',
        endTime: '2026-09-17T23:30:00.000Z',
      },
    });
    expect(overlapping.statusCode).toBe(400);

    // Touching exactly at the boundary is adjacent, not overlapping.
    const adjacent = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Late hold',
        startTime: '2026-09-17T23:00:00.000Z',
        endTime: '2026-09-17T23:30:00.000Z',
      },
    });
    expect(adjacent.statusCode).toBe(201);
    await server.close();
  });

  it('supports overnight blocks that run past midnight', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Overnight hold',
        startTime: '2026-09-17T22:00:00.000Z',
        endTime: '2026-09-18T02:00:00.000Z',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: 'blocked' });

    // A next-morning block inside the overnight range is an overlap.
    const clash = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Morning clash',
        startTime: '2026-09-18T01:00:00.000Z',
        endTime: '2026-09-18T03:00:00.000Z',
      },
    });
    expect(clash.statusCode).toBe(400);
    await server.close();
  });

  it('two concurrent blocks for the same minutes — exactly one wins (TOCTOU closed)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const payload = {
      label: 'Race hold',
      startTime: '2026-09-20T19:00:00.000Z',
      endTime: '2026-09-20T23:00:00.000Z',
    };

    // Fired together: both pass the venue-ownership read before either writes.
    const [first, second] = await Promise.all([
      server.inject({
        method: 'POST',
        url: `/venues/${id}/calendar/blocks`,
        headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
        payload,
      }),
      server.inject({
        method: 'POST',
        url: `/venues/${id}/calendar/blocks`,
        headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
        payload,
      }),
    ]);

    // The overlap guard and the insert share one storage transaction
    // (`createBlockIfFree`), so the loser sees the winner's slot and gets a
    // 400 instead of both landing.
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 400]);
    await server.close();
  });

  it('returns 404 when unblocking an unknown block or a foreign venue', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);

    const missing = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/block_missing`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await server.inject({
      method: 'DELETE',
      url: '/venues/venue_foreign/calendar/blocks/block_missing',
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(foreign.statusCode).toBe(404);
    await server.close();
  });

  it('gets the (empty) public menu', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/menu`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sections: [], updatedAt: null });
    await server.close();
  });

  it('replaces the menu wholesale via PUT /menu', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PUT',
      url: `/venues/${id}/menu`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': 'idem-venue-menu-1',
        'if-match': '1',
      },
      payload: {
        sections: [
          {
            name: 'Starters',
            items: [{ name: 'Truffle Fries', pricePaise: 39900, tags: ['veg'] }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]).toMatchObject({ name: 'Starters' });
    expect(typeof body.updatedAt).toBe('string');
    await server.close();
  });

  it('rejects a menu item with a negative price at the validation layer', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'PUT',
      url: `/venues/${id}/menu`,
      headers: {
        'x-organization-id': ORG,
        'idempotency-key': nextVenueKey(),
        'if-match': '1',
      },
      payload: {
        sections: [
          {
            name: 'Starters',
            items: [{ name: 'Free Vibes', pricePaise: -100, tags: [] }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'validation', status: 422 });
    await server.close();
  });

  it('returns derived availability for a window', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/availability?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      venueId: id,
      openSlots: 0,
      bookedSlots: 0,
      blockedSlots: 0,
      openMinutes: 0,
      fullyBooked: false,
    });
    await server.close();
  });

  it('publishes an idempotent, typed open availability slot', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const headers = { ...READ_HEADERS, 'idempotency-key': 'idem-publish-availability-m3' };
    const payload = {
      label: 'M3-HOST-E2E window',
      startTime: '2030-11-04T12:30:00.000Z',
      endTime: '2030-11-04T16:30:00.000Z',
      timezone: 'Asia/Kolkata',
      notes: 'M3 test availability',
      visibleToHostIds: null,
    };
    const first = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/availability`,
      headers,
      payload,
    });
    const replay = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/availability`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      status: 'open',
      timezone: 'Asia/Kolkata',
      notes: 'M3 test availability',
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    await server.close();
  });

  it('lets an active host partner read derived availability but not the raw calendar', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const blocked = await server.inject({
      method: 'POST',
      url: `/venues/${id}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Confidential maintenance',
        startTime: '2026-09-17T19:00:00.000Z',
        endTime: '2026-09-17T23:00:00.000Z',
      },
    });
    expect(blocked.statusCode).toBe(201);
    const hostOrganizationId = `org_host_calendar_${String(venueSeq)}`;
    await activateHostPartnership(server, id, hostOrganizationId);
    const query = 'from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z';

    const availability = await server.inject({
      method: 'GET',
      url: `/venues/${id}/availability?${query}`,
      headers: { 'x-organization-id': hostOrganizationId },
    });
    const calendar = await server.inject({
      method: 'GET',
      url: `/venues/${id}/calendar?${query}`,
      headers: { 'x-organization-id': hostOrganizationId },
    });

    expect(availability.statusCode).toBe(200);
    expect(availability.json()).toMatchObject({ venueId: id });
    expect(availability.json().slots).toContainEqual(
      expect.objectContaining({ id: blocked.json().id, label: 'Unavailable', status: 'blocked' }),
    );
    expect(calendar.statusCode).toBe(404);
    await server.close();
  });
});

describe('V2 partners venues slice — slot requests', () => {
  it('creates a request only for an open slot through the Host organization', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    expect(fixture.request).toMatchObject({
      venueId: fixture.venueId,
      slotId: fixture.slot.id,
      hostId: fixture.hostOrganizationId,
      status: 'pending',
    });
    expect(typeof fixture.request.id).toBe('string');
    await server.close();
  });

  it('rejects a new slot request that omits the required published slot', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: { message: 'M3 request without a slot' },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('rejects an ineligible Promoter when the Host submits a Venue request', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const nextSlot = await server.inject({
      method: 'POST',
      url: `/venues/${fixture.venueId}/calendar/availability`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Promoter submission validation',
        startTime: '2030-11-05T12:30:00.000Z',
        endTime: '2030-11-05T16:30:00.000Z',
        timezone: 'Asia/Kolkata',
        visibleToHostIds: [fixture.hostOrganizationId],
      },
    });
    expect(nextSlot.statusCode).toBe(201);

    const response = await server.inject({
      method: 'POST',
      url: `/venues/${fixture.venueId}/slot-requests`,
      headers: {
        'x-organization-id': fixture.hostOrganizationId,
        'idempotency-key': nextVenueKey(),
      },
      payload: {
        slotId: nextSlot.json().id,
        eventDraft: {
          event: {
            venueId: fixture.venueId,
            title: 'Ineligible Promoter submission',
            startAt: '2030-11-05T12:30:00.000Z',
            endAt: '2030-11-05T16:30:00.000Z',
          },
          tiers: [],
          promotions: [],
          promoters: [{ promoterId: 'unconnected-promoter' }],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('not currently eligible for this Host');

    const outgoing = await server.inject({
      method: 'GET',
      url: `/organizations/${fixture.hostOrganizationId}/slot-requests?limit=10`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(outgoing.statusCode).toBe(200);
    expect(outgoing.json().items).toHaveLength(1);
    await server.close();
  });

  it('lists slot requests owned by the venue org', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${fixture.venueId}/slot-requests?limit=10`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(fixture.request.id);
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    await server.close();
  });

  it('accepts a slot request as the venue org', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: fixture.request.id, status: 'accepted' });
    await server.close();
  });

  it('publishes the complete Host proposal after Venue approval and safely replays approval', async () => {
    const server = await buildSlotRequestServer();
    const startAt = '2030-11-04T12:30:00.000Z';
    const endAt = '2030-11-04T16:30:00.000Z';
    const fixture = await createHostSlotRequestFixture(server, false, (venueId) => ({
      event: {
        venueId,
        title: 'Approved Host proposal',
        summary: 'A public summary for the event.',
        description: 'A complete guest-facing description for the event.',
        startAt,
        endAt,
        tags: ['Afrobeats'],
      },
      tiers: [
        {
          localId: 'host-tier-general',
          command: {
            name: 'General Admission',
            quantity: 100,
            priceInPaise: 10000,
            accessType: 'ENTRY',
            audienceType: 'GENERAL',
          },
        },
      ],
      promotions: [],
      promoters: [],
    }));
    expect(fixture.request.status).toBe('pending');
    const accepted = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted' });
    const eventId = String(accepted.json().eventId);
    const published = await server.inject({
      method: 'GET',
      url: `/events/${eventId}`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ id: eventId, status: 'published' });
    const replay = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().eventId).toBe(eventId);
    await server.close();
  });

  it('keeps Venue approval pending when a proposed Promoter is no longer eligible', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    // Simulate a legacy/stale request that was created before submission began
    // enforcing the canonical Promoter eligibility rule.
    await services.repos().slotRequests.save({
      ...fixture.request,
      eventId: 'stale-event-with-ineligible-promoter',
      version: Number(fixture.request.version) + 1,
      eventDraft: {
        event: {
          venueId: fixture.venueId,
          title: 'Promoter eligibility approval test',
          startAt: '2030-11-04T12:30:00.000Z',
          endAt: '2030-11-04T16:30:00.000Z',
        },
        tiers: [],
        promotions: [],
        promoters: [{ promoterId: 'missing-promoter-org' }],
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('no longer eligible for this Host'),
    });
    expect(response.json().message).not.toContain('missing-promoter-org');

    const outgoing = await server.inject({
      method: 'GET',
      url: `/organizations/${fixture.hostOrganizationId}/slot-requests?limit=10`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(outgoing.statusCode).toBe(200);
    expect(outgoing.json().items).toContainEqual(
      expect.objectContaining({
        id: fixture.request.id,
        status: 'pending',
        eventId: 'stale-event-with-ineligible-promoter',
      }),
    );
    const event = await server.inject({
      method: 'GET',
      url: `/events/${fixture.request.eventId}`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(event.statusCode).toBe(404);
    await server.close();
  });

  it('does not overwrite a ticket tier owned by another event during approval', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server, false, (venueId) => ({
      event: {
        venueId,
        title: 'Collision proposal',
        startAt: '2030-11-04T12:30:00.000Z',
        endAt: '2030-11-04T16:30:00.000Z',
      },
      tiers: [
        {
          localId: 'shared-tier-id',
          command: {
            name: 'Proposed',
            quantity: 5,
            priceInPaise: 5000,
            accessType: 'ENTRY',
            audienceType: 'GENERAL',
          },
        },
      ],
      promotions: [],
      promoters: [],
    }));
    const services = createV2Services();
    const foreignEvent = await services.events.create(
      { userId: 'venue_owner_test', organizationId: ORG, role: 'owner', capabilities: ['venue'] },
      {
        venueId: fixture.request.venueId,
        title: 'Unrelated existing event',
        startAt: '2030-12-01T12:00:00.000Z',
      },
    );
    const foreignTier = await services.catalog.createTier(
      { userId: 'venue_owner_test', organizationId: ORG, role: 'owner', capabilities: ['venue'] },
      {
        id: 'shared-tier-id',
        eventId: foreignEvent.id,
        name: 'Keep this tier',
        quantity: 42,
        priceInPaise: 9000,
      },
    );
    const accepted = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(accepted.statusCode).toBe(400);
    expect(
      await services.catalog.listTiers(
        { userId: 'venue_owner_test', organizationId: ORG, role: 'owner', capabilities: ['venue'] },
        foreignEvent.id,
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: 'shared-tier-id',
        eventId: foreignEvent.id,
        name: foreignTier.name,
        quantity: 42,
      }),
    );
    await server.close();
  });

  it('rejects a slot request as the venue org', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/reject`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: fixture.request.id, status: 'rejected' });
    await server.close();
  });

  it('returns 400 when a slot request is accepted twice', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const first = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });

  it('lists the host organization’s outgoing slot requests', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${fixture.hostOrganizationId}/slot-requests?limit=10`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(fixture.request.id);
    expect(body.items).toContainEqual(
      expect.objectContaining({ hostId: fixture.hostOrganizationId, status: 'pending' }),
    );
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    await server.close();
  });

  it('forbids listing another tenant’s outgoing slot requests', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/org_999/slot-requests?limit=10`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });

  it('returns the request + linked event + venue for a venue-owner detail view', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${fixture.venueId}/slot-requests/${fixture.request.id}`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.request).toMatchObject({
      id: fixture.request.id,
      venueId: fixture.venueId,
      hostId: fixture.hostOrganizationId,
      slotId: fixture.slot.id,
      eventId: null,
      status: 'pending',
    });
    expect(body.event).toBeNull();
    expect(body.venue).toEqual({ id: fixture.venueId, name: 'Aurora Hall' });
    // The memory test driver has no Organization record for the fixed dev
    // actor, so the (nullable) host resolves to null here; on Firestore the
    // requesting org exists and this is `{ id, name }`.
    expect(body.host).toBeNull();
    await server.close();
  });

  it('returns 404 for a detail view that is not under the venue', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const other = await createVenue(server);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${other.id}/slot-requests/${fixture.request.id}`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it('lets the host org cancel its own accepted request (domain: accepted → cancelled)', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const accepted = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(accepted.statusCode).toBe(200);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/cancel`,
      headers: {
        'x-organization-id': fixture.hostOrganizationId,
        'idempotency-key': nextVenueKey(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: fixture.request.id, status: 'cancelled' });
    await server.close();
  });

  it('rejects the API cancellation command for a booking linked to a published event', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server, true);
    expect(fixture.request.eventId).toBeTruthy();
    expect(fixture.request.status).toBe('accepted');

    const cancellation = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/cancel`,
      headers: {
        'x-organization-id': fixture.hostOrganizationId,
        'idempotency-key': nextVenueKey(),
      },
    });
    expect(cancellation.statusCode).toBe(400);
    expect(cancellation.json()).toMatchObject({ code: 'validation' });

    const outgoing = await server.inject({
      method: 'GET',
      url: `/organizations/${fixture.hostOrganizationId}/slot-requests?limit=10`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(outgoing.statusCode).toBe(200);
    expect(outgoing.json().items).toContainEqual(
      expect.objectContaining({
        id: fixture.request.id,
        eventId: fixture.request.eventId,
        status: 'accepted',
      }),
    );
    await server.close();
  });

  it('rejects a cancel of a still-pending request (state machine: pending → cancelled is not legal)', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/cancel`,
      headers: {
        'x-organization-id': fixture.hostOrganizationId,
        'idempotency-key': nextVenueKey(),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict' });
    await server.close();
  });

  it('returns 404 when a non-host org tries to cancel someone else’s request', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${fixture.request.id}/cancel`,
      headers: { 'x-organization-id': 'org_other_host', 'idempotency-key': nextVenueKey() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });
});

describe('Host requests for automatically available time', () => {
  it('accepts an unpublished interval, replays it safely, and rejects an overlap', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const key = nextVenueKey();
    const options = {
      method: 'POST' as const,
      url: `/venues/${fixture.venueId}/slot-requests`,
      headers: { 'x-organization-id': fixture.hostOrganizationId, 'idempotency-key': key },
      payload: { startTime: '2031-04-12T13:30:00.000Z', endTime: '2031-04-12T17:30:00.000Z' },
    };
    const created = await server.inject(options);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'pending',
      slotStartTime: options.payload.startTime,
      slotEndTime: options.payload.endTime,
    });
    const replay = await server.inject(options);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(created.json().id);
    const overlap = await server.inject({
      ...options,
      headers: { ...options.headers, 'idempotency-key': nextVenueKey() },
      payload: { startTime: '2031-04-12T14:30:00.000Z', endTime: '2031-04-12T18:30:00.000Z' },
    });
    expect(overlap.statusCode).toBe(400);
    const adjacent = await server.inject({
      ...options,
      headers: { ...options.headers, 'idempotency-key': nextVenueKey() },
      payload: { startTime: '2031-04-12T17:30:00.000Z', endTime: '2031-04-12T18:30:00.000Z' },
    });
    expect(adjacent.statusCode).toBe(201);
    await server.close();
  });
  it('rejects intervals at a Venue without an active partnership', async () => {
    const server = await buildSlotRequestServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { 'x-organization-id': 'unpartnered-host', 'idempotency-key': nextVenueKey() },
      payload: { startTime: '2031-05-01T13:30:00.000Z', endTime: '2031-05-01T17:30:00.000Z' },
    });
    expect(response.statusCode).toBe(400);
    await server.close();
  });
});

describe('Automatic interval conflict protection', () => {
  it('allows only one concurrent request and rejects blocked times', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const request = () =>
      server.inject({
        method: 'POST',
        url: `/venues/${fixture.venueId}/slot-requests`,
        headers: {
          'x-organization-id': fixture.hostOrganizationId,
          'idempotency-key': nextVenueKey(),
        },
        payload: { startTime: '2032-04-12T13:30:00.000Z', endTime: '2032-04-12T17:30:00.000Z' },
      });
    const results = await Promise.all([request(), request()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    const block = await server.inject({
      method: 'POST',
      url: `/venues/${fixture.venueId}/calendar/blocks`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
      payload: {
        label: 'Closed',
        startTime: '2032-05-12T13:30:00.000Z',
        endTime: '2032-05-12T17:30:00.000Z',
      },
    });
    expect(block.statusCode).toBe(201);
    const blocked = await server.inject({
      method: 'POST',
      url: `/venues/${fixture.venueId}/slot-requests`,
      headers: {
        'x-organization-id': fixture.hostOrganizationId,
        'idempotency-key': nextVenueKey(),
      },
      payload: { startTime: '2032-05-12T14:30:00.000Z', endTime: '2032-05-12T16:30:00.000Z' },
    });
    expect(blocked.statusCode).toBe(400);
    await server.close();
  });
});

describe('Overnight automatic availability', () => {
  it('persists an IST overnight interval and rejects a conflict after midnight', async () => {
    const server = await buildSlotRequestServer();
    const fixture = await createHostSlotRequestFixture(server);
    const makeRequest = (startTime: string, endTime: string) =>
      server.inject({
        method: 'POST',
        url: `/venues/${fixture.venueId}/slot-requests`,
        headers: {
          'x-organization-id': fixture.hostOrganizationId,
          'idempotency-key': nextVenueKey(),
        },
        payload: { startTime, endTime },
      });
    const overnight = await makeRequest('2033-04-12T17:30:00.000Z', '2033-04-12T20:30:00.000Z');
    expect(overnight.statusCode).toBe(201);
    expect(overnight.json()).toMatchObject({
      slotStartTime: '2033-04-12T17:30:00.000Z',
      slotEndTime: '2033-04-12T20:30:00.000Z',
      timezone: 'Asia/Kolkata',
    });
    const overlap = await makeRequest('2033-04-12T19:30:00.000Z', '2033-04-12T21:30:00.000Z');
    expect(overlap.statusCode).toBe(400);
    const nextDay = await server.inject({
      method: 'GET',
      url: `/venues/${fixture.venueId}/availability?from=2033-04-12T18:30:00.000Z&to=2033-04-13T18:29:59.999Z`,
      headers: { 'x-organization-id': fixture.hostOrganizationId },
    });
    expect(nextDay.statusCode).toBe(200);
    expect(nextDay.json().slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startTime: '2033-04-12T17:30:00.000Z',
          endTime: '2033-04-12T20:30:00.000Z',
          status: 'pending',
        }),
      ]),
    );
    await server.close();
  });
});

describe('M3 Venue cancellation of an accepted live booking', () => {
  it('requires Venue ownership and a reason, freezes the event with a Venue initiator, and replays once', async () => {
    const server = await buildSlotRequestServer();
    try {
      const fixture = await createHostSlotRequestFixture(server, true);
      const url = `/venues/slot-requests/${fixture.request.id}/cancel-by-venue`;
      const blank = await server.inject({
        method: 'POST',
        url,
        headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
        payload: { reason: '' },
      });
      expect(blank.statusCode).toBe(422);
      const foreign = await server.inject({
        method: 'POST',
        url,
        headers: {
          'x-organization-id': fixture.hostOrganizationId,
          'idempotency-key': nextVenueKey(),
        },
        payload: { reason: 'Host cannot impersonate Venue' },
      });
      expect(foreign.statusCode).toBe(404);
      const headers = { ...READ_HEADERS, 'idempotency-key': nextVenueKey() };
      const payload = { reason: 'Venue temporarily closed for safety' };
      const cancelled = await server.inject({ method: 'POST', url, headers, payload });
      const replay = await server.inject({ method: 'POST', url, headers, payload });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json()).toMatchObject({ id: fixture.request.id, status: 'cancelled' });
      expect(replay.json()).toEqual(cancelled.json());
      const event = await server.inject({
        method: 'GET',
        url: `/events/${fixture.request.eventId}`,
        headers: { 'x-organization-id': fixture.hostOrganizationId },
      });
      expect(event.statusCode, event.body).toBe(200);
      expect(event.json()).toMatchObject({
        status: 'postponed',
        isPublic: false,
        postponement: { initiatedBy: 'venue', organizationId: ORG, reason: payload.reason },
      });
      const changed = await server.inject({
        method: 'POST',
        url,
        headers,
        payload: { reason: 'Changed replay intent' },
      });
      expect(changed.statusCode).toBe(409);
      const unchanged = await server.inject({
        method: 'GET',
        url: `/events/${fixture.request.eventId}`,
        headers: { 'x-organization-id': fixture.hostOrganizationId },
      });
      expect(unchanged.json().version).toBe(event.json().version);
    } finally {
      await server.close();
    }
  });
});
