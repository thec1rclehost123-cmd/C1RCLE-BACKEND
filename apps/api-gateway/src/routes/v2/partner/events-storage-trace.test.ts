import { describe, expect, it } from 'vitest';

import type { MemoryEventRepository } from '@c1rcle/core/infrastructure';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import partnerEventRoutes from './events.js';

/**
 * ─── Event-create storage trace ────────────────────────────────────────────
 * Answers two questions end-to-end:
 *   1. WHAT is passed to the backend when a partner creates an event (the
 *      exact payload the frontend's `venue-event-repository.ts` sends under
 *      `createEventSchema`)?
 *   2. WHERE/HOW is it stored (the raw entity in the repository — memory
 *      driver here, which is what `pnpm test` uses)?
 *
 * The frontend contract is the authority (AGENTS.md): the wire payload must
 * round-trip through `createEventSchema` → route validation → `EventService`
 * → repository with no field lost or invented. This test pins that pipe.
 */

const buildServer = () => buildPartnerTestServer({ routes: [partnerEventRoutes] });

// The services (and their idempotency store) are memoized per test file, so
// every test needs a unique idempotency-key — reusing one replays a previous
// test's result instead of creating a fresh event.
let seq = 0;
function nextKey() {
  seq += 1;
  return `idem-trace-${seq}`;
}

/** Exactly what the frontend @c1rcle/api-client sends (venue-event-repository.ts). */
function frontendPayload(overrides: Record<string, unknown> = {}) {
  return {
    venueId: 'ven_1',
    title: 'Event by eclipse',
    imageUrl: 'https://cdn.example.com/artwork/eclipse.jpg',
    startAt: '2026-09-18T21:00:00.000Z',
    endAt: null,
    tags: ['House', 'Club Night', 'Karan Aujla'],
    ...overrides,
  };
}

async function createViaRoute(payload: Record<string, unknown>) {
  const server = await buildServer();
  const response = await server.inject({
    method: 'POST',
    url: '/organizations/org_1/events',
    headers: {
      'x-organization-id': 'org_1',
      'idempotency-key': nextKey(),
    },
    payload,
  });
  return { server, response };
}

describe('event creation — what is passed vs what is stored', () => {
  it('stores the exact same fields the route receives (full frontend payload)', async () => {
    const services = createV2Services();
    const { server, response } = await createViaRoute(frontendPayload());

    expect(response.statusCode).toBe(201);
    const dto = response.json();
    const id = dto.id as string;

    // WHAT the route actually validated against `createEventBody` — the
    // request body as typed by the backend (events.ts:164-186).
    console.log('── REQUEST BODY RECEIVED BY BACKEND (POST /organizations/:org/events) ──');
    console.log(JSON.stringify(frontendPayload(), null, 2));
    console.log('  + headers: x-organization-id: org_1, idempotency-key: <generated>');

    // WHAT the repository actually persisted — the raw entity in the memory
    // driver's backing `Map` (MemoryEventRepository.events).
    const repo = services.repos().events as MemoryEventRepository;
    const stored = repo.events.get(id);
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe(id);

    console.log('\n── RAW EVENT STORED IN REPOSITORY (MemoryEventRepository.events Map) ──');
    console.log(JSON.stringify(stored, null, 2));

    // 1. Every field the client sent is present, unchanged.
    expect(stored).toMatchObject({
      venueId: 'ven_1',
      title: 'Event by eclipse',
      imageUrl: 'https://cdn.example.com/artwork/eclipse.jpg',
      startAt: '2026-09-18T21:00:00.000Z',
      endAt: null,
      tags: ['House', 'Club Night', 'Karan Aujla'],
    });

    // 2. Server-derived fields mapped onto the aggregate in `createEvent()`
    //    (event.ts:117-138) — mirror exactly the DTO the API returns.
    expect(stored).toMatchObject({
      organizationId: 'org_1',
      slug: 'event-by-eclipse',
      summary: '',
      description: '',
      status: 'draft',
      isPublic: false,
      startingPricePaise: 0,
      isFree: true,
      cancellationReason: null,
      version: 1,
    });

    // 3. The HTTP response is the stored entity serialized (eventToDto) —
    //    nothing added or dropped on the way out.
    expect(dto).toMatchObject({
      id,
      organizationId: 'org_1',
      venueId: 'ven_1',
      slug: 'event-by-eclipse',
      title: 'Event by eclipse',
      summary: '',
      description: '',
      imageUrl: 'https://cdn.example.com/artwork/eclipse.jpg',
      startAt: '2026-09-18T21:00:00.000Z',
      endAt: null,
      tags: ['House', 'Club Night', 'Karan Aujla'],
      status: 'draft',
      isPublic: false,
      startingPricePaise: 0,
      isFree: true,
      cancellationReason: null,
      version: 1,
    });

    await server.close();
  });

  it('defaults optional fields server-side when the client omits them', async () => {
    const services = createV2Services();
    const { server, response } = await createViaRoute({
      venueId: 'ven_2',
      title: 'No extras',
      startAt: '2026-09-20T19:00:00.000Z',
    });

    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    const stored = (services.repos().events as MemoryEventRepository).events.get(id);

    console.log('\n── MINIMAL PAYLOAD → STORED DEFAULTS ──');
    console.log(JSON.stringify(stored, null, 2));

    expect(stored).toMatchObject({
      imageUrl: null,
      endAt: null,
      tags: [],
      summary: '',
      description: '',
    });
    await server.close();
  });
});
