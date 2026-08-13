import { describe, expect, it } from 'vitest';

import { createPromoCode, createTicketTier } from '../../src/domain/models/event-catalog.js';
import { createEvent } from '../../src/domain/models/event.js';
import { createOrganization } from '../../src/domain/models/organization.js';
import { createVenue } from '../../src/domain/models/venue.js';

/**
 * V1 parity guard (B12)
 * --------------------
 * Builds real model instances and locks the field names that the previous
 * production backend proved (see docs/reference/V1_TO_V2_PARITY.md).
 * A silent rename here breaks CI loudly instead of shipping a migration gap
 * in the Firestore adapter.
 */
describe('V1 parity guard — proven field names are locked on V2 models', () => {
  it('PromoCode keeps V1-proven promo-service.js field names', () => {
    const promo = createPromoCode({
      id: 'prm_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      code: 'VIP20',
      name: 'VIP 20% off',
      type: 'single_use',
      discountType: 'percent',
      discountValue: 20,
      tierIds: ['tier_1'],
      maxRedemptions: 100,
      maxPerUser: 1,
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-31T23:59:59.000Z',
    });
    // promo-service.js reloaded docs by: maxRedemptions, redemptionCount,
    // startsAt, endsAt, tierIds, maxPerUser, type, name.
    expect(promo).toMatchObject({
      code: 'VIP20',
      name: 'VIP 20% off',
      type: 'single_use',
      discountType: 'percent',
      discountValue: 20,
      tierIds: ['tier_1'],
      maxRedemptions: 100,
      maxPerUser: 1,
      redemptionCount: 0,
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-31T23:59:59.000Z',
    });
  });

  it('TicketTier keeps V1-proven tier field names', () => {
    const tier = createTicketTier({
      id: 'tier_1',
      eventId: 'evt_1',
      organizationId: 'org_1',
      name: 'Early Bird',
      description: 'First 100',
      entryType: 'general',
      currency: 'INR',
      priceInPaise: 50_000,
      quantity: 100,
      minPerOrder: 1,
      maxPerOrder: 4,
      salesStartAt: '2026-08-01T00:00:00.000Z',
      salesEndAt: '2026-08-31T23:59:59.000Z',
    });
    // V1 tier doc: name, description, entryType, price, quantity,
    // minPerOrder, maxPerOrder, salesStart/salesEnd.
    expect(tier).toMatchObject({
      name: 'Early Bird',
      description: 'First 100',
      entryType: 'general',
      currency: 'INR',
      quantity: 100,
      minPerOrder: 1,
      maxPerOrder: 4,
      salesStartAt: '2026-08-01T00:00:00.000Z',
      salesEndAt: '2026-08-31T23:59:59.000Z',
    });
  });

  it('Organization settings keep V1 defaultCurrency', () => {
    const org = createOrganization({
      id: 'org_1',
      name: 'C1rcle Labs',
      slug: 'c1rcle-labs',
      ownerId: 'usr_1',
      settings: { defaultCurrency: 'INR' },
    });
    expect(org.settings).toMatchObject({ defaultCurrency: 'INR' });
  });

  it('Event keeps V1-proven slug surface', () => {
    const event = createEvent({
      id: 'evt_1',
      organizationId: 'org_1',
      venueId: 'ven_1',
      title: 'Headliner Night',
      startAt: '2026-08-01T18:00:00.000Z',
    });
    expect(event.slug).toBe('headliner-night');
  });

  it('Venue create accepts the V1-proven create fields (description/capacity/city)', () => {
    const venue = createVenue({
      id: 'ven_1',
      organizationId: 'org_1',
      ownerId: 'usr_1',
      name: 'Skyline Rooftop',
      slug: 'skyline-rooftop',
      description: 'Open-air rooftop',
      capacity: 500,
      city: 'Mumbai',
    });
    expect(venue.public).toMatchObject({
      description: 'Open-air rooftop',
      capacity: 500,
      address: { city: 'Mumbai' },
    });
  });
});
