import { createTicketAccessCode, createTicketAddon } from '@c1rcle/core/domain';
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
  visibilityMode?: 'public' | 'unlisted' | 'code' | 'invited';
  addressDisclosure?: 'public' | 'after_grant' | 'hidden';
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
      settings: { showGuestList: false, activityEnabled: false },
      capacity: null,
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
    startAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    endAt: null,
    status: 'published',
    visibilityMode: overrides.visibilityMode ?? 'public',
    addressDisclosure: overrides.addressDisclosure,
    isPublic: (overrides.visibilityMode ?? 'public') === 'public',
    tags: ['music'],
    startingPricePaise: 5000,
    isFree: false,
    cancellationReason: null,
    capacity: null,
    adminOverride: false,
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
    expect(response.headers['cache-control']).toContain('no-store');
    const body = response.json();
    expect(body.items).toEqual([]);
    expect(body.pageInfo.total).toBe(0);
    await server.close();
  });

  it('returns the same not-found response for private event detail without an event grant', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_private_no_grant_2',
      slug: 'private-night-no-grant',
      title: 'Private Night One',
      organizationId: 'org_private_no_grant_2',
      venueId: 'ven_private_no_grant_2',
      visibilityMode: 'code',
    });
    const response = await server.inject({
      method: 'GET',
      url: '/events/private-night-no-grant',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    expect(response.headers['cache-control']).toContain('no-store');
    await server.close();
  });

  it('hides private venue address by default and reveals it only under explicit after-grant policy', async () => {
    const server = await buildServer();
    const services = createV2Services();
    const eventId = 'evt_private_address_policy';
    const venueId = 'ven_private_address_policy';
    const userId = 'guest_private_address_policy';
    await seedPublishedEvent({
      eventId,
      slug: 'private-address-policy',
      title: 'Private Address Policy',
      organizationId: 'org_private_address_policy',
      venueId,
      visibilityMode: 'code',
    });
    const now = new Date();
    const accessCode = createTicketAccessCode({
      id: 'a'.repeat(64),
      eventId,
      organizationId: 'org_private_address_policy',
      tierIds: [],
      scope: 'event',
      createdBy: 'host_admin',
      startsAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      maxRedemptions: 1,
      now,
    });
    await services.repos().ticketAccess.createCode(accessCode);
    const redeemed = await services.repos().ticketAccess.redeem({
      codeId: accessCode.id,
      grantId: 'grant_private_address_policy',
      userId,
      now,
    });
    expect(redeemed).not.toBeNull();

    const request = () =>
      server.inject({
        method: 'GET',
        url: `/events/${eventId}`,
        headers: {
          'x-user-id': userId,
          'x-ticket-access-grant-id': 'grant_private_address_policy',
        },
      });
    const hidden = await request();
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().venue.address).toEqual({});
    expect(hidden.json().imageUrl).toBeNull();
    expect(hidden.headers['cache-control']).toContain('no-store');

    const event = await services.repos().events.getById(eventId);
    if (!event) throw new Error('seeded private event should exist');
    await services.repos().events.save({
      ...event,
      addressDisclosure: 'after_grant',
      imageUrl: null,
      privateImageStoragePath: 'posters/org_private_address_policy/private-poster.webp',
      version: event.version + 1,
      updatedAt: new Date(now.getTime() + 1).toISOString(),
    });
    const revealed = await request();
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().imageUrl).toBe(
      'memory://reads/posters/org_private_address_policy/private-poster.webp',
    );
    expect(revealed.json().venue.address).toMatchObject({
      street: '1 Test Street',
      zip: '411001',
      lat: 18.5204,
      lng: 73.8567,
    });
    await server.close();
  });

  it('keeps unlisted events out of discovery while serving their direct link', async () => {
    await seedPublishedEvent({
      eventId: 'evt_unlisted_1',
      slug: 'unlisted-night-1',
      title: 'Unlisted Night',
      organizationId: 'org_unlisted_1',
      venueId: 'ven_unlisted_1',
      visibilityMode: 'unlisted',
    });
    const server = await buildServer();

    const listing = await server.inject({ method: 'GET', url: '/events?limit=20' });
    const detail = await server.inject({ method: 'GET', url: '/events/unlisted-night-1' });

    expect(listing.statusCode).toBe(200);
    expect(listing.json().items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'evt_unlisted_1' })]),
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: 'evt_unlisted_1',
      visibilityMode: 'unlisted',
      isPublic: false,
    });
    await server.close();
  });

  it('requires a UUID click token on anonymous Promoter click tracking', async () => {
    const server = await buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/promoter-links/click',
      payload: { eventSlug: 'unknown-event', code: 'M4CODE' },
    });
    expect(response.statusCode).toBe(422);
    await server.close();
  });

  it('acknowledges an anonymous click without revealing whether its code exists', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_click_privacy',
      slug: 'click-privacy-event',
      title: 'Click Privacy Event',
      organizationId: 'org_click_privacy',
      venueId: 'ven_click_privacy',
    });

    const response = await server.inject({
      method: 'POST',
      url: '/promoter-links/click',
      payload: {
        eventSlug: 'click-privacy-event',
        code: 'UNKNOWN',
        clickId: '090d862e-85c0-46a6-9713-4504174f3d38',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
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

  it('serves only the active add-on sell projection for a public event', async () => {
    const server = await buildServer();
    const eventId = 'evt_public_addons';
    await seedPublishedEvent({
      eventId,
      slug: 'public-addons',
      title: 'Public Add-ons',
      organizationId: 'org_public_addons',
      venueId: 'ven_public_addons',
    });
    const catalog = createV2Services().repos().catalog;
    const active = createTicketAddon({
      id: 'addon_public_parking',
      eventId,
      organizationId: 'org_public_addons',
      name: 'Parking pass',
      description: 'One vehicle',
      kind: 'parking',
      priceInPaise: 25_000,
      quantity: 5,
    });
    await catalog.saveTicketAddon(active);
    await catalog.saveTicketAddon(
      createTicketAddon({
        id: 'addon_paused',
        eventId,
        organizationId: 'org_public_addons',
        name: 'Paused cloakroom',
        kind: 'cloakroom',
        priceInPaise: 1_000,
        quantity: 5,
        status: 'paused',
      }),
    );

    const response = await server.inject({
      method: 'GET',
      url: `/events/${eventId}/ticket-addons`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json().items).toEqual([
      {
        id: active.id,
        eventId,
        name: 'Parking pass',
        description: 'One vehicle',
        kind: 'parking',
        priceInPaise: 25_000,
        currency: 'INR',
        availableQuantity: 5,
        maxPerEntitlement: 1,
      },
    ]);
    await seedPublishedEvent({
      eventId: 'evt_private_addons',
      slug: 'private-addons',
      title: 'Private Add-ons',
      organizationId: 'org_private_addons',
      venueId: 'ven_private_addons',
      visibilityMode: 'code',
    });
    const privateEvent = await server.inject({
      method: 'GET',
      url: '/events/private-addons/ticket-addons',
    });
    expect(privateEvent.statusCode).toBe(404);
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
      capacity: null,
      adminOverride: false,
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
      capacity: null,
      adminOverride: false,
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
      capacity: null,
      adminOverride: false,
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

  it('fetches venue detail by id for event venue resolution', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_8',
      slug: 'sky-night-8',
      title: 'Sky Night 8',
      organizationId: 'org_pub_8',
      venueId: 'ven_pub_8',
    });

    const response = await server.inject({ method: 'GET', url: '/venues/by-id/ven_pub_8' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'ven_pub_8', name: 'Seed Venue' });
    await server.close();
  });

  it('venue by-id returns 404 for an unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/venues/by-id/ven_missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('rejects a bad venueId param with 422 + fieldErrors', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/venues/by-id/not%20valid' });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('venueId');
    await server.close();
  });

  it('fetches host public profile by id for event host resolution', async () => {
    const server = await buildServer();
    await seedPublishedEvent({
      eventId: 'evt_pub_9',
      slug: 'sky-night-9',
      title: 'Sky Night 9',
      organizationId: 'org_pub_9',
      venueId: 'ven_pub_9',
    });

    const response = await server.inject({ method: 'GET', url: '/hosts/by-id/org_pub_9' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'org_pub_9', name: 'Seed Host' });
    await server.close();
  });

  it('host by-id returns 404 for an unknown id', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/hosts/by-id/org_missing' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    await server.close();
  });

  it('rejects a bad organizationId param with 422 + fieldErrors', async () => {
    const server = await buildServer();
    const response = await server.inject({ method: 'GET', url: '/hosts/by-id/not%20valid' });
    expect(response.statusCode).toBe(422);
    expect(response.json().fieldErrors).toHaveProperty('organizationId');
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
    expect(response.headers['cache-control']).toContain('no-store');
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
    expect(response.headers['cache-control']).toContain('no-store');
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
