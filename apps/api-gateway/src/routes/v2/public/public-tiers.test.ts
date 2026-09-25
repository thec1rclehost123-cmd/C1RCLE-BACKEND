import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import publicDiscoveryRoutes from './discovery.js';

/**
 * ─── Public event tiers over HTTP ────────────────────────────────────────────
 * `GET /public/events/:idOrSlug/tiers` — the anonymous sell surface checkout
 * needs: active tiers with effective price + live availability. Non-public
 * events 404 exactly like the event-detail read (no existence oracle).
 *
 * Seeds straight through the shared memory repositories (same pattern as
 * `discovery.test.ts`): the public suite never mixes partner routes into its
 * server, since partner `GET /events/:eventId` and public
 * `GET /events/:idOrSlug` share a route shape and Fastify rejects the pair.
 * NOTE: `buildPartnerTestServer` mounts routes at the root (no `/public`
 * prefix — that prefix only exists in the production manifest), so requests
 * go to `/events/:slug/tiers` here, i.e. `/api/v2/public/events/:slug/tiers`
 * in production.
 */

const buildServer = () => buildPartnerTestServer({ routes: [publicDiscoveryRoutes] });

let seq = 0;

async function seedPublishedEventWithTiers(
  tiers: { name: string; priceInPaise: number; quantity: number; status?: string }[] = [
    { name: 'RSVP', priceInPaise: 0, quantity: 50 },
  ],
): Promise<{ eventId: string; slug: string }> {
  seq += 1;
  const services = createV2Services();
  const repos = services.repos();
  const now = new Date();
  const eventId = `evt_tiers_${seq}`;
  const slug = `tiers-night-${seq}`;

  await repos.events.save({
    id: eventId,
    organizationId: `org_tiers_${seq}`,
    venueId: null,
    slug,
    title: `Tiers Night ${seq}`,
    summary: '',
    description: '',
    imageUrl: null,
    startAt: '2026-09-01T18:00:00.000Z',
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: [],
    startingPricePaise: 0,
    isFree: true,
    cancellationReason: null,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  let tierSeq = 0;
  for (const tier of tiers) {
    tierSeq += 1;
    await repos.catalog.saveTier({
      id: `tier_t_${seq}_${tierSeq}`,
      eventId,
      organizationId: `org_tiers_${seq}`,
      name: tier.name,
      description: '',
      entryType: 'general',
      currency: 'INR',
      priceInPaise: tier.priceInPaise,
      quantity: tier.quantity,
      status: (tier.status ?? 'active') as 'active',
      salesStartAt: null,
      salesEndAt: null,
      minPerOrder: null,
      maxPerOrder: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  return { eventId, slug };
}

describe('GET /public/events/:idOrSlug/tiers', () => {
  it('lists active tiers with effective price and live availability', async () => {
    const server = await buildServer();
    const { slug } = await seedPublishedEventWithTiers([
      { name: 'RSVP', priceInPaise: 0, quantity: 50 },
      { name: 'VIP', priceInPaise: 200_000, quantity: 10 },
    ]);

    const response = await server.inject({ method: 'GET', url: `/events/${slug}/tiers` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      name: 'RSVP',
      priceInPaise: 0,
      currency: 'INR',
      availableQuantity: 50,
    });
    expect(body.items[1]).toMatchObject({ name: 'VIP', priceInPaise: 200_000 });
    // Internal bounds stay hidden from guests.
    expect(body.items[0]).not.toHaveProperty('minPerOrder');
    expect(body.items[0]).not.toHaveProperty('maxPerOrder');
    await server.close();
  });

  it('resolves events by id as well as slug', async () => {
    const server = await buildServer();
    const { eventId } = await seedPublishedEventWithTiers();

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/tiers`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    await server.close();
  });

  it('hides paused tiers from guests', async () => {
    const server = await buildServer();
    const { slug } = await seedPublishedEventWithTiers([
      { name: 'RSVP', priceInPaise: 0, quantity: 50 },
      { name: 'Paused Tier', priceInPaise: 0, quantity: 50, status: 'paused' },
    ]);

    const response = await server.inject({ method: 'GET', url: `/events/${slug}/tiers` });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    await server.close();
  });

  it('returns an empty list when the event has no tiers (never a 404)', async () => {
    const server = await buildServer();
    const { slug } = await seedPublishedEventWithTiers([]);

    const response = await server.inject({ method: 'GET', url: `/events/${slug}/tiers` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    await server.close();
  });

  it('404s unknown slugs like the event-detail read', async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: 'GET',
      url: '/events/no-such-event/tiers',
    });

    expect(response.statusCode).toBe(404);
    await server.close();
  });
});
