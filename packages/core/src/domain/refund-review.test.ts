import { describe, expect, it } from 'vitest';

import { refundReviewEligibility } from './models/refund-review.js';

import type { Entitlement } from './models/entitlement.js';
import type { Event } from './models/event.js';
import type { Order } from './models/order.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const event = {
  id: 'event',
  status: 'published',
  refundPolicy: { kind: 'organizer_reviewed' },
} as Event;
const order = {
  id: 'order',
  eventId: 'event',
  userId: 'purchaser',
  grandTotalPaise: 10_000,
  status: 'paid',
  createdAt: '2026-11-01T00:00:00.000Z',
} as Order;
const ticket = {
  id: 'ticket',
  eventId: 'event',
  orderId: 'order',
  status: 'valid',
  scanCount: 0,
  unitKind: 'paid',
} as Entitlement;
const eligible = (e = event, o = order, t = ticket, user = 'purchaser') =>
  refundReviewEligibility(e, o, t, user, now);
describe('standardized Guest refund review policy', () => {
  it('permits organizer review without granting an automatic refund', () =>
    expect(eligible()).toEqual({ allowed: true, reason: null }));
  it('honors no-refund and exact request cutoff boundaries', () => {
    expect(eligible({ ...event, refundPolicy: { kind: 'no_refunds' } }).allowed).toBe(false);
    expect(
      eligible({ ...event, refundPolicy: { kind: 'until_cutoff', cutoffAt: now.toISOString() } })
        .allowed,
    ).toBe(false);
    expect(
      eligible({
        ...event,
        refundPolicy: { kind: 'until_cutoff', cutoffAt: '2026-11-04T12:00:00.001Z' },
      }).allowed,
    ).toBe(true);
  });
  it('preserves cancellation/postponement/material-change remedies despite ordinary policy', () => {
    const noRefund = { ...event, refundPolicy: { kind: 'no_refunds' as const } };
    expect(eligible({ ...noRefund, status: 'cancelled' }).allowed).toBe(true);
    expect(eligible({ ...noRefund, status: 'postponed' }).allowed).toBe(true);
    expect(
      eligible({ ...noRefund, lastMaterialChangeAt: '2026-11-02T00:00:00.000Z' }).allowed,
    ).toBe(true);
    expect(
      eligible({ ...noRefund, lastMaterialChangeAt: '2026-10-31T00:00:00.000Z' }).allowed,
    ).toBe(false);
  });
  it('rejects stranger, already-used, locked and Free RSVP requests', () => {
    expect(eligible(event, order, ticket, 'stranger').allowed).toBe(false);
    expect(eligible(event, order, { ...ticket, scanCount: 1 }).allowed).toBe(false);
    expect(
      eligible(event, order, {
        ...ticket,
        refundLock: { refundRequestId: 'ref', frozenAt: now.toISOString() },
      }).allowed,
    ).toBe(false);
    expect(eligible(event, order, { ...ticket, unitKind: 'free_rsvp' }).allowed).toBe(false);
  });
});
