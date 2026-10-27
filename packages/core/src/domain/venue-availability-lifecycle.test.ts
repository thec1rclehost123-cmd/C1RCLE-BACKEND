import { describe, expect, it } from 'vitest';

import { createVenueAvailabilitySlot, setVenueSlotRequestState } from './models/venue.js';

const now = new Date('2026-10-23T00:00:00.000Z');

function offeredSlot() {
  return createVenueAvailabilitySlot({
    id: 'slot_m3_offer_1',
    venueId: 'venue_m3_1',
    label: 'M3-HOST-E2E availability',
    startTime: '2026-11-04T12:30:00.000Z',
    endTime: '2026-11-04T16:30:00.000Z',
    timezone: 'Asia/Kolkata',
    notes: 'Test-only offer',
    visibleToHostIds: ['host_m3_1'],
    now,
  });
}

describe('Venue availability lifecycle', () => {
  it('validates future bounded offers and persists timezone and visibility', () => {
    expect(offeredSlot()).toMatchObject({
      status: 'open',
      timezone: 'Asia/Kolkata',
      visibleToHostIds: ['host_m3_1'],
      notes: 'Test-only offer',
    });
    expect(() =>
      createVenueAvailabilitySlot({
        id: 'slot_m3_invalid',
        venueId: 'venue_m3_1',
        label: 'Invalid date',
        startTime: '2026-10-22T12:00:00.000Z',
        endTime: '2026-10-22T13:00:00.000Z',
        timezone: 'Asia/Kolkata',
        now,
      }),
    ).toThrow(/future/);
    expect(() =>
      createVenueAvailabilitySlot({
        id: 'slot_m3_timezone',
        venueId: 'venue_m3_1',
        label: 'Invalid timezone',
        startTime: '2026-11-04T12:30:00.000Z',
        endTime: '2026-11-04T13:30:00.000Z',
        timezone: 'Mars/Olympus',
        now,
      }),
    ).toThrow(/IANA timezone/);
  });

  it('moves open → pending → booked and rejects a second claimant', () => {
    const slot = offeredSlot();
    const pending = setVenueSlotRequestState(slot, 'pending', 'request_m3_1', 'host_m3_1', now);
    expect(pending).toMatchObject({ status: 'pending', slotRequestId: 'request_m3_1' });
    expect(() =>
      setVenueSlotRequestState(pending, 'pending', 'request_m3_2', 'host_m3_2', now),
    ).toThrow(/Only open availability/);
    const booked = setVenueSlotRequestState(pending, 'booked', 'request_m3_1', 'host_m3_1', now);
    expect(booked).toMatchObject({ status: 'booked', slotRequestId: 'request_m3_1' });
  });

  it('releases rejected requests and only cancels a booked reservation', () => {
    const pending = setVenueSlotRequestState(
      offeredSlot(),
      'pending',
      'request_m3_1',
      'host_m3_1',
      now,
    );
    const reopened = setVenueSlotRequestState(pending, 'open', null, null, now);
    expect(reopened).toMatchObject({ status: 'open', slotRequestId: null, requestingHostId: null });
    expect(() =>
      setVenueSlotRequestState(pending, 'cancelled', 'request_m3_1', 'host_m3_1', now),
    ).toThrow(/Only a booked slot/);
  });
});
