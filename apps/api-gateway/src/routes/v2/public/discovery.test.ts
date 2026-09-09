import { describe, expect, it } from 'vitest';

import { createV2Services } from '../../../lib/v2-services.js';
import { buildPartnerTestServer } from '../../../test-utils/partner-test-server.js';

import publicDiscoveryRoutes from './discovery.js';

const buildServer = () => buildPartnerTestServer({ routes: [publicDiscoveryRoutes] });

/**
 * Seeds a published event (+ its venue and host org) directly through the
 * shared memory repositories so the public routes have something real to
 * find — mirrors how `partner/*.test.ts` suites seed via the partner routes,
 * but events only become publicly visible once `published`, which the
 * partner event routes don't expose without an org-scoped actor. Going
 * straight to the repository keeps this suite about the public surface, not
 * about re-deriving the full create→review→publish lifecycle per test.
 */
async function seedPublishedEvent(overrides: {
  eventId: string;
  slug: string;
  title: string;
  organizationId: string;
  venueId: string;
}) {
  const services = createV2Services();
  const repos = services.repos();

  // Slugs must be lowercase-hyphen only (contract regex) — the underscore in
  // e.g. `org_pub_1` has to be stripped, not just prefixed.
  const hostSlug = `host-${overrides.organizationId}`.replace(/_/g, '-');
  const venueSlug = `venue-${overrides.venueId}`.replace(/_/g, '-');

  const now = new Date();
  await repos.organizations.save({
    id: overrides.organizationId,
    name: 'Seed Host',
    slug: hostSlug,
    ownerId: 'user_1',
    members: [
      {
        userId: 'user_1',
        role: 'owner',
        capabilities: ['host', 'venue'],
        joinedAt: now.toISOString(),
      },
    ],
    settings: {},
    status: 'active',
    platformFeePercent: 15,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  await repos.venues.save({
    id: overrides.venueId,
    organizationId: overrides.organizationId,
    ownerId: 'user_1',
    status: 'active',
    public: {
      name: 'Seed Venue',
      slug: venueSlug,
      description: 'An authoritative public venue profile.',
      photoUrl: 'https://images.example.test/venue.webp',
      address: {
        street: '1 Test Street',
        city: 'Pune',
        state: 'Maharashtra',
        zip: '411001',
        country: 'IN',
        lat: 18.5204,
        lng: 73.8567,
      },
      facilities: ['stage'],
      menu: { sections: [], updatedAt: null },
      capacity: null,
      settings: { showGuestList: false, activityEnabled: false },
    },
    private: {
      contactEmail: 'private@example.test',
      contactPhone: '+910000000000',
      socials: { instagram: 'private-handle' },
      internalNotes: 'never public',
    },
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  await repos.events.save({
    id: overrides.eventId,
    organizationId: overrides.organizationId,
    venueId: overrides.venueId,
    slug: overrides.slug,
    title: overrides.title,
    summary: 'A public test event',
    description: '',
    imageUrl: null,
    startAt: '2026-09-01T18:00:00.000Z',
    endAt: null,
    status: 'published',
    isPublic: true,
    tags: ['music'],
    startingPricePaise: 5000,
    isFree: false,
    cancellationReason: null,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return { organizationSlug: hostSlug, venueSlug };
}

describe('V2 public/discovery routes', () => {
  // Runs first, deliberately: the shared memory repository is a
  // process/module-scoped singleton (`createV2Services` memoizes it), so an
  // "empty" assertion is only meaningful before any other test in this file
  // has seeded an event.
  it('returns an empty list when nothing is published yet', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/events?limit=5' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([]);
    expect(body.pageInfo.total).toBe(0);
    await server.close();
  });

  it('lists published events', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_1',
      slug: 'sky-night-1',
      title: 'Sky Night 1',
      organizationId: 'org_pub_1',
      venueId: 'ven_pub_1',
    });

    const response = await server.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((e: { id: string }) => e.id === 'evt_pub_1')).toBe(true);
    await server.close();
  });

  it('fetches event detail by id', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_2',
      slug: 'sky-night-2',
      title: 'Sky Night 2',
      organizationId: 'org_pub_2',
      venueId: 'ven_pub_2',
    });

    const response = await server.inject({ method: 'GET', url: '/events/evt_pub_2' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'evt_pub_2',
      slug: 'sky-night-2',
      venue: {
        id: 'ven_pub_2',
        name: 'Seed Venue',
        photoUrl: 'https://images.example.test/venue.webp',
        address: { city: 'Pune', country: 'IN' },
      },
      organizer: { id: 'org_pub_2', name: 'Seed Host' },
    });
    expect(response.body).not.toContain('private@example.test');
    expect(response.body).not.toContain('never public');
    expect(response.body).not.toContain('platformFeePercent');
    await server.close();
  });

  it('fetches event detail by slug', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_3',
      slug: 'sky-night-3',
      title: 'Sky Night 3',
      organizationId: 'org_pub_3',
      venueId: 'ven_pub_3',
    });

    const response = await server.inject({ method: 'GET', url: '/events/sky-night-3' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'evt_pub_3', slug: 'sky-night-3' });
    await server.close();
  });

  it('uses null relationship projections when a public event has no available venue or organizer', async () => {
    const server = await buildServer();
    const now = new Date();
    await createV2Services().repos().events.save({
      id: 'evt_orphaned_public',
      organizationId: 'org_missing_public',
      venueId: null,
      slug: 'orphaned-public-event',
      title: 'Orphaned Public Event',
      summary: 'Still a valid public event.',
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

    const response = await server.inject({ method: 'GET', url: '/events/orphaned-public-event' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ venue: null, organizer: null });
    await server.close();
  });

  it('event detail returns 404 flat envelope for an unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/events/nope-does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('event detail returns 404 for a real but non-public (draft) event', async () => {
    const server = await buildServer();
    const services = createV2Services();
    const now = new Date();
    await services.repos().events.save({
      id: 'evt_draft_1',
      organizationId: 'org_draft_1',
      venueId: null,
      slug: 'draft-event',
      title: 'Draft Event',
      summary: '',
      description: '',
      imageUrl: null,
      startAt: now.toISOString(),
      endAt: null,
      status: 'draft',
      isPublic: false,
      tags: [],
      startingPricePaise: 0,
      isFree: true,
      cancellationReason: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const response = await server.inject({ method: 'GET', url: '/events/draft-event' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('event detail fails closed when a published record is explicitly private', async () => {
    const server = await buildServer();
    const now = new Date();
    await createV2Services().repos().events.save({
      id: 'evt_private_1',
      organizationId: 'org_private_1',
      venueId: null,
      slug: 'private-published-event',
      title: 'Private Published Event',
      summary: 'Must never be returned publicly.',
      description: '',
      imageUrl: null,
      startAt: now.toISOString(),
      endAt: null,
      status: 'published',
      isPublic: false,
      tags: [],
      startingPricePaise: 0,
      isFree: true,
      cancellationReason: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const response = await server.inject({ method: 'GET', url: '/events/private-published-event' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('rejects a bad idOrSlug param with 422 + fieldErrors', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/events/not%20valid' });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('idOrSlug');
    await server.close();
  });

  it('fetches venue detail by slug', async () => {
    const server = await buildServer();
    const { venueSlug } = await seedPublishedEvent({
      eventId: 'evt_pub_4',
      slug: 'sky-night-4',
      title: 'Sky Night 4',
      organizationId: 'org_pub_4',
      venueId: 'ven_pub_4',
    });

    const response = await server.inject({ method: 'GET', url: `/venues/${venueSlug}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'ven_pub_4',
      slug: venueSlug,
      photoUrl: 'https://images.example.test/venue.webp',
      address: { street: '1 Test Street', city: 'Pune', country: 'IN' },
      facilities: ['stage'],
    });
    expect(response.body).not.toContain('private@example.test');
    expect(response.body).not.toContain('contactPhone');
    expect(response.body).not.toContain('internalNotes');
    await server.close();
  });

  it('venue detail returns 404 for an unknown slug', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/venues/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('venue detail returns 404 for a suspended venue', async () => {
    const server = await buildServer();
    const { venueSlug } = await seedPublishedEvent({
      eventId: 'evt_suspended_venue',
      slug: 'suspended-venue-event',
      title: 'Suspended Venue Event',
      organizationId: 'org_suspended_venue',
      venueId: 'ven_suspended',
    });
    const repos = createV2Services().repos();
    const venue = await repos.venues.getById('ven_suspended');
    expect(venue).not.toBeNull();
    if (venue !== null) {
      await repos.venues.save({ ...venue, status: 'suspended', version: venue.version + 1 });
    }

    const response = await server.inject({ method: 'GET', url: `/venues/${venueSlug}` });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('fetches host public profile by slug', async () => {
    const server = await buildServer();
    const { organizationSlug } = await seedPublishedEvent({
      eventId: 'evt_pub_5',
      slug: 'sky-night-5',
      title: 'Sky Night 5',
      organizationId: 'org_pub_5',
      venueId: 'ven_pub_5',
    });

    const response = await server.inject({ method: 'GET', url: `/hosts/${organizationSlug}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ id: 'org_pub_5', slug: organizationSlug });
    expect(body).not.toHaveProperty('role');
    expect(body).not.toHaveProperty('ownerId');
    expect(body).not.toHaveProperty('members');
    expect(body).not.toHaveProperty('settings');
    expect(body).not.toHaveProperty('platformFeePercent');
    await server.close();
  });

  it('host profile returns 404 for an unknown slug', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/hosts/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('host profile returns 404 for an archived organization', async () => {
    const server = await buildServer();
    const { organizationSlug } = await seedPublishedEvent({
      eventId: 'evt_archived_host',
      slug: 'archived-host-event',
      title: 'Archived Host Event',
      organizationId: 'org_archived_host',
      venueId: 'ven_archived_host',
    });
    const repos = createV2Services().repos();
    const organization = await repos.organizations.getById('org_archived_host');
    expect(organization).not.toBeNull();
    if (organization !== null) {
      await repos.organizations.save({
        ...organization,
        status: 'archived',
        version: organization.version + 1,
      });
    }

    const response = await server.inject({ method: 'GET', url: `/hosts/${organizationSlug}` });
    expect(response.statusCode).toBe(404);
    await server.close();
  });

  it('returns a discovery feed of published events', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_6',
      slug: 'sky-night-6',
      title: 'Sky Night 6',
      organizationId: 'org_pub_6',
      venueId: 'ven_pub_6',
    });

    const response = await server.inject({ method: 'GET', url: '/discovery' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((e: { id: string }) => e.id === 'evt_pub_6')).toBe(true);
    await server.close();
  });

  it('searches published events by title', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_7',
      slug: 'unique-searchable-title',
      title: 'UniqueSearchableTitle',
      organizationId: 'org_pub_7',
      venueId: 'ven_pub_7',
    });

    const response = await server.inject({
      method: 'GET',
      url: '/search?q=UniqueSearchableTitle',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items.some((e: { id: string }) => e.id === 'evt_pub_7')).toBe(true);
    await server.close();
  });

  it('search returns an empty page for no matches', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/search?q=zzz-no-match-zzz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
    await server.close();
  });

  it('rejects search with a missing q param (422)', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/search' });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('q');
    await server.close();
  });

  it('rejects a bad pagination query with 422 + fieldErrors', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/events?limit=9999' });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('limit');
    await server.close();
  });
});
