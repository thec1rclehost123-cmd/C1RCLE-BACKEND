import { describe, expect, it } from 'vitest';

import { createTicketTier, updateTicketTier } from './models/event-catalog.js';
import { committedTierQuantity } from './models/tier-inventory.js';

const now = new Date('2026-11-04T00:00:00.000Z');
describe('tier commitment accounting', () => {
  it('counts live sold/refund-locked and held units, ignoring released history', () => {
    const line = { tierId: 'one', quantity: 2 };
    const orders = [
      { status: 'paid', lines: [line] },
      { status: 'refund_requested', lines: [line] },
      { status: 'refunded', lines: [line] },
      { status: 'cancelled', lines: [line] },
      { status: 'paid', lines: [{ ...line, tierId: 'other' }] },
    ];
    const holds = [
      {
        status: 'active',
        expiresAt: '2026-11-04T00:01:00.000Z',
        lines: [{ ...line, guestCount: 3, admissionMode: 'per_person' }],
      },
      { status: 'active', expiresAt: now.toISOString(), lines: [line] },
      { status: 'released', expiresAt: '2026-11-04T00:01:00.000Z', lines: [line] },
    ];
    expect(committedTierQuantity('one', orders, holds, now)).toBe(10);
  });
  it('counts historical phase-unknown sales conservatively while excluding known regular sales', () => {
    const line = { tierId: 'one', quantity: 1 };
    const orders = [
      {
        status: 'paid',
        lines: [
          line,
          { ...line, pricingPhaseId: 'early' },
          { ...line, pricingPhaseId: 'late' },
          { ...line, pricingPhaseId: null },
        ],
      },
    ];
    expect(committedTierQuantity('one', orders, [], now, 'early')).toBe(2);
  });
  it('reopens sold-out tiers on an inventory increase but preserves a deliberate pause', () => {
    const tier = createTicketTier({
      id: 'one',
      eventId: 'event',
      organizationId: 'host',
      name: 'General',
      quantity: 10,
      priceInPaise: 1000,
      now,
    });
    expect(updateTicketTier({ ...tier, status: 'sold_out' }, { quantity: 20 }, now).status).toBe(
      'active',
    );
    expect(updateTicketTier({ ...tier, status: 'paused' }, { quantity: 20 }, now).status).toBe(
      'paused',
    );
  });
});

describe('Couple tier shape', () => {
  const input = {
    id: 'couple',
    eventId: 'event',
    organizationId: 'host',
    name: 'Couple',
    quantity: 10,
    priceInPaise: 1000,
    audienceType: 'COUPLE' as const,
    now,
  };
  it('keeps the canonical paired credential rather than independently issued seats', () => {
    expect(createTicketTier(input)).toMatchObject({ guestCount: 2, admissionMode: 'bundle' });
    expect(() => createTicketTier({ ...input, guestCount: 1 })).toThrow('entering together');
    expect(() =>
      createTicketTier({ ...input, guestCount: 2, admissionMode: 'per_person' }),
    ).toThrow('entering together');
  });
});
