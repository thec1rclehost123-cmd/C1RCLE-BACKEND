import { describe, expect, it } from 'vitest';

import { createVenue, reinstateVenue, suspendVenue } from './models/venue.js';

import type { Venue } from './models/venue.js';

function venue(overrides: Partial<Venue> = {}): Venue {
  return {
    ...createVenue({
      id: 'venue_1',
      organizationId: 'org_1',
      ownerId: 'user_1',
      name: 'Skyline Rooftop',
      slug: 'skyline-rooftop',
      now: new Date('2026-09-11T00:00:00.000Z'),
    }),
    ...overrides,
  };
}

describe('suspendVenue / reinstateVenue', () => {
  it('suspends an active venue and bumps the version', () => {
    const before = venue({ status: 'active' });
    const after = suspendVenue(before, new Date());
    expect(after.status).toBe('suspended');
    expect(after.version).toBe(before.version + 1);
  });

  it('suspending an already-suspended venue is a no-op', () => {
    const before = venue({ status: 'suspended' });
    const after = suspendVenue(before, new Date());
    expect(after).toBe(before);
  });

  it('reinstates a suspended venue back to the literal "active" status', () => {
    const before = venue({ status: 'suspended' });
    const after = reinstateVenue(before, new Date());
    expect(after.status).toBe('active');
    expect(after.version).toBe(before.version + 1);
  });

  it('reinstating an already-active venue is a no-op', () => {
    const before = venue({ status: 'active' });
    const after = reinstateVenue(before, new Date());
    expect(after).toBe(before);
  });
});
