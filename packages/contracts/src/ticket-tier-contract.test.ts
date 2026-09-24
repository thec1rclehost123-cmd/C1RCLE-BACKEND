import { describe, expect, it } from 'vitest';

import { createTicketTierSchema, ticketTierDtoSchema } from './contracts/event.js';

const phase = {
  id: 'PHASE-1',
  name: 'Early Bird',
  priceInPaise: 99_900,
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-02-01T00:00:00.000Z',
  quantity: 50,
};

describe('ticket-tier wire contracts', () => {
  it('accepts the full club-event ticket configuration', () => {
    const result = createTicketTierSchema.safeParse({
      name: 'VIP Couple',
      description: 'Priority entry and drinks',
      entryType: 'vip',
      priceInPaise: 249_900,
      quantity: 20,
      accessType: 'VIP',
      audienceType: 'COUPLE',
      guestCount: 2,
      pricingPhases: [phase],
      doorPriceInPaise: 299_900,
      benefits: ['Entry', 'Drinks'],
      minAge: 21,
      maxPerOrder: 2,
      maxPerUser: 4,
      commissionEligible: true,
    });

    expect(result.success).toBe(true);
  });

  it('accepts legacy ticket-tier requests without new dimensions', () => {
    expect(
      createTicketTierSchema.safeParse({
        name: 'General Admission',
        priceInPaise: 100_000,
        quantity: 100,
      }).success,
    ).toBe(true);
  });

  it('rejects invalid access, audience, and phase values', () => {
    const result = createTicketTierSchema.safeParse({
      name: 'Invalid',
      priceInPaise: -1,
      quantity: 0,
      accessType: 'VIP_COUPLE_PHASE_2',
      audienceType: 'EVERYONE',
      guestCount: 0,
      pricingPhases: [{ ...phase, priceInPaise: -1 }],
    });

    expect(result.success).toBe(false);
  });

  it('allows old DTO documents with omitted optional extensions', () => {
    const result = ticketTierDtoSchema.safeParse({
      id: 'TIER-1',
      eventId: 'EVT-1',
      organizationId: 'ORG-1',
      name: 'Legacy',
      description: '',
      entryType: 'general',
      currency: 'INR',
      priceInPaise: 100_000,
      quantity: 10,
      status: 'active',
      salesStartAt: null,
      salesEndAt: null,
      maxPerOrder: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
  });
});
