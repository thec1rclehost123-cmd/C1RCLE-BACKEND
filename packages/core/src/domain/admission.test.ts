import { describe, expect, it } from 'vitest';

import { admitSeats, evaluateAdmission } from './models/entitlement.js';

import type { Entitlement } from './models/entitlement.js';

/**
 * The admission rule is the single most load-bearing piece of the door: both
 * storage adapters run it inside their own atomic section, and the read-only
 * preview runs it too. These tests pin it directly, independent of either
 * adapter, so a change that quietly loosens it fails here first.
 */

const T0 = new Date('2026-09-15T21:00:00.000Z');

function ticket(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: 'ENT-1',
    orderId: 'ord_1',
    eventId: 'evt_1',
    organizationId: 'org_1',
    tierId: 'tier_1',
    tierName: 'General',
    userId: 'guest_1',
    holderName: 'Ada Guest',
    status: 'valid',
    scanCountAllowed: 1,
    scanCount: 0,
    scannedAt: [],
    version: 1,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...overrides,
  };
}

describe('evaluateAdmission', () => {
  it('admits a valid, unused ticket for the right event', () => {
    expect(evaluateAdmission(ticket(), 'evt_1')).toMatchObject({
      admitted: true,
      denyReason: null,
      scansUsed: 0,
      scansAllowed: 1,
    });
  });

  it('treats a missing ticket as an unverifiable QR, not as a known-bad one', () => {
    expect(evaluateAdmission(null, 'evt_1')).toMatchObject({
      admitted: false,
      denyReason: 'invalid_signature',
    });
  });

  it('answers wrong_event BEFORE looking at the other club’s ticket state', () => {
    // Ordering is the point: a scanner at venue B must not be able to learn
    // whether a venue-A ticket is valid, refunded, or already spent.
    const foreign = ticket({ eventId: 'evt_other', status: 'void', scanCount: 1 });
    const decision = evaluateAdmission(foreign, 'evt_1');
    expect(decision.denyReason).toBe('wrong_event');
    // And it discloses no counts from that tenant.
    expect(decision.scansUsed).toBe(0);
    expect(decision.scansAllowed).toBe(0);
  });

  it('refuses a voided ticket', () => {
    expect(evaluateAdmission(ticket({ status: 'void' }), 'evt_1')).toMatchObject({
      admitted: false,
      denyReason: 'void_ticket',
    });
  });

  it('refuses a fully used ticket', () => {
    expect(evaluateAdmission(ticket({ scanCount: 1, status: 'redeemed' }), 'evt_1')).toMatchObject({
      admitted: false,
      denyReason: 'already_used',
    });
  });
});

describe('admitSeats', () => {
  it('spends exactly one seat by default and returns the post-state to persist', () => {
    const claim = admitSeats(ticket({ scanCountAllowed: 2 }), 'evt_1', { now: T0 });
    expect(claim.admitted).toBe(true);
    expect(claim.entitlement?.scanCount).toBe(1);
    expect(claim.entitlement?.status).toBe('valid');
    expect(claim.entitlement?.scannedAt).toEqual([T0.toISOString()]);
  });

  it('redeems the ticket when the last seat is spent', () => {
    const claim = admitSeats(ticket({ scanCountAllowed: 2, scanCount: 1 }), 'evt_1', { now: T0 });
    expect(claim.entitlement?.status).toBe('redeemed');
  });

  it('spends both seats of a couple ticket in ONE decision', () => {
    // Not a loop of two claims: claiming twice would let the halves land
    // either side of a concurrent scan and admit three people on a
    // two-person ticket.
    const claim = admitSeats(ticket({ scanCountAllowed: 2 }), 'evt_1', { seats: 2, now: T0 });
    expect(claim.admitted).toBe(true);
    expect(claim.entitlement?.scanCount).toBe(2);
    expect(claim.entitlement?.status).toBe('redeemed');
  });

  it('refuses a multi-seat claim that would overrun, spending nothing', () => {
    const original = ticket({ scanCountAllowed: 2, scanCount: 1 });
    const claim = admitSeats(original, 'evt_1', { seats: 2 });
    expect(claim).toMatchObject({ admitted: false, denyReason: 'already_used' });
    // The caller must be able to persist nothing on a refusal.
    expect(claim.entitlement?.scanCount).toBe(1);
  });

  it('refuses when the ticket moved since the confirmation was requested', () => {
    // The couple-confirmation token is minted against a state a staff member
    // saw. If anything consumed a seat in between, confirming must fail
    // rather than admit against a moved target.
    const claim = admitSeats(ticket({ scanCountAllowed: 2, scanCount: 1 }), 'evt_1', {
      seats: 1,
      expectedScansUsed: 0,
    });
    expect(claim).toMatchObject({ admitted: false, denyReason: 'already_used' });
  });

  it('admits when the expected state still holds', () => {
    const claim = admitSeats(ticket({ scanCountAllowed: 2 }), 'evt_1', {
      seats: 2,
      expectedScansUsed: 0,
    });
    expect(claim.admitted).toBe(true);
    expect(claim.entitlement?.scanCount).toBe(2);
  });

  it('never spends a seat on a ticket it refuses', () => {
    for (const bad of [
      ticket({ status: 'void' }),
      ticket({ eventId: 'evt_other' }),
      ticket({ scanCount: 1, status: 'redeemed' }),
    ]) {
      const claim = admitSeats(bad, 'evt_1');
      expect(claim.admitted).toBe(false);
      expect(claim.entitlement?.scanCount).toBe(bad.scanCount);
    }
  });
});
