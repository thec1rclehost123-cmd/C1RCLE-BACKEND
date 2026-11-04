import { describe, expect, it } from 'vitest';

import { InvalidOperationError } from './errors.js';
import {
  acceptEventCoverPolicy,
  captureEventCoverReservation,
  createEventCoverAccount,
  eventCoverAccountId,
  freezeUnusedEventCoverForRefund,
  isEventCoverPolicyAccepted,
  proposeEventCoverPolicy,
  reconcileEventCoverAccount,
  reserveEventCover,
  reverseEventCoverCapture,
  transferEventCoverHolder,
  refundUnusedEventCover,
  voidEventCoverReservation,
} from './models/event-cover.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

function makeCoverProposal(termsOverrides: Record<string, unknown> = {}) {
  return proposeEventCoverPolicy({
    id: 'cover-policy-proposal-1',
    hostOrganizationId: 'host-1',
    venueOrganizationId: 'venue-1',
    proposedByUserId: 'host-admin-1',
    policyVersion: 'm5-cover-fixture-v1',
    terms: {
      eventId: 'event-1',
      venueOrganizationId: 'venue-1',
      merchantOrganizationId: 'merchant-1',
      coverAmountPaise: 150_000,
      minimumSpendPaise: 50_000,
      redemptionOpensAt: '2026-11-01T18:00:00.000Z',
      redemptionClosesAt: '2026-11-02T02:00:00.000Z',
      eligibleCategories: ['food', 'non-alcoholic'],
      excludedCategories: ['alcohol'],
      alcoholRule: 'exclude_alcohol',
      partialRedemption: true,
      splitTender: true,
      refundPolicy: 'unused_full_before_redemption',
      transferUnusedOnly: true,
      commissionBasis: 'net_admission_after_allocated_discount',
      unusedBalancePolicy: 'approved_minimum_spend_expiry',
      ...termsOverrides,
    },
    now: NOW,
  });
}

function makeAccount(overrides: Partial<Parameters<typeof createEventCoverAccount>[0]> = {}) {
  return createEventCoverAccount({
    entitlementId: 'entitlement-1',
    orderId: 'order-1',
    eventId: 'event-1',
    guestUserId: 'guest-1',
    hostOrganizationId: 'host-1',
    venueOrganizationId: 'venue-1',
    amountPaise: 150_000,
    providerCaptureConfirmed: true,
    merchantApproved: true,
    policyVersion: 'fixture-cover-v1',
    refundPolicy: 'unused_full_before_redemption',
    activationApproved: true,
    now: NOW,
    ...overrides,
  });
}

describe('M5 event cover account', () => {
  it('moves unused cover with the ticket and refuses to move an active reservation', () => {
    const account = makeAccount();
    const transferred = transferEventCoverHolder(account, 'guest-1', 'guest-2', NOW);
    expect(transferred).toMatchObject({
      guestUserId: 'guest-2',
      remainingPaise: account.remainingPaise,
      redeemedPaise: account.redeemedPaise,
    });

    const reserved = reserveEventCover(account, {
      amountPaise: 10_000,
      operationId: 'pending-operation',
      guestConfirmed: false,
      authorizationOnly: true,
      online: true,
      actorUserId: 'venue-operator',
      terminalId: 'terminal-1',
      receiptReference: 'receipt-1',
      now: NOW,
    }).account;
    expect(() => transferEventCoverHolder(reserved, 'guest-1', 'guest-2', NOW)).toThrow(
      /redemption is locked/,
    );

    expect(() =>
      transferEventCoverHolder({ ...account, redeemedPaise: 1 }, 'guest-1', 'guest-2', NOW),
    ).toThrow(/redemption is locked/);
  });

  it('refunds only the full unused balance allowed by the frozen policy', () => {
    const account = makeAccount();
    const refundRequestId = 'refund-request-1';
    const frozen = freezeUnusedEventCoverForRefund(account, refundRequestId, NOW);
    const result = refundUnusedEventCover(frozen, {
      operationId: 'refund-request-1',
      actorUserId: 'finance-reviewer-1',
      refundRequestId,
      now: NOW,
    });
    expect(result.account).toMatchObject({
      status: 'refunded',
      issuedPaise: 150_000,
      remainingPaise: 0,
      reservedPaise: 0,
      redeemedPaise: 0,
      refundedPaise: 150_000,
    });
    expect(result.entry).toMatchObject({
      type: 'refund',
      amountPaise: 150_000,
      operationId: 'refund-request-1',
      reversesEntryId: expect.stringMatching(/^ECE-/),
    });
    expect(() =>
      freezeUnusedEventCoverForRefund(
        makeAccount({ refundPolicy: 'saved_policy_review' }),
        'refund-request-2',
        NOW,
      ),
    ).toThrow(/manual refund review/);
    expect(() =>
      freezeUnusedEventCoverForRefund({ ...account, redeemedPaise: 1 }, 'refund-request-3', NOW),
    ).toThrow(/fully unused cover/);
  });

  it('requires Venue acceptance of the exact proposed policy version and terms digest', () => {
    const proposal = makeCoverProposal();
    const acceptance = acceptEventCoverPolicy({
      id: 'acceptance-1',
      proposal,
      acceptingVenueOrganizationId: 'venue-1',
      acceptedByUserId: 'venue-admin-1',
      now: NOW,
    });
    expect(isEventCoverPolicyAccepted(proposal, acceptance)).toBe(true);
    expect(
      isEventCoverPolicyAccepted(makeCoverProposal({ coverAmountPaise: 200_000 }), acceptance),
    ).toBe(false);
    expect(() =>
      acceptEventCoverPolicy({
        id: 'acceptance-2',
        proposal,
        acceptingVenueOrganizationId: 'other-venue',
        acceptedByUserId: 'other-user',
        now: NOW,
      }),
    ).toThrow('Only the participating Venue');
  });

  it('creates a deterministic INR account linked to one entitlement and gates activation', () => {
    const first = makeAccount({ activationApproved: false });
    expect(first.id).toBe(eventCoverAccountId('entitlement-1'));
    expect(first.currency).toBe('INR');
    expect(first.entitlementId).toBe('entitlement-1');
    expect(first.remainingPaise).toBe(150_000);
    expect(first.status).toBe('pending_activation');
  });

  it.each([
    ['uncaptured payment', { providerCaptureConfirmed: false }],
    ['unapproved merchant', { merchantApproved: false }],
    ['unversioned policy', { policyVersion: ' ' }],
    ['fractional paise', { amountPaise: 100.5 }],
  ] as const)('rejects issuance for %s', (_label, overrides) => {
    expect(() => makeAccount(overrides)).toThrow(InvalidOperationError);
  });

  it('requires guest confirmation and online connectivity before reserving cover', () => {
    const account = makeAccount();
    const base = {
      amountPaise: 60_000,
      operationId: 'op-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'pos-rcpt-1',
      now: NOW,
    };
    expect(() => reserveEventCover(account, { ...base, guestConfirmed: false })).toThrow(
      'Guest confirmation',
    );
    expect(() => reserveEventCover(account, { ...base, online: false })).toThrow(
      'requires connectivity',
    );
  });

  it('reserves, captures once, and keeps split tender outside C1RCLE cover', () => {
    const account = makeAccount();
    const { account: reserved, entry: reservation } = reserveEventCover(account, {
      amountPaise: 60_000,
      operationId: 'op-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'pos-rcpt-1',
      now: NOW,
    });
    expect(reserved.reservedPaise).toBe(60_000);
    expect(reserved.remainingPaise - reserved.reservedPaise).toBe(90_000);

    const { account: captured, entry } = captureEventCoverReservation(
      reserved,
      reservation,
      [reservation],
      NOW,
    );
    expect(entry.type).toBe('capture');
    expect(captured.remainingPaise).toBe(90_000);
    expect(captured.redeemedPaise).toBe(60_000);
    expect(captured.reservedPaise).toBe(0);
    expect(() =>
      captureEventCoverReservation(captured, reservation, [reservation, entry], NOW),
    ).toThrow('already resolved');
  });

  it('voids an authorization without reducing the balance and blocks overdrafts', () => {
    const account = makeAccount();
    const { account: reserved, entry: reservation } = reserveEventCover(account, {
      amountPaise: 100_000,
      operationId: 'op-void',
      guestConfirmed: true,
      online: true,
      actorUserId: 'operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'pos-rcpt-2',
      now: NOW,
    });
    const { account: voided, entry } = voidEventCoverReservation(
      reserved,
      reservation,
      [reservation],
      NOW,
    );
    expect(entry.type).toBe('void');
    expect(voided.remainingPaise).toBe(150_000);
    expect(voided.reservedPaise).toBe(0);
    expect(() =>
      reserveEventCover(voided, {
        amountPaise: 150_001,
        operationId: 'op-too-large',
        guestConfirmed: true,
        online: true,
        actorUserId: 'operator-1',
        terminalId: 'terminal-1',
        receiptReference: 'pos-rcpt-3',
        now: NOW,
      }),
    ).toThrow('exceeds the available');
    expect(() => voidEventCoverReservation(voided, reservation, [reservation, entry], NOW)).toThrow(
      'already resolved',
    );
  });

  it('reverses one captured redemption back to the Guest balance exactly once', () => {
    const account = makeAccount();
    const { account: reserved, entry: reservation } = reserveEventCover(account, {
      amountPaise: 20_000,
      operationId: 'op-reverse',
      guestConfirmed: true,
      online: true,
      actorUserId: 'operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'pos-rcpt-reverse',
      now: NOW,
    });
    const { account: captured, entry: capture } = captureEventCoverReservation(
      reserved,
      reservation,
      [reservation],
      NOW,
    );
    const reversed = reverseEventCoverCapture(
      captured,
      capture,
      'finance-admin-1',
      'Duplicate venue capture reviewed',
      NOW,
    );

    expect(reversed.entry).toMatchObject({
      type: 'reversal',
      amountPaise: 20_000,
      operationId: capture.operationId,
      actorUserId: 'finance-admin-1',
      reversesEntryId: capture.id,
      reason: 'Duplicate venue capture reviewed',
    });
    expect(reversed.account).toMatchObject({
      remainingPaise: account.issuedPaise,
      redeemedPaise: 0,
    });
    expect(() =>
      reverseEventCoverCapture(
        reversed.account,
        capture,
        'finance-admin-1',
        'Duplicate venue capture reviewed',
        NOW,
      ),
    ).toThrow('Cover capture cannot be reversed');
  });

  it('rebuilds available, reserved and redeemed balances from ledger facts', () => {
    const account = makeAccount();
    const { account: reserved, entry: reservation } = reserveEventCover(account, {
      amountPaise: 60_000,
      operationId: 'op-reconcile',
      guestConfirmed: true,
      online: true,
      actorUserId: 'operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'pos-rcpt-reconcile',
      now: NOW,
    });
    const { account: captured, entry: capture } = captureEventCoverReservation(
      reserved,
      reservation,
      [reservation],
      NOW,
    );
    const issuance = {
      ...account,
      accountId: account.id,
      id: `ECE-${'0'.repeat(32)}`,
      type: 'issuance' as const,
      amountPaise: account.issuedPaise,
      operationId: account.entitlementId,
      actorUserId: null,
      terminalId: null,
      receiptReference: null,
      reversesEntryId: null,
    };
    const result = reconcileEventCoverAccount(captured, [capture, issuance, reservation]);
    expect(result).toMatchObject({
      balanced: true,
      expectedRemainingPaise: 90_000,
      expectedReservedPaise: 0,
      expectedRedeemedPaise: 60_000,
    });

    const mismatch = reconcileEventCoverAccount({ ...captured, remainingPaise: 89_999 }, [
      issuance,
      reservation,
      capture,
    ]);
    expect(mismatch.balanced).toBe(false);
    expect(mismatch.discrepancies).toContain('remaining balance differs from ledger facts');

    const reversal = {
      ...capture,
      id: 'ECE-reversal-fixture',
      type: 'reversal' as const,
      operationId: 'op-reconcile-reversal',
      reversesEntryId: capture.id,
    };
    const reversedAccount = {
      ...captured,
      remainingPaise: account.issuedPaise,
      redeemedPaise: 0,
    };
    const reversed = reconcileEventCoverAccount(reversedAccount, [
      issuance,
      reservation,
      capture,
      reversal,
    ]);
    expect(reversed).toMatchObject({
      balanced: true,
      expectedRemainingPaise: account.issuedPaise,
      expectedRedeemedPaise: 0,
    });

    const refund = {
      ...issuance,
      id: 'ECE-refund-fixture',
      type: 'refund' as const,
      amountPaise: 75_000,
      operationId: 'op-reconcile-refund',
      reversesEntryId: issuance.id,
    };
    const refunded = reconcileEventCoverAccount(
      {
        ...reversedAccount,
        remainingPaise: account.issuedPaise - refund.amountPaise,
        refundedPaise: refund.amountPaise,
        status: 'active',
      },
      [issuance, reservation, capture, reversal, refund],
    );
    expect(refunded).toMatchObject({
      balanced: true,
      expectedRemainingPaise: 75_000,
      expectedRefundedPaise: 75_000,
    });

    const overRefund = { ...refund, id: 'ECE-over-refund', amountPaise: 80_000 };
    const overRefundResult = reconcileEventCoverAccount(
      {
        ...reversedAccount,
        remainingPaise: -5_000,
        refundedPaise: 155_000,
      },
      [issuance, reservation, capture, reversal, refund, overRefund],
    );
    expect(overRefundResult.balanced).toBe(false);
    expect(overRefundResult.discrepancies).toContain('ledger totals exceed the issued cover');
  });
});
