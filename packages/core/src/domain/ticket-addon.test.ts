import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import { createTicketAddon, updateTicketAddon } from './models/ticket-addon.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

function addon() {
  return createTicketAddon({
    id: 'ADDON-parking',
    eventId: 'EVT-1',
    organizationId: 'ORG-1',
    name: 'Parking pass',
    kind: 'parking',
    priceInPaise: 50000,
    quantity: 120,
    now: NOW,
  });
}

describe('ticket add-on catalog product', () => {
  it('creates a versioned, INR non-cover product with a per-admission limit', () => {
    expect(addon()).toMatchObject({
      id: 'ADDON-parking',
      eventId: 'EVT-1',
      kind: 'parking',
      currency: 'INR',
      priceInPaise: 50000,
      quantity: 120,
      maxPerEntitlement: 1,
      status: 'active',
      version: 1,
    });
  });

  it.each([
    { priceInPaise: 0 },
    { priceInPaise: 1.2 },
    { quantity: -1 },
    { quantity: 1.1 },
    { maxPerEntitlement: 0 },
    { maxPerEntitlement: 11 },
    { salesStartAt: 'not-a-date' },
    { salesStartAt: '2026-10-29T12:00:00.000Z', salesEndAt: '2026-10-28T12:00:00.000Z' },
  ])('rejects invalid catalog values %#', (changes) => {
    expect(() => createTicketAddon({ ...addon(), ...changes })).toThrow(InvalidOperationError);
  });

  it('versions price and quantity changes without changing product identity or type', () => {
    const updated = updateTicketAddon(
      addon(),
      { priceInPaise: 65000, quantity: 100 },
      new Date('2026-10-28T13:00:00.000Z'),
    );
    expect(updated).toMatchObject({
      id: 'ADDON-parking',
      eventId: 'EVT-1',
      kind: 'parking',
      priceInPaise: 65000,
      quantity: 100,
      version: 2,
      updatedAt: '2026-10-28T13:00:00.000Z',
    });
  });
});
