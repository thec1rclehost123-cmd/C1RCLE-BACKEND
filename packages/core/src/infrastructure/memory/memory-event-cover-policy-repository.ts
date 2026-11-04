import { ConflictError, NotFoundError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCoverPolicyAcceptance,
  EventCoverPolicyProposal,
} from '../../domain/models/event-cover.js';
import type { EventCoverPolicyRepository } from '../../domain/ports/repositories.js';

/** In-memory adapter for deterministic cover policy fixtures and tests. */
export class MemoryEventCoverPolicyRepository implements EventCoverPolicyRepository {
  private readonly proposals = new Map<EntityId, EventCoverPolicyProposal>();
  private readonly acceptances = new Map<EntityId, EventCoverPolicyAcceptance>();

  async createProposal(proposal: EventCoverPolicyProposal): Promise<void> {
    const current = this.proposals.get(proposal.id);
    if (current) {
      if (JSON.stringify(current) === JSON.stringify(proposal)) return;
      throw new ConflictError('Cover policy proposal id is already used');
    }
    this.proposals.set(proposal.id, proposal);
  }

  async getProposal(proposalId: EntityId): Promise<EventCoverPolicyProposal | null> {
    return this.proposals.get(proposalId) ?? null;
  }

  async listProposalsByEvent(eventId: EntityId): Promise<EventCoverPolicyProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.terms.eventId === eventId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50);
  }

  async acceptProposal(
    acceptance: EventCoverPolicyAcceptance,
  ): Promise<EventCoverPolicyAcceptance> {
    const proposal = this.proposals.get(acceptance.proposalId);
    if (!proposal) throw new NotFoundError('Cover policy proposal', acceptance.proposalId);
    assertAcceptanceMatchesProposal(acceptance, proposal);
    const current = this.acceptances.get(acceptance.proposalId);
    if (current) {
      if (
        current.acceptedByUserId === acceptance.acceptedByUserId &&
        current.termsDigest === acceptance.termsDigest &&
        current.proposalVersion === acceptance.proposalVersion
      ) {
        return current;
      }
      throw new ConflictError('Cover policy proposal has already been accepted');
    }
    this.acceptances.set(acceptance.proposalId, acceptance);
    return acceptance;
  }

  async getAcceptance(proposalId: EntityId): Promise<EventCoverPolicyAcceptance | null> {
    return this.acceptances.get(proposalId) ?? null;
  }
}

export function assertAcceptanceMatchesProposal(
  acceptance: EventCoverPolicyAcceptance,
  proposal: EventCoverPolicyProposal,
): void {
  if (
    acceptance.proposalId !== proposal.id ||
    acceptance.eventId !== proposal.terms.eventId ||
    acceptance.hostOrganizationId !== proposal.hostOrganizationId ||
    acceptance.venueOrganizationId !== proposal.venueOrganizationId ||
    acceptance.proposalVersion !== proposal.policyVersion ||
    acceptance.termsDigest !== proposal.termsDigest
  ) {
    throw new ConflictError('Cover policy acceptance does not match the exact proposal version');
  }
}
