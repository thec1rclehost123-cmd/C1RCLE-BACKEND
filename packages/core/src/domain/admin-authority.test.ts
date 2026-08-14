import { describe, expect, it } from 'vitest';

import { ForbiddenError, InvalidOperationError } from './errors.js';
import {
  approveProposal,
  cancelProposal,
  canInitiate,
  isExecutable,
  proposeAction,
  rejectProposal,
  requiresDualControl,
  tierOf,
} from './models/admin-authority.js';

/**
 * ─── Tiered admin authority ──────────────────────────────────────────────────
 * Ported from v1 adminStore.js. Dual control is the part that matters: a
 * second signature is only meaningful if it belongs to a second person.
 */

const NOW = new Date('2026-08-13T10:00:00.000Z');

const proposal = (proposedBy = 'admin_a') =>
  proposeAction({
    id: 'prop_1',
    action: 'ADMIN_PROVISION',
    proposedBy,
    proposerRole: 'super',
    reason: 'New ops hire',
    now: NOW,
  });

describe('tiers', () => {
  it('classifies actions by consequence', () => {
    expect(tierOf('ONBOARDING_APPROVE')).toBe(2);
    expect(tierOf('PAYOUT_BATCH_RUN')).toBe(2);
    expect(tierOf('ADMIN_PROVISION')).toBe(3);
    expect(tierOf('PAYOUT_FREEZE')).toBe(3);
  });

  it('restricts TIER2 to senior roles', () => {
    for (const role of ['super', 'admin', 'ops', 'finance'] as const) {
      expect(canInitiate(role, 'FINANCIAL_REFUND')).toBe(true);
    }
    expect(canInitiate('support', 'FINANCIAL_REFUND')).toBe(false);
  });

  it('restricts TIER3 to super alone', () => {
    expect(canInitiate('super', 'COMMISSION_ADJUST')).toBe(true);
    for (const role of ['admin', 'ops', 'finance', 'support'] as const) {
      expect(canInitiate(role, 'COMMISSION_ADJUST')).toBe(false);
    }
  });

  it('requires dual control only at TIER3', () => {
    expect(requiresDualControl('ADMIN_PROVISION')).toBe(true);
    expect(requiresDualControl('ONBOARDING_APPROVE')).toBe(false);
  });
});

describe('proposing', () => {
  it('starts pending with the reason recorded', () => {
    expect(proposal()).toMatchObject({
      status: 'pending',
      proposedBy: 'admin_a',
      reason: 'New ops hire',
      resolvedBy: null,
    });
  });

  it('refuses a proposal from a role that cannot perform the action', () => {
    expect(() =>
      proposeAction({
        id: 'prop_x',
        action: 'ADMIN_PROVISION',
        proposedBy: 'admin_b',
        proposerRole: 'ops',
        reason: 'Trying it on',
        now: NOW,
      }),
    ).toThrow(ForbiddenError);
  });

  it('refuses to wrap a lower-tier action in dual control', () => {
    // Implying a second signature the system does not require would mislead
    // anyone reading the audit trail.
    expect(() =>
      proposeAction({
        id: 'prop_x',
        action: 'VENUE_SUSPEND',
        proposedBy: 'admin_a',
        proposerRole: 'super',
        reason: 'Not a TIER3 action',
        now: NOW,
      }),
    ).toThrow(InvalidOperationError);
  });

  it('requires a non-empty reason', () => {
    expect(() =>
      proposeAction({
        id: 'prop_x',
        action: 'PAYOUT_FREEZE',
        proposedBy: 'admin_a',
        proposerRole: 'super',
        reason: '   ',
        now: NOW,
      }),
    ).toThrow(InvalidOperationError);
  });
});

describe('dual control', () => {
  it('lets a DIFFERENT super admin approve', () => {
    const approved = approveProposal(proposal('admin_a'), {
      resolvedBy: 'admin_b',
      resolverRole: 'super',
      now: NOW,
    });

    expect(approved).toMatchObject({ status: 'approved', resolvedBy: 'admin_b' });
    expect(isExecutable(approved)).toBe(true);
  });

  it('refuses self-approval — the whole point of the second signature', () => {
    expect(() =>
      approveProposal(proposal('admin_a'), {
        resolvedBy: 'admin_a',
        resolverRole: 'super',
        now: NOW,
      }),
    ).toThrow(ForbiddenError);
  });

  it('refuses a resolver who lacks the authority themselves', () => {
    expect(() =>
      approveProposal(proposal('admin_a'), {
        resolvedBy: 'admin_b',
        resolverRole: 'ops',
        now: NOW,
      }),
    ).toThrow(ForbiddenError);
  });

  it('records a rejection reason and makes it unexecutable', () => {
    const rejected = rejectProposal(proposal(), {
      resolvedBy: 'admin_b',
      resolverRole: 'super',
      reason: 'Not justified',
      now: NOW,
    });

    expect(rejected).toMatchObject({ status: 'rejected', resolutionReason: 'Not justified' });
    expect(isExecutable(rejected)).toBe(false);
  });

  it('cannot resolve the same proposal twice', () => {
    const approved = approveProposal(proposal(), {
      resolvedBy: 'admin_b',
      resolverRole: 'super',
      now: NOW,
    });
    expect(() =>
      rejectProposal(approved, { resolvedBy: 'admin_c', resolverRole: 'super', now: NOW }),
    ).toThrow(InvalidOperationError);
  });

  it('lets only the proposer cancel', () => {
    expect(cancelProposal(proposal('admin_a'), 'admin_a', NOW).status).toBe('cancelled');
    expect(() => cancelProposal(proposal('admin_a'), 'admin_b', NOW)).toThrow(ForbiddenError);
  });
});
