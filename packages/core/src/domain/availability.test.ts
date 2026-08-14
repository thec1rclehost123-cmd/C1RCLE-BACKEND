import { describe, expect, it } from 'vitest';

import { computeVenueAvailability } from './models/venue.js';

import type { VenueSlot, VenueSlotStatus } from './models/venue.js';

/**
 * ─── Venue availability ──────────────────────────────────────────────────────
 * A derivation over calendar slots, not stored state — Phase 0 left this
 * unbuilt because "no distinct availability computation exists beyond the
 * calendar's raw slot list." This is that computation.
 */

const slot = (
  id: string,
  status: VenueSlotStatus,
  startTime = '2026-09-01T18:00:00.000Z',
  endTime = '2026-09-01T20:00:00.000Z',
): VenueSlot => ({
  id,
  venueId: 'ven_1',
  label: `Slot ${id}`,
  startTime,
  endTime,
  recurring: false,
  status,
  capacityFor: null,
  version: 1,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z',
});

const compute = (slots: VenueSlot[]) =>
  computeVenueAvailability({
    venueId: 'ven_1',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-02T00:00:00.000Z',
    slots,
  });

describe('computeVenueAvailability', () => {
  it('counts each status separately', () => {
    const result = compute([
      slot('a', 'open'),
      slot('b', 'open'),
      slot('c', 'booked'),
      slot('d', 'blocked'),
    ]);

    expect(result).toMatchObject({
      openSlots: 2,
      bookedSlots: 1,
      blockedSlots: 1,
      fullyBooked: false,
    });
  });

  it('sums bookable minutes across open slots only', () => {
    const result = compute([
      slot('a', 'open', '2026-09-01T18:00:00.000Z', '2026-09-01T20:00:00.000Z'), // 120
      slot('b', 'open', '2026-09-01T21:00:00.000Z', '2026-09-01T21:30:00.000Z'), // 30
      slot('c', 'booked', '2026-09-01T22:00:00.000Z', '2026-09-02T02:00:00.000Z'), // ignored
    ]);

    expect(result.openMinutes).toBe(150);
  });

  it('excludes cancelled slots entirely rather than counting them as taken', () => {
    const result = compute([slot('a', 'open'), slot('b', 'cancelled')]);

    // A cancelled slot no longer exists; it is not "unavailable".
    expect(result.slots).toHaveLength(1);
    expect(result.openSlots).toBe(1);
    expect(result.bookedSlots).toBe(0);
    expect(result.blockedSlots).toBe(0);
  });

  it('reports fullyBooked when slots exist but none are open', () => {
    expect(compute([slot('a', 'booked'), slot('b', 'blocked')]).fullyBooked).toBe(true);
  });

  it('does NOT report fullyBooked for an empty window', () => {
    // Nothing published is a different answer from "everything is taken", and
    // conflating them would tell a host their venue is busy when it is blank.
    const result = compute([]);
    expect(result.fullyBooked).toBe(false);
    expect(result.openSlots).toBe(0);
  });

  it('treats an inverted or unparseable range as zero minutes, not negative', () => {
    const inverted = compute([
      slot('a', 'open', '2026-09-01T22:00:00.000Z', '2026-09-01T20:00:00.000Z'),
    ]);
    const nonsense = compute([slot('b', 'open', 'not-a-date', 'also-not')]);

    expect(inverted.openMinutes).toBe(0);
    expect(nonsense.openMinutes).toBe(0);
  });

  it('echoes the requested window so a cached body is self-describing', () => {
    const result = compute([slot('a', 'open')]);
    expect(result).toMatchObject({
      venueId: 'ven_1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z',
    });
  });
});
