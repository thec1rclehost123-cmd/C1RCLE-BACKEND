import { describe, expect, it } from 'vitest';

import {
  adminResolveDispute,
  beginReview,
  createDispute,
  resolveDispute,
} from './models/dispute.js';

import type { DisputeCreateInput } from './models/dispute.js';

function input(overrides: Partial<DisputeCreateInput> = {}): DisputeCreateInput {
  return {
    organizationId: 'org_1',
    orderId: 'order_1',
    raisedBy: 'user_1',
    reason: 'Payout amount does not match the ticket count',
    amount: 5_000,
    now: new Date('2026-09-07T00:00:00.000Z'),
    ...overrides,
  };
}

describe('createDispute', () => {
  it('creates an open dispute', () => {
    const d = createDispute(input());
    expect(d.status).toBe('open');
    expect(d.version).toBe(1);
    expect(d.ledgerEntryId).toBeNull();
    expect(d.resolutionNote).toBeNull();
  });

  it('carries an optional ledgerEntryId', () => {
    const d = createDispute(input({ ledgerEntryId: 'led_1' }));
    expect(d.ledgerEntryId).toBe('led_1');
  });

  it('rejects a non-positive amount', () => {
    expect(() => createDispute(input({ amount: 0 }))).toThrow(/positive/);
    expect(() => createDispute(input({ amount: -1 }))).toThrow(/positive/);
  });
});

describe('dispute FSM', () => {
  it('open -> under_review -> resolved is legal', () => {
    const open = createDispute(input());
    const reviewing = beginReview(open);
    expect(reviewing.status).toBe('under_review');
    const resolved = resolveDispute(reviewing, 'Refund issued to the venue');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionNote).toBe('Refund issued to the venue');
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it('open -> resolved is legal (review is optional)', () => {
    const open = createDispute(input());
    const resolved = resolveDispute(open, 'Dismissed — amount was correct');
    expect(resolved.status).toBe('resolved');
  });

  it('cannot begin review on a dispute that is already under_review', () => {
    const reviewing = beginReview(createDispute(input()));
    expect(() => beginReview(reviewing)).toThrow(/not open/);
  });

  it('cannot resolve a dispute that is already resolved', () => {
    const resolved = resolveDispute(createDispute(input()), 'done');
    expect(() => resolveDispute(resolved, 'again')).toThrow(/already resolved/);
  });
});

describe('adminResolveDispute', () => {
  it('records the outcome, unlike the partner-side resolveDispute', () => {
    const open = createDispute(input());
    const resolved = adminResolveDispute(open, 'upheld', 'Confirmed short payout', new Date());
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('upheld');
  });

  it('denied leaves the same terminal state, just a different outcome', () => {
    const open = createDispute(input());
    const resolved = adminResolveDispute(open, 'denied', 'Amount was correct', new Date());
    expect(resolved.resolution).toBe('denied');
  });

  it('refuses to resolve a dispute that is already resolved', () => {
    const resolved = adminResolveDispute(createDispute(input()), 'upheld', 'done', new Date());
    expect(() => adminResolveDispute(resolved, 'denied', 'again', new Date())).toThrow(
      /already resolved/,
    );
  });

  it('the partner-side resolveDispute never sets a resolution outcome', () => {
    const resolved = resolveDispute(createDispute(input()), 'Dismissed');
    expect(resolved.resolution).toBeNull();
  });
});
