import { describe, expect, it } from 'vitest';

import {
  acceptWaitlistOffer,
  createWaitlistEntry,
  expireWaitlistOffer,
  offerWaitlistEntry,
} from './waitlist-entry.js';

const joined = new Date('2026-10-28T12:00:00.000Z');
const expiresAt = '2026-10-28T12:15:00.000Z';

function entry() {
  return createWaitlistEntry({
    id: 'wait_1',
    eventId: 'event_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    userId: 'guest_1',
    sequence: 1,
    now: joined,
  });
}

describe('waitlist entry transitions', () => {
  it('binds an offer to a bounded reservation and accepts only for the same user in time', () => {
    const offered = offerWaitlistEntry(entry(), {
      reservationId: 'hold_1',
      expiresAt,
      now: joined,
    });
    expect(offered).toMatchObject({
      status: 'offered',
      offerReservationId: 'hold_1',
      offerExpiresAt: expiresAt,
    });
    expect(acceptWaitlistOffer(offered, { userId: 'guest_1', now: joined })).toMatchObject({
      status: 'accepted',
    });
    expect(() => acceptWaitlistOffer(offered, { userId: 'guest_2', now: joined })).toThrow(
      /another account/,
    );
    expect(() =>
      acceptWaitlistOffer(offered, { userId: 'guest_1', now: new Date(expiresAt) }),
    ).toThrow(/no longer active/);
  });

  it('expires an offer once and rejects premature expiry', () => {
    const offered = offerWaitlistEntry(entry(), {
      reservationId: 'hold_1',
      expiresAt,
      now: joined,
    });
    expect(() => expireWaitlistOffer(offered, joined)).toThrow(/not expired/);
    expect(expireWaitlistOffer(offered, new Date(expiresAt))).toMatchObject({ status: 'expired' });
    const accepted = acceptWaitlistOffer(offered, { userId: 'guest_1', now: joined });
    expect(expireWaitlistOffer(accepted, new Date(expiresAt))).toMatchObject({ status: 'expired' });
  });
});
