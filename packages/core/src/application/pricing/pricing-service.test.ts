import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from '../../domain/errors.js';

import { PricingService } from './pricing-service.js';

import type { TicketTier } from '../../domain/models/event-catalog.js';
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

function service(ticket: TicketTier): PricingService {
  const catalog = {
    listTiers: async () => [ticket],
    getPromoByCode: async () => null,
  } as unknown as EventCatalogRepository;
  return new PricingService({ eventCatalog: catalog });
}

describe('PricingService ticket-tier pricing', () => {
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

  it('rejects sales outside the ticket sales window', async () => {
    await expect(
      service(tier({ salesStartAt: '2099-01-01T00:00:00.000Z' })).calculate({
        eventId: 'EVT-1',
        lines: [{ tierId: 'TIER-1', quantity: 1 }],
      }),
    ).rejects.toThrow(/not started/);
  });
});
