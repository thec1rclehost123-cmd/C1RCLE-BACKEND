import { describe, expect, it, vi } from 'vitest';

import { createTicketTier } from '../../domain/models/event-catalog.js';
import { createEvent, transitionEvent } from '../../domain/models/event.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';
import {
  MemoryEventCatalogRepository,
  MemoryEventRepository,
} from '../../infrastructure/memory/memory-repositories.js';

import { availableTicketQuantity, PublicService } from './public-service.js';

describe('public purchase quantities', () => {
  it('converts attendee capacity to complete per-person group units', () => {
    const tier = createTicketTier({
      id: 'group-tier',
      eventId: 'event',
      organizationId: 'host',
      name: 'Group of three',
      priceInPaise: 3000,
      quantity: 20,
      guestCount: 3,
      admissionMode: 'per_person',
    });

    expect(availableTicketQuantity(tier, 8)).toBe(2);
    expect(availableTicketQuantity(tier, 2)).toBe(0);
  });

  it('preserves legacy bundle inventory units', () => {
    const tier = createTicketTier({
      id: 'legacy-tier',
      eventId: 'event',
      organizationId: 'host',
      name: 'Couple',
      priceInPaise: 3000,
      quantity: 20,
      guestCount: 2,
    });

    expect(availableTicketQuantity(tier, 8)).toBe(8);
  });

  it('does not disclose code or invited tiers on the public sell surface', async () => {
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    let event = createEvent({
      id: 'public-with-hidden-tiers',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Public with allocations',
      startAt: '2026-11-28T20:00:00.000Z',
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({ ...event, version: 1 });

    for (const accessMode of ['public', 'code', 'invited'] as const) {
      await catalog.saveTier(
        createTicketTier({
          id: `${accessMode}-tier`,
          eventId: event.id,
          organizationId: event.organizationId,
          name: `${accessMode} allocation`,
          priceInPaise: 1000,
          quantity: 10,
          accessMode,
          now,
        }),
      );
    }

    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
      inventory: {
        getAvailableQuantity: async () => 10,
        getTierInventory: async () => ({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 }),
        getAvailablePricingPhaseQuantity: async () => 10,
      },
    } as never);

    await expect(service.listEventTiers(event.id)).resolves.toMatchObject([
      { tier: { id: 'public-tier', accessMode: 'public' }, availableQuantity: 10 },
    ]);
  });

  it('reports the lowest currently purchasable public phase price', async () => {
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const now = new Date('2026-11-17T12:00:00.000Z');
    let event = createEvent({
      id: 'public-current-price',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Current price',
      startAt: '2026-12-01T20:00:00.000Z',
      now,
    });
    event = transitionEvent(transitionEvent(event, 'review', now), 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({ ...event, startingPricePaise: 9_000, version: 1 });

    await catalog.saveTier(
      createTicketTier({
        id: 'public-current-price-tier',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Public early bird',
        priceInPaise: 9_000,
        quantity: 10,
        pricingPhases: [
          {
            id: 'early-bird',
            name: 'Early bird',
            priceInPaise: 5_000,
            quantity: 2,
            startsAt: '2026-11-01T00:00:00.000Z',
            endsAt: '2026-11-20T00:00:00.000Z',
          },
        ],
        now,
      }),
    );
    await catalog.saveTier(
      createTicketTier({
        id: 'private-lower-price-tier',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Private allocation',
        priceInPaise: 1_000,
        quantity: 10,
        accessMode: 'code',
        now,
      }),
    );

    const inventory = {
      getTierInventory: vi.fn(async () => ({
        soldQuantity: 0,
        heldQuantity: 0,
        availableQuantity: 10,
      })),
      getAvailableQuantity: vi.fn(async () => 10),
      getAvailablePricingPhaseQuantity: vi.fn(async () => 1),
    };
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
      inventory,
    } as never);

    await expect(service.getCurrentStartingPricePaise(event.id)).resolves.toBe(5_000);
  });

  it('hides add-ons from the public sell projection while sales approval is disabled', async () => {
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    let event = createEvent({
      id: 'public-addons-disabled',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Public add-ons disabled',
      startAt: '2026-11-28T20:00:00.000Z',
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({ ...event, version: 1 });
    await catalog.saveTicketAddon(
      createTicketAddon({
        id: 'addon-disabled',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Parking pass',
        kind: 'parking',
        priceInPaise: 5000,
        quantity: 5,
        now,
      }),
    );
    const service = new PublicService({
      config: { features: { m5TicketAddonsEnabled: false }, clock: { now: () => now } },
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
      inventory: { getAvailableTicketAddonQuantity: async () => 5 },
    } as never);

    await expect(service.listEventTicketAddons(event.id)).resolves.toEqual([]);
  });
});

describe('public Guest price and availability projection', () => {
  async function makePublishedEvent(now: Date, catalog: MemoryEventCatalogRepository) {
    const events = new MemoryEventRepository();
    let event = createEvent({
      id: 'public-pricing-event',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Public pricing event',
      startAt: new Date(now.getTime() + 86_400_000).toISOString(),
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({ ...event, version: 1 });
    const service = (inventory: {
      soldQuantity: number;
      heldQuantity: number;
      availableQuantity: number;
      phaseAvailable?: number;
    }) =>
      new PublicService({
        config: { clock: { now: () => now } },
        repositories: {
          events,
          catalog,
          venues: { getById: async () => null },
          organizations: { getById: async () => null },
        },
        inventory: {
          getTierInventory: async () => ({
            soldQuantity: inventory.soldQuantity,
            heldQuantity: inventory.heldQuantity,
            availableQuantity: inventory.availableQuantity,
          }),
          getAvailableQuantity: async () => inventory.availableQuantity,
          getAvailablePricingPhaseQuantity: async () => inventory.phaseAvailable ?? 0,
          getAvailableTicketAddonQuantity: async () => 0,
        },
      } as never);
    return { event, events, service };
  }

  it('returns the active phase price separately from the base price', async () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const { event, service } = await makePublishedEvent(now, catalog);
    const publicService = service({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 });
    await catalog.saveTier(
      createTicketTier({
        id: 'general',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'General Entry',
        priceInPaise: 80_000,
        quantity: 10,
        pricingPhases: [
          {
            id: 'early-bird',
            name: 'Early Bird',
            priceInPaise: 65_000,
            startsAt: '2026-11-15T00:00:00.000Z',
            endsAt: '2026-11-22T00:00:00.000Z',
            quantity: null,
          },
        ],
        now,
      }),
    );

    await expect(publicService.getPublicPricingSummary(event)).resolves.toMatchObject({
      salesStatus: 'on_sale',
      activeStartingPricePaise: 65_000,
    });
    await expect(publicService.listEventTiers(event.id)).resolves.toMatchObject([
      {
        priceInPaise: 65_000,
        basePriceInPaise: 80_000,
        pricingPhase: { name: 'Early Bird', availableQuantity: null },
        availabilityStatus: 'available',
      },
    ]);
  });

  it('does not present a tier before its sales window starts', async () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const { event, service } = await makePublishedEvent(now, catalog);
    const publicService = service({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 });
    await catalog.saveTier(
      createTicketTier({
        id: 'future-tier',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Future tier',
        priceInPaise: 80_000,
        quantity: 10,
        salesStartAt: '2026-11-20T00:00:00.000Z',
        now,
      }),
    );

    await expect(publicService.getPublicPricingSummary(event)).resolves.toMatchObject({
      salesStatus: 'not_yet_available',
      activeStartingPricePaise: null,
    });
    await expect(publicService.listEventTiers(event.id)).resolves.toMatchObject([
      { availableQuantity: 0, availabilityStatus: 'not_yet_available' },
    ]);
  });

  it('distinguishes capacity temporarily held from sold out', async () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const { event, service } = await makePublishedEvent(now, catalog);
    await catalog.saveTier(
      createTicketTier({
        id: 'held-tier',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Held tier',
        priceInPaise: 80_000,
        quantity: 10,
        now,
      }),
    );
    const heldService = service({ soldQuantity: 0, heldQuantity: 10, availableQuantity: 0 });

    await expect(heldService.getPublicPricingSummary(event)).resolves.toMatchObject({
      salesStatus: 'temporarily_held',
      activeStartingPricePaise: null,
    });
    await expect(heldService.listEventTiers(event.id)).resolves.toMatchObject([
      { availableQuantity: 0, availabilityStatus: 'temporarily_held' },
    ]);
  });

  it('reports all paused public tiers as paused instead of sold out', async () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const { event, service } = await makePublishedEvent(now, catalog);
    const tier = createTicketTier({
      id: 'paused-tier',
      eventId: event.id,
      organizationId: event.organizationId,
      name: 'Paused tier',
      priceInPaise: 80_000,
      quantity: 10,
      now,
    });
    await catalog.saveTier({ ...tier, status: 'paused' });

    await expect(
      service({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 }).getPublicPricingSummary(
        event,
      ),
    ).resolves.toMatchObject({
      salesStatus: 'sales_paused',
      activeStartingPricePaise: null,
    });
  });

  it('reports all public tiers past their sales window as ended instead of sold out', async () => {
    const now = new Date('2026-11-19T12:00:00.000Z');
    const catalog = new MemoryEventCatalogRepository();
    const { event, service } = await makePublishedEvent(now, catalog);
    await catalog.saveTier(
      createTicketTier({
        id: 'ended-tier',
        eventId: event.id,
        organizationId: event.organizationId,
        name: 'Ended tier',
        priceInPaise: 80_000,
        quantity: 10,
        salesEndAt: '2026-11-18T00:00:00.000Z',
        now,
      }),
    );

    await expect(
      service({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 }).getPublicPricingSummary(
        event,
      ),
    ).resolves.toMatchObject({ salesStatus: 'ended', activeStartingPricePaise: null });
  });
});

describe('historical public events', () => {
  async function seedEndedEvent(
    events: MemoryEventRepository,
    overrides: { id: string; slug: string; visibilityMode?: 'public' | 'code' },
    now: Date,
    legacyHidden = false,
  ) {
    let event = createEvent({
      id: overrides.id,
      organizationId: 'host',
      venueId: 'venue',
      title: overrides.slug,
      startAt: '2026-12-01T18:00:00.000Z',
      visibilityMode: overrides.visibilityMode ?? 'public',
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    event = transitionEvent(event, 'started', now);
    event = { ...transitionEvent(event, 'ended', now), isPublic: !legacyHidden, version: 1 };
    await events.save(event);
    return event;
  }

  it('serves public ended details and search while keeping them out of upcoming discovery', async () => {
    const events = new MemoryEventRepository();
    const now = new Date('2026-11-19T12:00:00.000Z');
    const ended = await seedEndedEvent(
      events,
      { id: 'ended-public', slug: 'ended-public-night' },
      now,
    );
    const legacyEnded = await seedEndedEvent(
      events,
      { id: 'ended-legacy', slug: 'ended-legacy-night' },
      now,
      true,
    );
    await seedEndedEvent(
      events,
      { id: 'ended-private', slug: 'ended-private-night', visibilityMode: 'code' },
      now,
      true,
    );
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
    } as never);

    await expect(service.getEvent(ended.id)).resolves.toMatchObject({
      event: { id: ended.id, status: 'ended', isPublic: true },
    });
    await expect(service.getEvent(legacyEnded.id)).resolves.toMatchObject({
      event: { id: legacyEnded.id, status: 'ended', isPublic: true },
    });
    await expect(service.search('ended-', { limit: 20, cursor: null })).resolves.toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ id: ended.id }),
        expect.objectContaining({ id: legacyEnded.id }),
      ]),
    });
    await expect(service.listEvents({ limit: 20, cursor: null })).resolves.toMatchObject({
      items: [],
    });
    await expect(service.discovery()).resolves.toEqual([]);
    await expect(service.getEvent('ended-private')).rejects.toThrow();
  });

  it('does not make archived events searchable or directly available', async () => {
    const events = new MemoryEventRepository();
    const now = new Date('2026-11-19T12:00:00.000Z');
    let archived = await seedEndedEvent(
      events,
      { id: 'archived-event', slug: 'archived-night' },
      now,
    );
    archived = transitionEvent(archived, 'archived', now);
    await events.save(archived);
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
    } as never);

    await expect(service.getEvent(archived.id)).rejects.toThrow();
    await expect(
      service.search('archived-night', { limit: 20, cursor: null }),
    ).resolves.toMatchObject({
      total: 0,
      items: [],
    });
  });
});

describe('unlisted event visibility', () => {
  it('excludes an event at its effective end from the public list and reports it ended', async () => {
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    let event = createEvent({
      id: 'finished-public-event',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Finished Public Event',
      startAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
      endAt: now.toISOString(),
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({ ...event, version: 1 });
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: { events, catalog },
    } as never);

    await expect(service.listEvents({ cursor: null, limit: 20 })).resolves.toMatchObject({
      items: [],
    });
    await expect(service.getSalesStatus(event)).resolves.toBe('ended');
  });

  it('omits an unlisted event from discovery while allowing direct-link detail', async () => {
    const events = new MemoryEventRepository();
    const now = new Date('2026-10-28T12:00:00.000Z');
    let event = createEvent({
      id: 'unlisted-night',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Unlisted Night',
      startAt: '2026-11-28T20:00:00.000Z',
      visibilityMode: 'unlisted',
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({
      ...event,
      imageUrl: null,
      privateImageStoragePath: 'posters/host/private-night.webp',
      version: 1,
    });
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
    } as never);

    await expect(service.listEvents({ cursor: null, limit: 20 })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(service.getEvent('unlisted-night')).resolves.toMatchObject({
      event: { id: 'unlisted-night', visibilityMode: 'unlisted', isPublic: false },
    });
  });
});

describe('private event visibility', () => {
  it('requires an active event-scoped grant and does not expand it to unrelated hidden tiers', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    let event = createEvent({
      id: 'private-night',
      organizationId: 'host',
      venueId: 'venue',
      title: 'Private Night',
      startAt: '2026-11-28T20:00:00.000Z',
      visibilityMode: 'code',
      now,
    });
    event = transitionEvent(event, 'review', now);
    event = transitionEvent(event, 'scheduled', now);
    event = transitionEvent(event, 'published', now);
    await events.save({
      ...event,
      imageUrl: null,
      privateImageStoragePath: 'posters/host/private-night.webp',
      version: 1,
    });
    for (const accessMode of ['public', 'code'] as const) {
      await catalog.saveTier(
        createTicketTier({
          id: `${accessMode}-tier`,
          eventId: event.id,
          organizationId: event.organizationId,
          name: `${accessMode} allocation`,
          priceInPaise: 1000,
          quantity: 10,
          accessMode,
          now,
        }),
      );
    }
    const grant = {
      id: 'event-grant',
      codeId: 'event-code',
      scope: 'event',
      eventId: event.id,
      organizationId: event.organizationId,
      userId: 'verified-guest',
      tierIds: [],
      expiresAt: '2026-11-28T20:00:00.000Z',
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const code = {
      id: 'event-code',
      scope: 'event',
      kind: 'code',
      eventId: event.id,
      organizationId: event.organizationId,
      tierIds: [],
      recipientEmailHash: null,
      createdBy: 'host-user',
      status: 'active',
      startsAt: '2026-10-28T00:00:00.000Z',
      expiresAt: '2026-11-28T20:00:00.000Z',
      maxRedemptions: 20,
      redemptionCount: 1,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const issueReadUrl = vi.fn().mockResolvedValue({
      readUrl: 'https://signed.example/private-night.webp?token=opaque',
      expiresAt: now.getTime() + 300_000,
    });
    const service = new PublicService({
      config: { features: { m5PrivateAccess: true }, clock: { now: () => now } },
      objectStorage: { issueReadUrl },
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
        ticketAccess: {
          getGrantById: async (id: string) => (id === grant.id ? grant : null),
          getCodeById: async (id: string) => (id === code.id ? code : null),
        },
      },
      inventory: {
        getAvailableQuantity: async () => 10,
        getTierInventory: async () => ({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 }),
        getAvailablePricingPhaseQuantity: async () => 10,
      },
    } as never);

    await expect(service.getEvent(event.id)).rejects.toThrow();
    await expect(service.getEvent(event.id, 'verified-guest', grant.id)).resolves.toMatchObject({
      event: {
        imageUrl: 'https://signed.example/private-night.webp?token=opaque',
        privateImageStoragePath: 'posters/host/private-night.webp',
      },
    });
    expect(issueReadUrl).toHaveBeenCalledWith({
      key: 'posters/host/private-night.webp',
      expiresAt: now.getTime() + 300_000,
    });
    await expect(
      service.listEventTiers(event.id, 'verified-guest', grant.id),
    ).resolves.toMatchObject([{ tier: { id: 'public-tier', accessMode: 'public' } }]);
    const signedReadCount = issueReadUrl.mock.calls.length;
    const storedPrivateEvent = await events.getById(event.id);
    if (!storedPrivateEvent) throw new Error('seeded private event should exist');
    await events.save({
      ...storedPrivateEvent,
      privateImageStoragePath: 'posters/other-host/private-night.webp',
      version: storedPrivateEvent.version + 1,
    });
    await expect(service.getEvent(event.id, 'verified-guest', grant.id)).resolves.toMatchObject({
      event: { imageUrl: null },
    });
    expect(issueReadUrl).toHaveBeenCalledTimes(signedReadCount);
    await expect(service.getEvent(event.id, 'other-guest', grant.id)).rejects.toThrow();

    await events.save({
      ...event,
      visibilityMode: 'invited',
      isPublic: false,
      version: 3,
    });
    await expect(service.getEvent(event.id, 'verified-guest', grant.id)).rejects.toThrow();
  });
});

describe('V1 active tier exposure', () => {
  it('keeps legacy Student/Member enum records internal', async () => {
    const events = new MemoryEventRepository();
    const catalog = new MemoryEventCatalogRepository();
    const now = new Date();
    let event = createEvent({
      id: 'v1-categories',
      organizationId: 'host',
      venueId: 'venue',
      title: 'V1 categories',
      startAt: '2027-11-28T20:00:00.000Z',
      now,
    });
    for (const status of ['review', 'scheduled', 'published'] as const)
      event = transitionEvent(event, status, now);
    await events.save({ ...event, version: 1 });
    for (const audienceType of ['GENERAL', 'STUDENT', 'MEMBER'] as const)
      await catalog.saveTier(
        createTicketTier({
          id: audienceType,
          eventId: event.id,
          organizationId: 'host',
          name: audienceType,
          priceInPaise: 1000,
          quantity: 10,
          audienceType,
          now,
        }),
      );
    const service = new PublicService({
      config: { clock: { now: () => now } },
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
      inventory: {
        getAvailableQuantity: async () => 10,
        getTierInventory: async () => ({ soldQuantity: 0, heldQuantity: 0, availableQuantity: 10 }),
        getAvailablePricingPhaseQuantity: async () => 10,
      },
    } as never);
    expect((await service.listEventTiers(event.id)).map((row) => row.tier.audienceType)).toEqual([
      'GENERAL',
    ]);
  });
});
