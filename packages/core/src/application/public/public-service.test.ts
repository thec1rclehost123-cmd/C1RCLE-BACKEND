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
      repositories: {
        events,
        catalog,
        venues: { getById: async () => null },
        organizations: { getById: async () => null },
      },
      inventory: { getAvailableQuantity: async () => 10 },
    } as never);

    await expect(service.listEventTiers(event.id)).resolves.toMatchObject([
      { tier: { id: 'public-tier', accessMode: 'public' }, availableQuantity: 10 },
    ]);
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
      config: { features: { m5TicketAddonsEnabled: false } },
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

describe('unlisted event visibility', () => {
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
      inventory: { getAvailableQuantity: async () => 10 },
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
