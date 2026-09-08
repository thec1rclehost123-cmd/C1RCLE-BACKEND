import { describe, expect, it } from 'vitest';

import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';

const buildServer = () => buildPartnerTestServer({ routes: [partnerEventRoutes] });

const VALID_HEADERS = { 'x-organization-id': 'org_1' };
const CREATE_HEADERS = { 'x-organization-id': 'org_1', 'idempotency-key': 'idem-event-1' };

const CREATE_BODY = { title: 'Sky Night', venueId: 'ven_1', startAt: '2026-08-01T18:00:00Z' };

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
        startAt: '2026-08-01T18:00:00Z',
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
      headers: CREATE_HEADERS,
      payload: { title: 'Sky Night', venueId: 'ven_1', startAt: '2026-08-01T18:00:00Z' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      title: 'Sky Night',
      organizationId: 'org_1',
      status: 'draft',
      isPublic: false,
      version: 1,
    });
    expect(typeof body.id).toBe('string');
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
    expect(body.pageInfo).toMatchObject({ page: 1, pageSize: 10 });
    expect(body.pageInfo.total).toBeGreaterThanOrEqual(1);
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
      payload: { title: 'Sky Night Reloaded', tags: ['party'], startingPricePaise: 19900 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id,
      title: 'Sky Night Reloaded',
      tags: ['party'],
      startingPricePaise: 19900,
      version: 2,
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

describe('V2 partners events slice — previews and lifecycle', () => {
  it('returns the preview with the public visibility flag for a draft', async () => {
    const server = await buildServer();
    const { id } = await createEvent(server);
    const response = await server.inject({
      method: 'GET',
      url: `/events/${id}/previews`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      event: { id, status: 'draft' },
      isPublic: false,
    });
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
});
