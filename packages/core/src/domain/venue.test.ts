import { describe, expect, it } from 'vitest';

import {
  cancelVenueBlock,
  createVenue,
  createVenueBlock,
  reinstateVenue,
  suspendVenue,
} from './models/venue.js';

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

describe('cancelVenueBlock', () => {
  it('cancels a block once and treats repeated cancellation as an idempotent no-op', () => {
    const blocked = createVenueBlock({
      id: 'block_1',
      venueId: 'venue_1',
      label: 'M3 test block',
      startTime: '2026-11-30T19:00:00.000Z',
      endTime: '2026-11-30T23:00:00.000Z',
      now: new Date('2026-10-22T00:00:00.000Z'),
    });
    const cancelled = cancelVenueBlock(blocked, new Date('2026-10-23T00:00:00.000Z'));

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.version).toBe(blocked.version + 1);
    expect(cancelVenueBlock(cancelled, new Date('2026-10-24T00:00:00.000Z'))).toBe(cancelled);
  });
});
