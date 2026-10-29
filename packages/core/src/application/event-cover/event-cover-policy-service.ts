import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../domain/errors.js';
import {
  acceptEventCoverPolicy,
  proposeEventCoverPolicy,
} from '../../domain/models/event-cover.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { EventCoverPolicyTerms } from '../../domain/models/event-cover.js';
import type { ActorContext, ServiceDeps } from '../context.js';

/** Host/Venue draft workflow for an exact-version event-cover policy. */
export class EventCoverPolicyService {
  constructor(private readonly deps: ServiceDeps) {}

  async propose(
    actor: ActorContext,
    eventId: EntityId,
    policyVersion: string,
    terms: Omit<
      EventCoverPolicyTerms,
      'eventId' | 'venueOrganizationId' | 'merchantOrganizationId'
    >,
  ) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    requireOrgAccess(actor, event.organizationId);
    if (!actor.userId) throw new UnauthorizedError('A signed-in Host user is required');
    if (event.status !== 'draft' && event.status !== 'review') {
      throw new ConflictError('Cover terms must be approved before event publication');
    }
    const venue = event.venueId ? await this.deps.repositories.venues.getById(event.venueId) : null;
    if (!venue || venue.status !== 'active') {
      throw new ConflictError('Cover requires an active participating Venue');
    }
    const versionedTerms: EventCoverPolicyTerms = {
      ...terms,
      eventId: event.id,
      venueOrganizationId: venue.organizationId,
      merchantOrganizationId: venue.organizationId,
    };
    if (event.organizationId !== venue.organizationId) {
      const partnership = await this.deps.repositories.partnerships.findByPair(
        event.organizationId,
        venue.id,
      );
      if (!partnership || partnership.status !== 'active') {
        throw new ConflictError('Cover requires an active Host/Venue partnership');
      }
    }
    const proposal = proposeEventCoverPolicy({
      id: this.deps.config.ids(),
      hostOrganizationId: event.organizationId,
      venueOrganizationId: venue.organizationId,
      proposedByUserId: actor.userId,
      policyVersion,
      terms: versionedTerms,
      now: this.deps.config.clock.now(),
    });
    await this.deps.repositories.eventCoverPolicies.createProposal(proposal);
    return proposal;
  }

  async accept(actor: ActorContext, eventId: EntityId, proposalId: EntityId) {
    if (this.deps.config.features.m5CoverPolicyFixtures !== true) {
      throw new ServiceUnavailableError(
        'Cover policy acceptance is disabled until reviewed policy approval is recorded',
      );
    }
    const proposal = await this.deps.repositories.eventCoverPolicies.getProposal(proposalId);
    if (!proposal) throw new NotFoundError('Cover policy proposal', proposalId);
    if (proposal.terms.eventId !== eventId) {
      throw new ConflictError('Cover policy proposal does not belong to this event');
    }
    const event = await this.deps.repositories.events.getById(proposal.terms.eventId);
    if (!event) throw new NotFoundError('Event', proposal.terms.eventId);
    if (event.organizationId !== proposal.hostOrganizationId) {
      throw new ConflictError('Cover policy Host no longer matches the event owner');
    }
    if (event.status !== 'draft' && event.status !== 'review') {
      throw new ConflictError('Cover policy cannot be accepted after event publication');
    }
    const venue = event.venueId ? await this.deps.repositories.venues.getById(event.venueId) : null;
    if (
      !venue ||
      venue.status !== 'active' ||
      venue.organizationId !== proposal.venueOrganizationId
    ) {
      throw new ConflictError('Cover policy Venue no longer matches the event');
    }
    requireOrgAccess(actor, venue.organizationId);
    if (!actor.userId) throw new UnauthorizedError('A signed-in Venue user is required');
    if (event.organizationId !== venue.organizationId) {
      const partnership = await this.deps.repositories.partnerships.findByPair(
        event.organizationId,
        venue.id,
      );
      if (!partnership || partnership.status !== 'active') {
        throw new ConflictError('Cover requires an active Host/Venue partnership');
      }
    }
    const acceptance = acceptEventCoverPolicy({
      id: this.deps.config.ids(),
      proposal,
      acceptingVenueOrganizationId: venue.organizationId,
      acceptedByUserId: actor.userId,
      now: this.deps.config.clock.now(),
    });
    return this.deps.repositories.eventCoverPolicies.acceptProposal(acceptance);
  }

  async listForEvent(actor: ActorContext, eventId: EntityId) {
    const event = await this.deps.repositories.events.getById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    const venue = event.venueId ? await this.deps.repositories.venues.getById(event.venueId) : null;
    if (
      actor.organizationId !== event.organizationId &&
      (!venue || actor.organizationId !== venue.organizationId)
    ) {
      throw new NotFoundError('Event cover policy', eventId);
    }
    const proposals = await this.deps.repositories.eventCoverPolicies.listProposalsByEvent(eventId);
    return {
      acceptanceEnabled: this.deps.config.features.m5CoverPolicyFixtures === true,
      items: await Promise.all(
        proposals.map(async (proposal) => ({
          proposal,
          acceptance: await this.deps.repositories.eventCoverPolicies.getAcceptance(proposal.id),
        })),
      ),
    };
  }
}
