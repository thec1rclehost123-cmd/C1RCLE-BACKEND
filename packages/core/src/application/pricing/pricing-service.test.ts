import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidOperationError } from '../../domain/errors.js';
import { createPromoCode } from '../../domain/models/event-catalog.js';
import { createTicketAddon } from '../../domain/models/ticket-addon.js';

import { PricingService } from './pricing-service.js';

import type { PromoCode, TicketTier } from '../../domain/models/event-catalog.js';
import type { EventCatalogRepository } from '../../domain/ports/repositories.js';

function tier(overrides: Partial<TicketTier> = {}): TicketTier {
  return {
    id: 'TIER-1',
    eventId: 'EVT-1',
    organizationId: 'ORG-1',
    name: 'Stag Entry',
    description: '',
    entryType: 'general',
    currency: 'INR',
    priceInPaise: 199_900,
    quantity: 100,
    status: 'active',
    salesStartAt: null,
    salesEndAt: null,
    maxPerOrder: null,
    ...overrides,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function service(
  ticket: TicketTier,
  options: { promo?: PromoCode; clock?: () => Date } = {},
): PricingService {
  const catalog = {
    listTiers: async () => [ticket],
    listTicketAddons: async () => [],
    getPromoByCode: async (code: string) => (options.promo?.code === code ? options.promo : null),
  } as unknown as EventCatalogRepository;
  return new PricingService({
    eventCatalog: catalog,
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

describe('PricingService ticket-tier pricing', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['before phase', '2026-11-15T18:29:59.999Z', 80_000],
    ['exact India-time start', '2026-11-15T18:30:00.000Z', 65_000],
    ['inside phase', '2026-11-19T12:00:00.000Z', 65_000],
    ['exact India-time end', '2026-11-22T18:30:00.000Z', 80_000],
    ['after phase', '2026-11-22T18:30:00.001Z', 80_000],
  ])('uses the correct phase price %s', async (_label, now, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const result = await service(
      tier({
        priceInPaise: 80_000,
        pricingPhases: [
          {
            id: 'EARLY-BIRD',
            name: 'Early Bird',
            priceInPaise: 65_000,
            startsAt: '2026-11-15T18:30:00.000Z',
            endsAt: '2026-11-22T18:30:00.000Z',
            quantity: null,
          },
        ],
      }),
    ).calculate({ eventId: 'EVT-1', lines: [{ tierId: 'TIER-1', quantity: 1 }] });

    expect(result.lines[0]?.unitPricePaise).toBe(expected);
  });

  it('resolves the currently active pricing phase', async () => {
    const result = await service(
      tier({
        priceInPaise: 199_900,
        pricingPhases: [
          {
            id: 'PHASE-2',
            name: 'Phase 2',
            priceInPaise: 149_900,
            startsAt: '2026-01-01T00:00:00.000Z',
            endsAt: '2099-01-01T00:00:00.000Z',
            quantity: null,
          },
        ],
      }),
    ).calculate({ eventId: 'EVT-1', lines: [{ tierId: 'TIER-1', quantity: 1 }] });

    expect(result.lines[0]?.unitPricePaise).toBe(149_900);
  });

  it('fails closed on overlapping active phases and ignores malformed legacy windows', async () => {
    const first = {
      id: 'PHASE-1',
      name: 'Early Bird',
      priceInPaise: 65_000,
      startsAt: '2000-01-01T00:00:00.000Z',
      endsAt: '2099-01-01T00:00:00.000Z',
      quantity: null,
    };
    const second = { ...first, id: 'PHASE-2', name: 'Weekend' };
    await expect(
      service(tier({ pricingPhases: [first, second] }), {
        clock: () => new Date('2026-11-19T12:00:00.000Z'),
      }).calculate({ eventId: 'EVT-1', lines: [{ tierId: 'TIER-1', quantity: 1 }] }),
    ).rejects.toThrow(/Overlapping ticket price phases/);

    const malformed = { ...first, startsAt: 'not-a-date' };
    const result = await service(tier({ priceInPaise: 80_000, pricingPhases: [malformed] }), {
      clock: () => new Date('2026-11-19T12:00:00.000Z'),
    }).calculate({ eventId: 'EVT-1', lines: [{ tierId: 'TIER-1', quantity: 1 }] });
    expect(result.lines[0]).toMatchObject({
      unitPricePaise: 80_000,
      baseAdmissionUnitPricePaise: 80_000,
      pricingPhaseName: null,
    });
  });

  it('applies a normalized promo to the active phase price and returns that phase truth', async () => {
    const promo = createPromoCode({
      id: 'PROMO-STAGE001',
      eventId: 'EVT-1',
      organizationId: 'ORG-1',
      code: 'STAGE001',
      discountType: 'percent',
      discountValue: 10,
      discountFundingOwner: 'host',
      startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-12-01T00:00:00.000Z',
      now: new Date('2026-11-17T00:00:00.000Z'),
    });
    const clock = vi.fn(() => new Date('2026-11-19T12:00:00.000Z'));
    const result = await service(
      tier({
        priceInPaise: 80_000,
        pricingPhases: [
          {
            id: 'EARLY-BIRD',
            name: 'Early Bird',
            priceInPaise: 65_000,
            startsAt: '2026-11-15T00:00:00.000Z',
            endsAt: '2026-11-22T00:00:00.000Z',
            quantity: null,
          },
        ],
      }),
      { promo, clock },
    ).calculate({
      eventId: 'EVT-1',
      lines: [{ tierId: 'TIER-1', quantity: 1 }],
      promoCode: ' stage001 ',
    });

    expect(clock).toHaveBeenCalledTimes(1);
    expect(result.lines[0]).toMatchObject({
      unitPricePaise: 65_000,
      baseAdmissionUnitPricePaise: 80_000,
      pricingPhaseName: 'Early Bird',
    });
    expect(result).toMatchObject({ subtotalPaise: 65_000, discountPaise: 6_500 });
  });

  it('rejects paused tiers before calculating a price', async () => {
    await expect(
      service(tier({ status: 'paused' })).calculate({
        eventId: 'EVT-1',
        lines: [{ tierId: 'TIER-1', quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(InvalidOperationError);
  });

  it('rejects quantities below the minimum per order', async () => {
    await expect(
      service(tier({ minPerOrder: 2 })).calculate({
        eventId: 'EVT-1',
        lines: [{ tierId: 'TIER-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/at least 2/);
  });

  it('rejects a server quote above the tier maximum per order', async () => {
    await expect(
      service(tier({ maxPerOrder: 4 })).calculate({
        eventId: 'EVT-1',
        lines: [{ tierId: 'TIER-1', quantity: 5 }],
      }),
    ).rejects.toThrow(/maximum of 4 per order/);
  });

  it('rejects sales outside the ticket sales window', async () => {
    await expect(
      service(tier({ salesStartAt: '2099-01-01T00:00:00.000Z' })).calculate({
        eventId: 'EVT-1',
        lines: [{ tierId: 'TIER-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/not started/);
  });

  it('uses server catalog price for a per-ticket add-on and keeps it outside the admission subtotal', async () => {
    const parking = createTicketAddon({
      id: 'ADDON-PARKING',
      eventId: 'EVT-1',
      organizationId: 'ORG-1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 50_000,
      quantity: 20,
    });
    const addonPricing = new PricingService({
      eventCatalog: {
        listTiers: async () => [tier()],
        listTicketAddons: async () => [parking],
        getPromoByCode: async () => null,
      } as unknown as EventCatalogRepository,
    });

    const result = await addonPricing.calculate({
      eventId: 'EVT-1',
      lines: [
        {
          tierId: 'TIER-1',
          quantity: 1,
          ticketAddons: [{ addonId: parking.id, quantityPerEntitlement: 1 }],
        },
      ],
    });

    expect(result).toMatchObject({
      admissionSubtotalPaise: 199_900,
      addOnSubtotalPaise: 50_000,
      subtotalPaise: 249_900,
      discountedSubtotalPaise: 249_900,
      lines: [
        {
          unitPricePaise: 249_900,
          ticketAddons: [
            {
              addonId: 'ADDON-PARKING',
              unitPricePaise: 50_000,
              quantityPerEntitlement: 1,
            },
          ],
        },
      ],
    });
  });

  it('rejects add-ons from a different event and quantities over their per-ticket limit', async () => {
    const parking = createTicketAddon({
      id: 'ADDON-PARKING',
      eventId: 'EVT-1',
      organizationId: 'ORG-1',
      name: 'Parking pass',
      kind: 'parking',
      priceInPaise: 50_000,
      quantity: 20,
      maxPerEntitlement: 1,
    });
    const addonPricing = new PricingService({
      eventCatalog: {
        listTiers: async () => [tier({ eventId: 'EVT-2' })],
        listTicketAddons: async () => [parking],
        getPromoByCode: async () => null,
      } as unknown as EventCatalogRepository,
    });
    await expect(
      addonPricing.calculate({
        eventId: 'EVT-2',
        lines: [
          {
            tierId: 'TIER-1',
            quantity: 1,
            ticketAddons: [{ addonId: parking.id, quantityPerEntitlement: 1 }],
          },
        ],
      }),
    ).rejects.toThrow(/not available/);
  });
});

describe('quantity-priced Early Bird allocations', () => {
  const phase = {
    id: 'EARLY',
    name: 'Early Bird',
    priceInPaise: 25_000,
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2099-01-01T00:00:00.000Z',
    quantity: 50,
  };
  function earlyService(remaining: number) {
    const eventCatalog = {
      listTiers: async () => [tier({ priceInPaise: 50_000, pricingPhases: [phase] })],
      listTicketAddons: async () => [],
    } as unknown as EventCatalogRepository;
    return new PricingService({
      eventCatalog,
      inventory: { getAvailablePricingPhaseQuantity: async () => remaining },
    });
  }
  it('quotes the phase only while its allocation fits and snapshots phase identity', async () => {
    const result = await earlyService(1).calculate({
      eventId: 'EVT-1',
      lines: [{ tierId: 'TIER-1', quantity: 1 }],
    });
    expect(result.lines[0]).toMatchObject({ unitPricePaise: 25_000, pricingPhaseId: 'EARLY' });
  });
  it('uses the regular price when the quantity allocation is exhausted', async () => {
    const result = await earlyService(0).calculate({
      eventId: 'EVT-1',
      lines: [{ tierId: 'TIER-1', quantity: 1 }],
    });
    expect(result.lines[0]).toMatchObject({ unitPricePaise: 50_000 });
    expect(result.lines[0]?.pricingPhaseId).toBeNull();
  });
  it('does not quote two Early Bird allocations when only one remains', async () => {
    const result = await earlyService(1).calculate({
      eventId: 'EVT-1',
      lines: [{ tierId: 'TIER-1', quantity: 2 }],
    });
    expect(result.lines[0]?.unitPricePaise).toBe(50_000);
  });
  it('rejects duplicate tier lines that could bypass a server purchase limit', async () => {
    await expect(
      service(tier({ maxPerOrder: 1 })).calculate({
        eventId: 'EVT-1',
        lines: [
          { tierId: 'TIER-1', quantity: 1 },
          { tierId: 'TIER-1', quantity: 1 },
        ],
      }),
    ).rejects.toThrow('only once');
  });
});
