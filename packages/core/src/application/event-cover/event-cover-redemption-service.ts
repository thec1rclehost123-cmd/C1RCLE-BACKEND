import { createHash } from 'node:crypto';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../domain/errors.js';
import { newVersionedEntity } from '../../domain/identity.js';
import { currentEntitlementHolderId } from '../../domain/models/entitlement.js';
import { isEventCoverPolicyAccepted } from '../../domain/models/event-cover.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCoverRedemptionChallenge } from '../../domain/models/event-cover.js';
import type { ActorContext, ServiceDeps } from '../context.js';

export interface CreateEventCoverRedemptionInput {
  entitlementId: EntityId;
  amountPaise: number;
  grossSpendPaise: number;
  categories: string[];
  containsAlcohol: boolean;
  receiptReference: string;
  terminalId: string;
}

/** Venue initiated, Guest confirmed and transactionally consumed redemption. */
export class EventCoverRedemptionService {
  constructor(private readonly deps: ServiceDeps) {}

  async createChallenge(
    actor: ActorContext,
    input: CreateEventCoverRedemptionInput,
    idempotencyKey?: string,
  ) {
    if (!actor.userId) throw new UnauthorizedError('A Venue session is required');
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ConflictError('Cover redemption amount must be positive whole paise');
    }
    if (!Number.isSafeInteger(input.grossSpendPaise) || input.grossSpendPaise < input.amountPaise) {
      throw new ConflictError('Cover amount cannot exceed the verified purchase total');
    }
    const account = await this.deps.repositories.eventCoverAccounts.getByEntitlement(
      input.entitlementId,
    );
    if (!account || account.status !== 'active')
      throw new NotFoundError('Event cover account', input.entitlementId);
    const entitlement = await this.deps.repositories.entitlements.getById(input.entitlementId);
    if (
      !entitlement ||
      currentEntitlementHolderId(entitlement) !== account.guestUserId ||
      entitlement.status !== 'valid' ||
      entitlement.pendingTransferId
    ) {
      throw new ConflictError('Cover redemption is unavailable while ticket ownership is changing');
    }
    if (
      actor.organizationId !== account.venueOrganizationId ||
      !actor.capabilities.includes('venue')
    ) {
      throw new NotFoundError('Event cover account', input.entitlementId);
    }
    const { event, proposal } = await this.requireCurrentPolicy(
      account.eventId,
      account.policyVersion,
    );
    const device = await this.deps.repositories.scannerDevices.findByDevice(
      account.venueOrganizationId,
      input.terminalId,
    );
    if (!device || device.status !== 'active' || device.venueId !== event.venueId) {
      throw new ForbiddenError('This Venue terminal is not authorized for event cover');
    }
    const now = this.deps.config.clock.now();
    if (
      now.getTime() < Date.parse(proposal.terms.redemptionOpensAt) ||
      now.getTime() >= Date.parse(proposal.terms.redemptionClosesAt)
    ) {
      throw new ConflictError('Event cover is outside its approved redemption window');
    }
    if (input.grossSpendPaise < proposal.terms.minimumSpendPaise) {
      throw new ConflictError('Purchase does not meet the Venue minimum spend');
    }
    const categories = [...new Set(input.categories.map((category) => category.trim()))];
    if (
      categories.length === 0 ||
      categories.some(
        (category) =>
          !proposal.terms.eligibleCategories.includes(category) ||
          proposal.terms.excludedCategories.includes(category),
      )
    ) {
      throw new ConflictError('Purchase categories are not eligible under the accepted policy');
    }
    if (input.containsAlcohol) {
      // Age assurance is not yet integrated into scanner redemption, so fail closed.
      throw new ConflictError('Alcohol-containing purchases require an approved age-check flow');
    }
    if (!proposal.terms.partialRedemption && input.amountPaise !== account.remainingPaise) {
      throw new ConflictError(
        'This cover policy requires redemption of the full remaining balance',
      );
    }
    if (!proposal.terms.splitTender && input.amountPaise !== input.grossSpendPaise) {
      throw new ConflictError('This cover policy does not allow split tender');
    }
    const challenge: EventCoverRedemptionChallenge = {
      ...newVersionedEntity(now),
      // The Venue command key is high entropy and scoped by the API's actor
      // idempotency store. Deriving the challenge id lets the client recover
      // a committed challenge if the HTTP response is lost after persistence.
      id: idempotencyKey
        ? `COV-CH-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
        : this.deps.config.ids(),
      accountId: account.id,
      entitlementId: account.entitlementId,
      eventId: account.eventId,
      venueOrganizationId: account.venueOrganizationId,
      guestUserId: account.guestUserId ?? '',
      initiatedByUserId: actor.userId,
      terminalId: input.terminalId,
      amountPaise: input.amountPaise,
      grossSpendPaise: input.grossSpendPaise,
      categories,
      containsAlcohol: input.containsAlcohol,
      receiptReference: input.receiptReference.trim(),
      status: 'pending',
      expiresAt: new Date(now.getTime() + 2 * 60_000).toISOString(),
      confirmedAt: null,
      consumedAt: null,
    };
    if (!challenge.guestUserId) throw new ConflictError('Cover is not assigned to a Guest holder');
    return this.deps.repositories.eventCoverAccounts.createRedemptionChallenge(challenge);
  }

  async confirmChallenge(actor: ActorContext, challengeId: EntityId) {
    if (!actor.userId) throw new UnauthorizedError('A Guest session is required');
    let challenge =
      await this.deps.repositories.eventCoverAccounts.getRedemptionChallenge(challengeId);
    if (challenge) challenge = await this.expireIfElapsed(challenge);
    if (!challenge || challenge.guestUserId !== actor.userId) {
      throw new NotFoundError('Cover redemption challenge', challengeId);
    }
    const entitlement = await this.deps.repositories.entitlements.getById(challenge.entitlementId);
    if (
      !entitlement ||
      currentEntitlementHolderId(entitlement) !== actor.userId ||
      entitlement.status !== 'valid'
    ) {
      throw new NotFoundError('Cover redemption challenge', challengeId);
    }
    const account = await this.deps.repositories.eventCoverAccounts.getByEntitlement(
      challenge.entitlementId,
    );
    if (!account || account.id !== challenge.accountId || account.status !== 'active') {
      throw new ConflictError('Event cover is not available for redemption');
    }
    const guest = await this.deps.repositories.users.getById(actor.userId);
    if (!guest?.emailVerified) {
      throw new ConflictError('Verify your account before confirming event cover redemption');
    }
    await this.requireCurrentPolicy(challenge.eventId, account.policyVersion);
    return this.deps.repositories.eventCoverAccounts.confirmRedemptionChallenge(
      challengeId,
      actor.userId,
      this.deps.config.clock.now(),
    );
  }

  async getChallengeForGuest(actor: ActorContext, challengeId: EntityId) {
    if (!actor.userId) throw new UnauthorizedError('A Guest session is required');
    let challenge =
      await this.deps.repositories.eventCoverAccounts.getRedemptionChallenge(challengeId);
    if (challenge) challenge = await this.expireIfElapsed(challenge);
    if (!challenge || challenge.guestUserId !== actor.userId) {
      throw new NotFoundError('Cover redemption challenge', challengeId);
    }
    return challenge;
  }

  async getChallengeForVenue(actor: ActorContext, challengeId: EntityId) {
    if (!actor.userId) throw new UnauthorizedError('A Venue session is required');
    let challenge =
      await this.deps.repositories.eventCoverAccounts.getRedemptionChallenge(challengeId);
    if (challenge) challenge = await this.expireIfElapsed(challenge);
    if (
      !challenge ||
      challenge.venueOrganizationId !== actor.organizationId ||
      challenge.initiatedByUserId !== actor.userId
    ) {
      throw new NotFoundError('Cover redemption challenge', challengeId);
    }
    return challenge;
  }

  async consumeChallenge(actor: ActorContext, challengeId: EntityId) {
    if (!actor.userId) throw new UnauthorizedError('A Venue session is required');
    let challenge =
      await this.deps.repositories.eventCoverAccounts.getRedemptionChallenge(challengeId);
    if (challenge) challenge = await this.expireIfElapsed(challenge);
    if (
      !challenge ||
      challenge.venueOrganizationId !== actor.organizationId ||
      challenge.initiatedByUserId !== actor.userId
    ) {
      throw new NotFoundError('Cover redemption challenge', challengeId);
    }
    const account = await this.deps.repositories.eventCoverAccounts.getByEntitlement(
      challenge.entitlementId,
    );
    if (!account || account.id !== challenge.accountId) {
      throw new ConflictError('Event cover account is unavailable');
    }
    const { event } = await this.requireCurrentPolicy(challenge.eventId, account.policyVersion);
    const device = await this.deps.repositories.scannerDevices.findByDevice(
      actor.organizationId,
      challenge.terminalId,
    );
    if (!device || device.status !== 'active' || device.venueId !== event.venueId) {
      throw new ForbiddenError('This Venue terminal is no longer authorized');
    }
    return this.deps.repositories.eventCoverAccounts.consumeConfirmedRedemption(
      challengeId,
      actor.userId,
      this.deps.config.clock.now(),
    );
  }

  private async requireCurrentPolicy(eventId: EntityId, policyVersion?: string) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event || !event.venueId) throw new NotFoundError('Event cover', eventId);
    const venue = await this.deps.repositories.venues.getById(event.venueId);
    if (!venue || venue.status !== 'active') throw new ConflictError('Venue is not active');
    const proposals = await this.deps.repositories.eventCoverPolicies.listProposalsByEvent(eventId);
    for (const proposal of proposals) {
      if (policyVersion && proposal.policyVersion !== policyVersion) continue;
      if (proposal.venueOrganizationId !== venue.organizationId) continue;
      const acceptance = await this.deps.repositories.eventCoverPolicies.getAcceptance(proposal.id);
      if (isEventCoverPolicyAccepted(proposal, acceptance)) return { event, proposal };
    }
    throw new ConflictError('No currently accepted Venue policy is available for redemption');
  }

  private async expireIfElapsed(challenge: EventCoverRedemptionChallenge) {
    const now = this.deps.config.clock.now();
    if (
      (challenge.status === 'pending' || challenge.status === 'confirmed') &&
      Date.parse(challenge.expiresAt) <= now.getTime()
    ) {
      return this.deps.repositories.eventCoverAccounts.expireRedemptionChallenge(challenge.id, now);
    }
    return challenge;
  }
}
