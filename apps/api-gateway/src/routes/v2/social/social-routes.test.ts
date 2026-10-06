import { createEvent, createOrganization, createVenue } from '@c1rcle/core/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import socialRoutes from './social-routes.js';

import type { FastifyInstance } from 'fastify';

const services = createV2Services();
let seq = 0;
let server: FastifyInstance;

async function seedVenue() {
  seq += 1;
  const org = createOrganization({
    id: `org_social_${seq}`,
    name: `Social Org ${seq}`,
    slug: `social-org-${seq}`,
    ownerId: 'host_1',
  });
  await services.repos().organizations.save(org);
  const venue = createVenue({
    id: `venue_social_${seq}`,
    organizationId: org.id,
    ownerId: org.ownerId,
    name: 'Sky Bar',
    slug: `social-sky-bar-${seq}`,
    capacity: 120,
    city: 'Mumbai',
  });
  await services.repos().venues.save(venue);
  return { org, venue };
}

const follow = (userId: string, targetType: string, targetId: string) =>
  server.inject({
    method: 'POST',
    url: '/follows',
    headers: { 'x-user-id': userId },
    payload: { targetType, targetId },
  });

beforeEach(async () => {
  server = await buildPartnerTestServer({ routes: [socialRoutes] });
});
afterEach(async () => {
  await server.close();
});

describe('POST /follows + DELETE /follows/:targetType/:targetId', () => {
  it('creates (201), re-follows idempotently (200), unfollows (204, twice)', async () => {
    const { venue } = await seedVenue();
    const first = await follow('guest_f1', 'venue', venue.id);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ targetType: 'venue', targetId: venue.id });

    const again = await follow('guest_f1', 'venue', venue.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);

    for (let i = 0; i < 2; i += 1) {
      const del = await server.inject({
        method: 'DELETE',
        url: `/follows/venue/${venue.id}`,
        headers: { 'x-user-id': 'guest_f1' },
      });
      expect(del.statusCode).toBe(204);
    }
  });

  it('404s an unknown target and 422s a bad target type', async () => {
    expect((await follow('guest_f2', 'host', 'org_nope')).json()).toMatchObject({
      code: 'not_found',
    });
    expect((await follow('guest_f2', 'user', 'someone')).statusCode).toBe(422);
  });
});

describe('GET /follows/me + /follows/:targetType/:targetId/status', () => {
  it('lists only the caller’s follows, filterable by type, with status counts', async () => {
    const { org, venue } = await seedVenue();
    await follow('guest_l1', 'venue', venue.id);
    await follow('guest_l1', 'host', org.id);
    await follow('guest_l2', 'host', org.id);

    const mine = await server.inject({
      method: 'GET',
      url: '/follows/me?targetType=host',
      headers: { 'x-user-id': 'guest_l1' },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      items: [{ targetType: 'host', targetId: org.id }],
      pageInfo: { total: 1, hasNextPage: false },
      nextCursor: null,
    });

    const status = await server.inject({
      method: 'GET',
      url: `/follows/host/${org.id}/status`,
      headers: { 'x-user-id': 'guest_l3' },
    });
    expect(status.json()).toEqual({ following: false, followerCount: 2 });
  });
});

describe('event.published → notification inbox (pub/sub end to end)', () => {
  it('publishing an event lands one notification per follower; read flows work', async () => {
    const { org, venue } = await seedVenue();
    await follow('guest_n1', 'venue', venue.id);
    await follow('guest_n1', 'host', org.id);
    await follow('guest_n2', 'host', org.id);

    const draft = createEvent({
      id: `evt_social_${seq}`,
      organizationId: org.id,
      venueId: venue.id,
      title: 'Rooftop Night',
      startAt: '2026-12-31T20:00:00.000Z',
    });
    await services.repos().events.save({ ...draft, status: 'review' });
    const host = {
      userId: 'host_1',
      organizationId: org.id,
      role: 'owner',
      capabilities: [],
    } as unknown as ActorContext;
    await services.events.publish(host, draft.id);

    const inbox = await server.inject({
      method: 'GET',
      url: '/notifications/me',
      headers: { 'x-user-id': 'guest_n1' },
    });
    expect(inbox.statusCode).toBe(200);
    const body = inbox.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      type: 'event.new_from_followed',
      title: 'New event: Rooftop Night',
      subjectId: draft.id,
      readAt: null,
    });

    const unread = () =>
      server.inject({
        method: 'GET',
        url: '/notifications/me/unread-count',
        headers: { 'x-user-id': 'guest_n2' },
      });
    expect((await unread()).json()).toEqual({ count: 1 });

    // guest_n2 cannot mark guest_n1's row.
    const foreign = await server.inject({
      method: 'POST',
      url: '/notifications/me/read',
      headers: { 'x-user-id': 'guest_n2' },
      payload: { ids: [body.items[0].id] },
    });
    expect(foreign.json()).toEqual({ updated: 0 });

    const all = await server.inject({
      method: 'POST',
      url: '/notifications/me/read-all',
      headers: { 'x-user-id': 'guest_n2' },
    });
    expect(all.json()).toEqual({ updated: 1 });
    expect((await unread()).json()).toEqual({ count: 0 });

    const own = await server.inject({
      method: 'POST',
      url: '/notifications/me/read',
      headers: { 'x-user-id': 'guest_n1' },
      payload: { ids: [body.items[0].id] },
    });
    expect(own.json()).toEqual({ updated: 1 });
  });

  it('rejects an empty mark-read body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/notifications/me/read',
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(422);
  });
});
