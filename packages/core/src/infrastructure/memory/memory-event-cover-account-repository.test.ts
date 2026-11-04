import { describe, expect, it } from 'vitest';

import { newVersionedEntity } from '../../domain/identity.js';
import { createEventCoverAccount } from '../../domain/models/event-cover.js';

import { MemoryEventCoverAccountRepository } from './memory-event-cover-account-repository.js';

const account = createEventCoverAccount({
  entitlementId: 'ENT-cover-1',
  orderId: 'ORD-cover-1',
  eventId: 'EVT-cover-1',
  guestUserId: 'USR-cover-1',
  hostOrganizationId: 'ORG-host-1',
  venueOrganizationId: 'ORG-venue-1',
  amountPaise: 150_000,
  providerCaptureConfirmed: true,
  merchantApproved: true,
  policyVersion: 'fixture-cover-v1',
  refundPolicy: 'unused_full_before_redemption',
  activationApproved: true,
  now: new Date('2026-10-28T12:00:00.000Z'),
});

describe('MemoryEventCoverAccountRepository', () => {
  it('lists issued accounts by event with bounded pagination', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    const second = createEventCoverAccount({
      entitlementId: 'ENT-cover-2',
      orderId: 'ORD-cover-2',
      eventId: 'EVT-cover-1',
      guestUserId: 'USR-cover-2',
      hostOrganizationId: 'ORG-host-1',
      venueOrganizationId: 'ORG-venue-1',
      amountPaise: 25_000,
      providerCaptureConfirmed: true,
      merchantApproved: true,
      policyVersion: 'fixture-cover-v1',
      refundPolicy: 'unused_full_before_redemption',
      activationApproved: true,
      now: new Date('2026-10-28T12:01:00.000Z'),
    });
    await repository.createIssuedAccount(account);
    await repository.createIssuedAccount(second);

    const firstPage = await repository.listByEvent('EVT-cover-1', { limit: 1, cursor: null });
    expect(firstPage).toMatchObject({ total: 2, nextCursor: '1' });
    expect(firstPage.items).toHaveLength(1);
    const secondPage = await repository.listByEvent('EVT-cover-1', {
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage).toMatchObject({ total: 2, nextCursor: null });
    expect(secondPage.items).toHaveLength(1);
    await expect(repository.listByEvent('EVT-other', { limit: 10 })).resolves.toMatchObject({
      items: [],
      total: 0,
      nextCursor: null,
    });
  });

  it('reverses a captured redemption once and restores the available cover', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);
    await repository.reserve(account.id, {
      amountPaise: 20_000,
      operationId: 'cover-reversal-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'venue-operator-1',
      terminalId: 'terminal-1',
      receiptReference: 'receipt-reversal-1',
    });
    await repository.capture(account.id, 'cover-reversal-1');

    const reversed = await repository.reverseCapture(
      account.entitlementId,
      'cover-reversal-1',
      'finance-admin-1',
      'Duplicate venue capture reviewed',
    );
    const replay = await repository.reverseCapture(
      account.entitlementId,
      'cover-reversal-1',
      'finance-admin-1',
      'Duplicate venue capture reviewed',
    );

    expect(reversed.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.entry.id).toBe(reversed.entry.id);
    expect(replay.account).toMatchObject({
      remainingPaise: account.issuedPaise,
      redeemedPaise: 0,
    });
    await expect(
      repository.reverseCapture(
        account.entitlementId,
        'cover-reversal-1',
        'other-admin',
        'Duplicate venue capture reviewed',
      ),
    ).rejects.toThrow(/already used/);
    await expect(
      repository.reverseCapture(
        account.entitlementId,
        'cover-reversal-1',
        'finance-admin-1',
        'Different reviewed reason',
      ),
    ).rejects.toThrow(/already used/);
  });

  it('transfers the unused cover balance to the accepted ticket holder', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);

    await expect(
      repository.transferHolder(account.entitlementId, 'USR-cover-1', 'USR-cover-2'),
    ).resolves.toMatchObject({
      guestUserId: 'USR-cover-2',
      remainingPaise: account.remainingPaise,
      redeemedPaise: 0,
    });
  });

  it('writes one issuance fact and converges identical retries', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await expect(
      repository.createIssuedAccount({ ...account, remainingPaise: account.remainingPaise - 1 }),
    ).rejects.toThrow(/valid initial issuance/);
    await repository.createIssuedAccount(account);
    await repository.createIssuedAccount({ ...account, createdAt: '2026-10-28T12:01:00.000Z' });

    expect(await repository.getByEntitlement(account.entitlementId)).toEqual(account);
    expect(await repository.listEntries(account.id)).toMatchObject([
      { type: 'issuance', amountPaise: 150_000, policyVersion: 'fixture-cover-v1' },
    ]);
    await expect(
      repository.createIssuedAccount({ ...account, policyVersion: 'fixture-cover-v2' }),
    ).rejects.toThrow(/different issuance terms/);
  });

  it('atomically reserves once, captures once, and preserves a replayable receipt', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);
    const request = {
      amountPaise: 60_000,
      operationId: 'POS-operation-1',
      guestConfirmed: true,
      online: true,
      actorUserId: 'USR-operator-1',
      terminalId: 'TERM-1',
      receiptReference: 'POS-RECEIPT-1',
      now: new Date('2026-10-28T12:05:00.000Z'),
    };
    const reserved = await repository.reserve(account.id, request);
    const replayedReserve = await repository.reserve(account.id, request);
    expect(replayedReserve).toMatchObject({ replayed: true, entry: { id: reserved.entry.id } });

    const captured = await repository.capture(account.id, request.operationId);
    const replayedCapture = await repository.capture(account.id, request.operationId);
    expect(captured).toMatchObject({
      replayed: false,
      account: { remainingPaise: 90_000, reservedPaise: 0, redeemedPaise: 60_000 },
      entry: { type: 'capture', amountPaise: 60_000 },
    });
    expect(replayedCapture).toMatchObject({ replayed: true, entry: { id: captured.entry.id } });
    expect((await repository.listEntries(account.id)).map((entry) => entry.type)).toEqual([
      'issuance',
      'reserve',
      'capture',
    ]);
  });

  it('voids a reservation without reducing the cover balance and rejects capture after void', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);
    await repository.reserve(account.id, {
      amountPaise: 40_000,
      operationId: 'POS-operation-2',
      guestConfirmed: true,
      online: true,
      actorUserId: 'USR-operator-1',
      terminalId: 'TERM-1',
      receiptReference: 'POS-RECEIPT-2',
    });
    const voided = await repository.void(account.id, 'POS-operation-2');
    expect(voided.account).toMatchObject({ remainingPaise: 150_000, reservedPaise: 0 });
    await expect(repository.capture(account.id, 'POS-operation-2')).rejects.toThrow(
      /already resolved/,
    );
  });

  it('records one policy-permitted full unused refund and replays it idempotently', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);
    await repository.freezeForRefund([account.entitlementId], 'refund-request-1');
    const first = await repository.refundUnused(account.id, {
      operationId: 'refund-request-1',
      actorUserId: 'finance-reviewer-1',
      refundRequestId: 'refund-request-1',
      now: new Date('2026-10-28T12:12:00.000Z'),
    });
    const replay = await repository.refundUnused(account.id, {
      operationId: 'refund-request-1',
      actorUserId: 'finance-reviewer-1',
      refundRequestId: 'refund-request-1',
      now: new Date('2026-10-28T12:13:00.000Z'),
    });

    expect(first).toMatchObject({
      replayed: false,
      account: { status: 'refunded', remainingPaise: 0, refundedPaise: 150_000 },
      entry: {
        type: 'refund',
        amountPaise: 150_000,
        reversesEntryId: expect.stringMatching(/^ECE-/),
      },
    });
    expect(replay).toMatchObject({ replayed: true, entry: { id: first.entry.id } });
    await expect(
      repository.refundUnused(account.id, {
        operationId: 'refund-request-2',
        actorUserId: 'finance-reviewer-1',
        refundRequestId: 'refund-request-2',
      }),
    ).rejects.toThrow(/fully unused cover/);
  });

  it('requires the exact Guest confirmation and consumes the challenge only once', async () => {
    const repository = new MemoryEventCoverAccountRepository();
    await repository.createIssuedAccount(account);
    const now = new Date('2026-10-28T12:10:00.000Z');
    const challenge = {
      ...newVersionedEntity(now),
      id: 'COV-CHALLENGE-1',
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: 'USR-cover-1',
      initiatedByUserId: 'USR-operator-1',
      terminalId: 'TERM-1',
      amountPaise: 25_000,
      grossSpendPaise: 30_000,
      categories: ['food'],
      containsAlcohol: false,
      receiptReference: 'POS-RECEIPT-3',
      status: 'pending' as const,
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    await repository.createRedemptionChallenge(challenge);
    await expect(
      repository.confirmRedemptionChallenge(challenge.id, 'USR-other-guest', now),
    ).rejects.toThrow(/invalid or expired/);
    await repository.confirmRedemptionChallenge(challenge.id, 'USR-cover-1', now);
    const concurrent = await Promise.allSettled([
      repository.consumeConfirmedRedemption(challenge.id, 'USR-operator-1', now),
      repository.consumeConfirmedRedemption(challenge.id, 'USR-operator-1', now),
    ]);

    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const replay = await repository.consumeConfirmedRedemption(challenge.id, 'USR-operator-1', now);
    expect(replay.account).toMatchObject({ remainingPaise: 125_000, redeemedPaise: 25_000 });
    expect(await repository.getRedemptionChallenge(challenge.id)).toMatchObject({
      status: 'consumed',
    });
  });
});
