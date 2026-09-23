import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';
import partnerPartnershipRoutes from './partnerships.js';
import partnerVenueRoutes from './venues.js';

const buildServer = () =>
  buildPartnerTestServer({ routes: [partnerVenueRoutes, partnerPartnershipRoutes] });

// The venue-detail test needs an event on the *host* org; the test server
// registers the event routes too (services + repositories are memoized per
// file, so both servers share state).
const buildServerWithEvents = () =>
  buildPartnerTestServer({ routes: [partnerVenueRoutes, partnerEventRoutes] });

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

    // … and re-unblocking the same slot is a 400, not a silent no-op.
    const again = await server.inject({
      method: 'DELETE',
      url: `/venues/${id}/calendar/blocks/${blockId}`,
      headers: { ...READ_HEADERS, 'idempotency-key': nextVenueKey() },
    });
    expect(again.statusCode).toBe(400);
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
  it('creates a slot request for a venue', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-slot-req-1' },
      payload: { message: 'Looking for a Friday night slot' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      venueId: id,
      hostId: ORG,
      status: 'pending',
    });
    expect(typeof response.json().id).toBe('string');
    await server.close();
  });

  it('lists slot requests owned by the venue org', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-slot-req-list' },
      payload: { message: 'Second slot please' },
    });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/slot-requests?limit=10`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(created.json().id);
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    await server.close();
  });

  it('accepts a slot request as the venue org', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-accept-create' },
      payload: {},
    });
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-accept' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.json().id, status: 'accepted' });
    await server.close();
  });

  it('rejects a slot request as the venue org', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-reject-create' },
      payload: {},
    });
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/reject`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-reject' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.json().id, status: 'rejected' });
    await server.close();
  });

  it('returns 400 when a slot request is accepted twice', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-accept-2-create' },
      payload: {},
    });
    const first = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-accept-2' },
    });
    expect(first.statusCode).toBe(200);
    const second = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-venue-accept-2b' },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: 'validation', status: 400 });
    await server.close();
  });

  it('lists the host organization’s outgoing slot requests', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-out-list-create' },
      payload: { message: 'Host-side list please' },
    });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({
      method: 'GET',
      url: `/organizations/${ORG}/slot-requests?limit=10`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toContain(created.json().id);
    expect(body.items).toContainEqual(expect.objectContaining({ hostId: ORG, status: 'pending' }));
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
    const server = await buildServerWithEvents();
    const { id } = await createVenue(server);
    const event = await server.inject({
      method: 'POST',
      url: `/organizations/${ORG}/events`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-out-detail-event' },
      payload: {
        venueId: id,
        title: 'Bass Drop Night',
        startAt: '2026-10-01T19:30:00.000Z',
        endAt: '2026-10-01T23:00:00.000Z',
      },
    });
    expect(event.statusCode).toBe(201);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-out-detail-create' },
      payload: { eventId: event.json().id, message: 'Review this one' },
    });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/slot-requests/${created.json().id}`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.request).toMatchObject({
      id: created.json().id,
      venueId: id,
      hostId: ORG,
      eventId: event.json().id,
      status: 'pending',
    });
    expect(body.event).toMatchObject({ id: event.json().id, title: 'Bass Drop Night' });
    expect(body.venue).toEqual({ id, name: 'Aurora Hall' });
    // The memory test driver has no Organization record for the fixed dev
    // actor, so the (nullable) host resolves to null here; on Firestore the
    // requesting org exists and this is `{ id, name }`.
    expect(body.host).toBeNull();
    await server.close();
  });

  it('returns 404 for a detail view that is not under the venue', async () => {
    const server = await buildServerWithEvents();
    const { id } = await createVenue(server);
    const other = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${other.id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-out-detail-404-create' },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({
      method: 'GET',
      url: `/venues/${id}/slot-requests/${created.json().id}`,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });

  it('lets the host org cancel its own accepted request (domain: accepted → cancelled)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel-create' },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const accepted = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/accept`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel-accept' },
    });
    expect(accepted.statusCode).toBe(200);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/cancel`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.json().id, status: 'cancelled' });
    await server.close();
  });

  it('rejects a cancel of a still-pending request (state machine: pending → cancelled is not legal)', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel-pending-create' },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/cancel`,
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel-pending' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'conflict' });
    await server.close();
  });

  it('returns 404 when a non-host org tries to cancel someone else’s request', async () => {
    const server = await buildServer();
    const { id } = await createVenue(server);
    // Sent by a *different* host org — cross-org create is by design.
    const created = await server.inject({
      method: 'POST',
      url: `/venues/${id}/slot-requests`,
      headers: {
        'x-organization-id': 'org_2',
        'idempotency-key': 'idem-host-cancel-xtenant-create',
      },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ hostId: 'org_2' });
    const response = await server.inject({
      method: 'POST',
      url: `/venues/slot-requests/${created.json().id}/cancel`,
      // Venue-owner org (org_1) is not the requester — service 404s it the
      // same way it hides cross-tenant accept/reject targets.
      headers: { ...READ_HEADERS, 'idempotency-key': 'idem-host-cancel-xtenant' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    await server.close();
  });
});
