import { describe, expect, it } from 'vitest';

import {
  acceptEventCoverPolicy,
  createEventCoverAccount,
  proposeEventCoverPolicy,
} from '../../domain/models/event-cover.js';
import { createEvent } from '../../domain/models/event.js';
import { MemoryEventCoverAccountRepository } from '../../infrastructure/memory/memory-event-cover-account-repository.js';

import { EventCoverRedemptionService } from './event-cover-redemption-service.js';

import type { ActorContext } from '../context.js';

const now = new Date('2026-11-01T19:00:00.000Z');
const event = createEvent({
  id: 'event-1',
  organizationId: 'host-org',
  venueId: 'venue-1',
  title: 'Test Event',
  startAt: '2026-11-01T20:00:00.000Z',
  now,
});
const terms = {
  eventId: event.id,
  venueOrganizationId: 'venue-org',
  merchantOrganizationId: 'venue-org',
  coverAmountPaise: 15_000,
  minimumSpendPaise: 5_000,
  redemptionOpensAt: '2026-11-01T18:00:00.000Z',
  redemptionClosesAt: '2026-11-02T02:00:00.000Z',
  eligibleCategories: ['food'],
  excludedCategories: ['alcohol'],
  alcoholRule: 'exclude_alcohol' as const,
  partialRedemption: true,
  splitTender: true,
  refundPolicy: 'unused_full_before_redemption' as const,
  transferUnusedOnly: true as const,
  commissionBasis: 'net_admission_after_allocated_discount' as const,
  unusedBalancePolicy: 'approved_minimum_spend_expiry' as const,
};

function setup(options: { emailVerified?: boolean; pendingTransfer?: boolean } = {}) {
  let sequence = 0;
  const proposal = proposeEventCoverPolicy({
    id: 'proposal-1',
    hostOrganizationId: event.organizationId,
    venueOrganizationId: 'venue-org',
    proposedByUserId: 'host-user',
    policyVersion: 'cover-v1',
    terms,
    now,
  });
  const acceptance = acceptEventCoverPolicy({
    id: 'acceptance-1',
    proposal,
    acceptingVenueOrganizationId: 'venue-org',
    acceptedByUserId: 'venue-user',
    now,
  });
  const accounts = new MemoryEventCoverAccountRepository();
  const account = createEventCoverAccount({
    entitlementId: 'entitlement-1',
    orderId: 'order-1',
    eventId: event.id,
    guestUserId: 'guest-user',
    hostOrganizationId: event.organizationId,
    venueOrganizationId: 'venue-org',
    amountPaise: 15_000,
    providerCaptureConfirmed: true,
    merchantApproved: true,
    policyVersion: proposal.policyVersion,
    refundPolicy: proposal.terms.refundPolicy,
    activationApproved: true,
    now,
  });
  const service = new EventCoverRedemptionService({
    config: { clock: { now: () => now }, ids: () => `challenge-${++sequence}` },
    repositories: {
      eventCoverAccounts: accounts,
      eventCoverPolicies: {
        listProposalsByEvent: async () => [proposal],
        getAcceptance: async () => acceptance,
      },
      events: { getById: async () => event },
      venues: {
        getById: async () => ({ id: 'venue-1', organizationId: 'venue-org', status: 'active' }),
      },
      scannerDevices: {
        findByDevice: async () => ({ id: 'terminal-1', venueId: 'venue-1', status: 'active' }),
      },
      entitlements: {
        getById: async () => ({
          id: 'entitlement-1',
          purchaserUserId: 'purchaser-user',
          currentHolderUserId: 'guest-user',
          status: 'valid',
          ...(options.pendingTransfer ? { pendingTransferId: 'transfer-1' } : {}),
        }),
      },
      users: {
        getById: async () => ({ id: 'guest-user', emailVerified: options.emailVerified ?? true }),
      },
    },
  } as never);
  return { service, accounts, account };
}

const venueActor = {
  userId: 'venue-user',
  organizationId: 'venue-org',
  role: 'owner',
  capabilities: ['venue'],
} satisfies ActorContext;
const guestActor = {
  userId: 'guest-user',
  organizationId: 'guest-actor',
  role: 'member',
  capabilities: [],
} satisfies ActorContext;
const input = {
  entitlementId: 'entitlement-1',
  amountPaise: 4_000,
  grossSpendPaise: 6_000,
  categories: ['food'],
  containsAlcohol: false,
  receiptReference: 'receipt-1',
  terminalId: 'terminal-1',
};

describe('EventCoverRedemptionService', () => {
  it('requires Guest confirmation and captures the challenge once', async () => {
    const { service, accounts, account } = setup();
    await accounts.createIssuedAccount(account);
    const challenge = await service.createChallenge(venueActor, input);

    await expect(
      service.getChallengeForGuest({ ...guestActor, userId: 'other-guest' }, challenge.id),
    ).rejects.toThrow();
    await service.confirmChallenge(guestActor, challenge.id);
    const first = await service.consumeChallenge(venueActor, challenge.id);
    const replay = await service.consumeChallenge(venueActor, challenge.id);

    expect(first.entry.type).toBe('capture');
    expect(replay.entry.id).toBe(first.entry.id);
    await expect(accounts.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
      remainingPaise: 11_000,
      redeemedPaise: 4_000,
    });
  });

  it('fails closed for alcohol because scanner age assurance is unavailable', async () => {
    const { service, accounts, account } = setup();
    await accounts.createIssuedAccount(account);

    await expect(
      service.createChallenge(venueActor, { ...input, containsAlcohol: true }),
    ).rejects.toThrow(/approved age-check flow/);
    await expect(accounts.listEntries(account.id)).resolves.toHaveLength(1);
  });

  it('requires the ticket holder account to have a persisted verified email', async () => {
    const { service, accounts, account } = setup({ emailVerified: false });
    await accounts.createIssuedAccount(account);
    const challenge = await service.createChallenge(venueActor, input);

    await expect(service.confirmChallenge(guestActor, challenge.id)).rejects.toThrow(
      /Verify your account/,
    );
    await expect(service.getChallengeForGuest(guestActor, challenge.id)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('derives a stable, non-secret challenge id from the Venue idempotency key', async () => {
    const { service, accounts, account } = setup();
    await accounts.createIssuedAccount(account);

    const first = await service.createChallenge(venueActor, input, 'venue-operation-key-1');
    const retry = await service.createChallenge(venueActor, input, 'venue-operation-key-1');

    expect(retry.id).toBe(first.id);
    expect(first.id).toMatch(/^COV-CH-[a-f0-9]{32}$/);
    expect(first.id).not.toContain('venue-operation-key-1');
  });

  it('reserves funds while Guest confirmation is pending and releases them on expiry', async () => {
    const { service, accounts, account } = setup();
    await accounts.createIssuedAccount(account);
    const challenge = await service.createChallenge(venueActor, input);

    await expect(accounts.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
      remainingPaise: 15_000,
      reservedPaise: 4_000,
    });
    await expect(accounts.freezeForRefund([account.entitlementId], 'refund-1')).rejects.toThrow(
      /fully unused cover/,
    );

    const expired = await accounts.expireRedemptionChallenge(
      challenge.id,
      new Date(now.getTime() + 3 * 60_000),
    );
    expect(expired.status).toBe('expired');
    await expect(accounts.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
      reservedPaise: 0,
    });
    await expect(
      accounts.freezeForRefund([account.entitlementId], 'refund-2'),
    ).resolves.toHaveLength(1);
  });

  it('does not start cover redemption while ticket ownership is transferring', async () => {
    const { service, accounts, account } = setup({ pendingTransfer: true });
    await accounts.createIssuedAccount(account);

    await expect(service.createChallenge(venueActor, input)).rejects.toThrow(
      /ticket ownership is changing/,
    );
    await expect(accounts.getByEntitlement(account.entitlementId)).resolves.toMatchObject({
      reservedPaise: 0,
    });
  });
});
