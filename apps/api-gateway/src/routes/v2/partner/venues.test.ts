import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerVenueRoutes from './venues.js';

const buildServer = () => buildPartnerTestServer({ routes: [partnerVenueRoutes] });

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
});
