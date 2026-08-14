import { describe, expect, it } from 'vitest';

import { InvalidOperationError, StateTransitionError } from './errors.js';
import {
  PROMOTER_COMMISSION_TIERS,
  approvePartnership,
  blockPartnership,
  commissionPaise,
  commissionTierFor,
  counterpartyOf,
  createPartnership,
  endPartnership,
  isLive,
  rejectPartnership,
} from './models/partnership.js';

/**
 * ─── Partnership graph + commission tiers (Phase 1) ──────────────────────────
 * Ported from v1 `routes/v1/partnerships.ts` and `lib/rbac-permissions.ts`.
 * The v1 behaviour is the specification; the typed FSM is the implementation.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');
const HOST = 'org_host';
const VENUE = 'org_venue';

const request = (initiatedBy: 'host' | 'venue' = 'host') =>
  createPartnership({
    id: 'ptn_1',
    hostOrganizationId: HOST,
    venueOrganizationId: VENUE,
    venueId: 'ven_1',
    initiatedBy,
    now: NOW,
  });

describe('partnership lifecycle', () => {
  it('starts pending and counts as live', () => {
    const partnership = request();
    expect(partnership.status).toBe('pending');
    expect(isLive(partnership)).toBe(true);
  });

  it('refuses a self-partnership — there would be no counterparty to approve', () => {
    expect(() =>
      createPartnership({
        id: 'ptn_x',
        hostOrganizationId: HOST,
        venueOrganizationId: HOST,
        venueId: 'ven_1',
        initiatedBy: 'host',
        now: NOW,
      }),
    ).toThrow(InvalidOperationError);
  });

  it('names the counterparty as the side that did not ask', () => {
    expect(counterpartyOf(request('host'))).toBe(VENUE);
    expect(counterpartyOf(request('venue'))).toBe(HOST);
  });

  it('lets the invited party approve', () => {
    const approved = approvePartnership(request('host'), VENUE, NOW);
    expect(approved.status).toBe('active');
    expect(approved.version).toBe(2);
    expect(approved.resolvedAt).toBe(NOW.toISOString());
  });

  it('refuses to let the REQUESTER approve their own request', () => {
    // v1 only checked "are you a party", which allowed exactly this.
    expect(() => approvePartnership(request('host'), HOST, NOW)).toThrow(InvalidOperationError);
  });

  it('records a rejection reason so the other side learns why', () => {
    const rejected = rejectPartnership(request('host'), VENUE, 'Fully booked', NOW);
    expect(rejected).toMatchObject({ status: 'rejected', resolutionReason: 'Fully booked' });
    expect(isLive(rejected)).toBe(false);
  });

  it('lets EITHER party block, unlike approve/reject', () => {
    expect(blockPartnership(request('host'), HOST, 'Spam', NOW).status).toBe('blocked');
    expect(blockPartnership(request('host'), VENUE, 'Spam', NOW).status).toBe('blocked');
  });

  it('refuses a block from an unrelated organization', () => {
    expect(() => blockPartnership(request(), 'org_stranger', undefined, NOW)).toThrow(
      InvalidOperationError,
    );
  });

  it('treats blocked as terminal — unblocking is a new request', () => {
    const blocked = blockPartnership(request(), VENUE, 'Spam', NOW);
    // Without this, a stray approve would silently undo a block.
    expect(() => approvePartnership(blocked, VENUE, NOW)).toThrow(StateTransitionError);
  });

  it('cannot revive a rejected partnership', () => {
    const rejected = rejectPartnership(request(), VENUE, undefined, NOW);
    expect(() => approvePartnership(rejected, VENUE, NOW)).toThrow(StateTransitionError);
  });

  it('ends an active partnership without treating it as punishment', () => {
    const active = approvePartnership(request(), VENUE, NOW);
    const ended = endPartnership(active, HOST, NOW);
    expect(ended.status).toBe('ended');
    expect(isLive(ended)).toBe(false);
  });

  it('cannot end something that was never active', () => {
    expect(() => endPartnership(request(), HOST, NOW)).toThrow(StateTransitionError);
  });
});

describe('promoter commission tiers', () => {
  it('matches the v1 table exactly', () => {
    expect(PROMOTER_COMMISSION_TIERS).toEqual([
      { threshold: 0, rate: 10, label: 'Base' },
      { threshold: 10, rate: 12, label: 'Silver' },
      { threshold: 25, rate: 15, label: 'Gold' },
      { threshold: 50, rate: 18, label: 'Platinum' },
      { threshold: 100, rate: 20, label: 'Diamond' },
    ]);
  });

  it('awards the highest tier at or below the volume', () => {
    expect(commissionTierFor(0).label).toBe('Base');
    expect(commissionTierFor(9).label).toBe('Base');
    expect(commissionTierFor(10).label).toBe('Silver');
    expect(commissionTierFor(24).label).toBe('Silver');
    expect(commissionTierFor(25).label).toBe('Gold');
    expect(commissionTierFor(99).label).toBe('Platinum');
    expect(commissionTierFor(100).label).toBe('Diamond');
    expect(commissionTierFor(10_000).label).toBe('Diamond');
  });

  it('treats nonsense volume as zero rather than throwing mid-payout', () => {
    expect(commissionTierFor(-5).label).toBe('Base');
    expect(commissionTierFor(Number.NaN).label).toBe('Base');
  });

  it('computes commission in paise at the earned rate', () => {
    // 10% of ₹1000 at Base.
    expect(commissionPaise(100_000, 0)).toBe(10_000);
    // 20% of ₹1000 at Diamond.
    expect(commissionPaise(100_000, 100)).toBe(20_000);
  });

  it('rounds DOWN, so the platform never pays out money it did not collect', () => {
    // 10% of 999 paise is 99.9 — rounding up would overpay on every order.
    expect(commissionPaise(999, 0)).toBe(99);
  });

  it('returns zero for a non-positive or nonsense gross', () => {
    expect(commissionPaise(0, 50)).toBe(0);
    expect(commissionPaise(-100, 50)).toBe(0);
    expect(commissionPaise(Number.NaN, 50)).toBe(0);
  });
});
