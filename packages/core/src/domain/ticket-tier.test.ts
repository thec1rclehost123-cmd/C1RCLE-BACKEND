import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import { createTicketTier } from './models/event-catalog.js';

const base = {
  id: 'TIER-1',
  eventId: 'EVT-1',
  organizationId: 'ORG-1',
  name: 'General Admission',
  priceInPaise: 100_000,
  quantity: 100,
};

describe('ticket tier extensions', () => {
  it('keeps legacy tiers valid with safe defaults', () => {
    const tier = createTicketTier(base);
    expect(tier.accessType).toBe('ENTRY');
    expect(tier.audienceType).toBe('GENERAL');
    expect(tier.guestCount).toBe(1);
    expect(tier.pricingPhases).toEqual([]);
  });

  it('rejects paid RSVP tickets', () => {
    expect(() => createTicketTier({ ...base, accessType: 'RSVP', priceInPaise: 1 })).toThrow(
      InvalidOperationError,
    );
  });

  it('rejects overlapping pricing phases', () => {
    expect(() =>
      createTicketTier({
        ...base,
        pricingPhases: [
          {
            id: 'P1',
            name: 'Phase 1',
            priceInPaise: 90_000,
            startsAt: '2026-01-01T00:00:00.000Z',
            endsAt: '2026-01-10T00:00:00.000Z',
            quantity: null,
          },
          {
            id: 'P2',
            name: 'Phase 2',
            priceInPaise: 110_000,
            startsAt: '2026-01-09T00:00:00.000Z',
            endsAt: '2026-01-20T00:00:00.000Z',
            quantity: null,
          },
        ],
      }),
    ).toThrow(InvalidOperationError);
  });

  it('requires table configuration for table tickets', () => {
    expect(() => createTicketTier({ ...base, accessType: 'TABLE' })).toThrow(InvalidOperationError);
  });
});
