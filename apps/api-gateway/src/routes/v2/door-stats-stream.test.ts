import { beforeEach, describe, expect, it } from 'vitest';

import type { ActorContext } from '@c1rcle/core/application';

import { createStreamLimiter } from '../../lib/stream-limiter.js';
import { createV2Services } from '../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../test-utils/partner-test-server.js';

import phase5Routes from './phase5-routes.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Live door stats ────────────────────────────────────────────────────────
 *
 * The streaming endpoint's risks are not the ones a normal route has. Rate
 * limiting bounds requests, but a stream is bounded by *connections*, and a
 * long-lived one can outlive the authority that opened it. These tests pin
 * the controls that answer both.
 */

const services = createV2Services();

const ORG_ID = 'org_stream_1';
const OTHER_ORG_ID = 'org_stream_2';
const EVENT_ID = 'evt_stream_1';
const OTHER_EVENT_ID = 'evt_stream_2';

const SEED_ACTOR: ActorContext = {
  userId: 'staff_stream_1',
  organizationId: ORG_ID,
  role: 'owner',
  capabilities: [],
};
const HEADERS = { 'x-organization-id': ORG_ID };

let server: FastifyInstance;
let currentActor: ActorContext;

beforeEach(async () => {
  currentActor = SEED_ACTOR;
  server = await buildPartnerTestServer({ routes: [phase5Routes] });
  server.addHook('onRequest', async (request) => {
    request.actor = { ...currentActor, platformRole: 'staff' };
  });
  await seedEvent(EVENT_ID, ORG_ID);
  await seedEvent(OTHER_EVENT_ID, OTHER_ORG_ID);
});

async function seedEvent(eventId: string, organizationId: string): Promise<void> {
  if (await services.repos().events.findById(eventId)) return;
  const now = new Date().toISOString();
  await services.repos().events.save({
    id: eventId,
    organizationId,
    venueId: null,
    slug: `stream-${eventId}`,
    title: 'Stream Test Event',
    summary: '',
    description: '',
    imageUrl: null,
    startAt: now,
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: null,
    isFree: false,
    cancellationReason: null,
    capacity: 500,
    adminOverride: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe('GET /door/stats/stream', () => {
  it('opens an event-stream and sends the current numbers first', async () => {
    // `inject` resolves only when a response ends, and a stream never does —
    // so this one needs a real socket. Listening on an ephemeral port also
    // exercises the hijacked-reply path the way a client actually hits it.
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.addresses()[0];
    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(address?.port)}/door/stats/stream?eventId=${EVENT_ID}`,
        { headers: HEADERS, signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      // A live occupancy figure must never be cached anywhere.
      expect(response.headers.get('cache-control')).toContain('no-store');
      // Tells nginx not to sit on the first frames.
      expect(response.headers.get('x-accel-buffering')).toBe('no');

      const reader = response.body?.getReader();
      const first = await reader?.read();
      const frame = new TextDecoder().decode(first?.value);
      expect(frame).toContain('event: stats');
      expect(frame).toContain('"occupancy"');
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it('releases its connection slot when the client goes away', async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.addresses()[0];
    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(address?.port)}/door/stats/stream?eventId=${EVENT_ID}`,
        { headers: HEADERS, signal: controller.signal },
      );
      await response.body?.getReader().read();
      controller.abort();
      // A stream that does not free its slot on disconnect walks the budget
      // down until the endpoint refuses everyone — the classic leak.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const second = await fetch(
        `http://127.0.0.1:${String(address?.port)}/door/stats?eventId=${EVENT_ID}`,
        { headers: HEADERS },
      );
      expect(second.status).toBe(200);
    } finally {
      controller.abort();
      await server.close();
    }
  });

  it('refuses another organization’s event BEFORE opening a stream', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/door/stats/stream?eventId=${OTHER_EVENT_ID}`,
      headers: HEADERS,
    });
    // An ordinary error envelope, not an opened stream that then errors in a
    // format the client is not yet parsing.
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json().code).toBe('not_found');
  });

  it('rejects an unknown event', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/stats/stream?eventId=evt_nope',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed query rather than streaming anything', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/door/stats/stream?eventId=has%20spaces',
      headers: HEADERS,
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('stream connection budget', () => {
  it('hands out slots up to the per-actor cap, then refuses', () => {
    const limiter = createStreamLimiter({ maxPerActor: 2, maxGlobal: 10 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).not.toBeNull();
    // Connection count is the DoS vector a rate limiter cannot see: each open
    // is one request, so the limiter never fires while sockets pile up.
    expect(limiter.acquire('a')).toBeNull();
    // A different actor is unaffected — one bad device must not crowd out a
    // whole venue.
    expect(limiter.acquire('b')).not.toBeNull();
  });

  it('enforces a global ceiling that a per-actor cap alone cannot', () => {
    const limiter = createStreamLimiter({ maxPerActor: 5, maxGlobal: 2 });
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('b')).not.toBeNull();
    expect(limiter.acquire('c')).toBeNull();
  });

  it('returns capacity when a stream closes', () => {
    const limiter = createStreamLimiter({ maxPerActor: 1, maxGlobal: 4 });
    const slot = limiter.acquire('a');
    expect(limiter.acquire('a')).toBeNull();
    slot?.release();
    expect(limiter.size()).toBe(0);
    expect(limiter.acquire('a')).not.toBeNull();
  });

  it('does not leak capacity when release is called twice', () => {
    // Both a close handler and an error path can fire for one socket.
    // Double-counting would walk the budget down until nobody could connect.
    const limiter = createStreamLimiter({ maxPerActor: 2, maxGlobal: 2 });
    const slot = limiter.acquire('a');
    slot?.release();
    slot?.release();
    expect(limiter.size()).toBe(0);
    expect(limiter.acquire('a')).not.toBeNull();
    expect(limiter.acquire('a')).not.toBeNull();
  });
});
