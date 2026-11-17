import { describe, expect, it, vi } from 'vitest';

import { createEvent, transitionEvent } from '../../domain/models/event.js';

import { currentStartingPricePaise } from './current-price.js';

import type { TicketTier } from '../../domain/models/event-catalog.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const event = {
  ...transitionEvent(
    transitionEvent(
      transitionEvent(
        createEvent({
          id: 'event-price',
          organizationId: 'host-price',
          venueId: 'venue-price',
          title: 'Price truth',
          startAt: '2026-12-01T20:00:00.000Z',
          endAt: '2026-12-02T00:00:00.000Z',
          now: NOW,
        }),
        'review',
        NOW,
      ),
      'scheduled',
      NOW,
    ),
    'published',
    NOW,
  ),
  startingPricePaise: 10_000,
};

function tier(overrides: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 'tier-price',
    eventId: event.id,
    organizationId: event.organizationId,
    name: 'General',
    description: '',
    entryType: 'standard',
    currency: 'INR',
    priceInPaise: 10_000,
    quantity: 100,
    status: 'active',
    salesStartAt: null,
    salesEndAt: null,
    maxPerOrder: 10,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const inventory = (availableQuantity = 10, phaseQuantity = 10) => ({
  getAvailableQuantity: vi.fn(async () => availableQuantity),
  getAvailablePricingPhaseQuantity: vi.fn(async () => phaseQuantity),
});

describe('current sellable starting price', () => {
  it('uses the active phase price while retaining the event base price separately', async () => {
    const tierRecord = tier({
      pricingPhases: [
        {
          id: 'early-bird',
          name: 'Early bird',
          priceInPaise: 5_000,
          quantity: 20,
          startsAt: '2026-11-01T00:00:00.000Z',
          endsAt: '2026-11-20T00:00:00.000Z',
        },
      ],
    });

    await expect(
      currentStartingPricePaise({
        event,
        tiers: [tierRecord],
        inventory: inventory(),
        now: NOW,
      }),
    ).resolves.toBe(5_000);
    expect(event.startingPricePaise).toBe(10_000);
  });

  it('returns to the base tier price after the active phase expires', async () => {
    const tierRecord = tier({
      pricingPhases: [
        {
          id: 'early-bird',
          name: 'Early bird',
          priceInPaise: 5_000,
          quantity: 20,
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    });

    await expect(
      currentStartingPricePaise({
        event,
        tiers: [tierRecord],
        inventory: inventory(),
        now: NOW,
      }),
    ).resolves.toBe(10_000);
  });

  it('returns null when tiers are not currently purchasable or public', async () => {
    const futureTier = tier({ salesStartAt: '2026-11-18T00:00:00.000Z' });
    const privateTier = tier({ id: 'tier-private', accessMode: 'code' });

    await expect(
      currentStartingPricePaise({
        event,
        tiers: [futureTier],
        inventory: inventory(),
        now: NOW,
      }),
    ).resolves.toBeNull();
    await expect(
      currentStartingPricePaise({
        event,
        tiers: [privateTier],
        inventory: inventory(),
        now: NOW,
        publicOnly: true,
      }),
    ).resolves.toBeNull();
    await expect(
      currentStartingPricePaise({
        event,
        tiers: [tier()],
        inventory: inventory(0),
        now: NOW,
      }),
    ).resolves.toBeNull();
  });
});
