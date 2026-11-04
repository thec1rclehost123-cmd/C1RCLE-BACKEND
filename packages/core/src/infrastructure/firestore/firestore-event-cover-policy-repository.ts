import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { isEventCoverPolicyAccepted } from '../../domain/models/event-cover.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  EventCoverPolicyAcceptance,
  EventCoverPolicyProposal,
} from '../../domain/models/event-cover.js';
import type { EventCoverPolicyRepository } from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

const PROPOSALS = 'v2_event_cover_policies';
const ACCEPTANCES = 'v2_event_cover_policy_acceptances';

/** Firestore persistence for immutable M5 cover policy snapshots and approvals. */
export class FirestoreEventCoverPolicyRepository implements EventCoverPolicyRepository {
  constructor(private readonly db: Firestore) {}

  private get proposals() {
    return this.db.collection(PROPOSALS);
  }

  private get acceptances() {
    return this.db.collection(ACCEPTANCES);
  }

  async createProposal(proposal: EventCoverPolicyProposal): Promise<void> {
    const ref = this.proposals.doc(proposal.id);
    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        const current = toProposal(snapshot.data() ?? {});
        if (
          current.policyVersion === proposal.policyVersion &&
          current.termsDigest === proposal.termsDigest &&
          current.hostOrganizationId === proposal.hostOrganizationId &&
          current.venueOrganizationId === proposal.venueOrganizationId
        ) {
          return;
        }
        throw new ConflictError('Cover policy proposal id is already used');
      }
      tx.create(ref, proposalDocument(proposal));
    });
  }

  async getProposal(proposalId: EntityId): Promise<EventCoverPolicyProposal | null> {
    const snapshot = await this.proposals.doc(proposalId).get();
    return snapshot.exists ? toProposal(snapshot.data() ?? {}) : null;
  }

  async listProposalsByEvent(eventId: EntityId): Promise<EventCoverPolicyProposal[]> {
    const snapshot = await this.proposals.where('terms.eventId', '==', eventId).limit(50).get();
    return snapshot.docs
      .map((document) => toProposal(document.data()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async acceptProposal(
    acceptance: EventCoverPolicyAcceptance,
  ): Promise<EventCoverPolicyAcceptance> {
    const proposalRef = this.proposals.doc(acceptance.proposalId);
    const acceptanceRef = this.acceptances.doc(acceptance.proposalId);
    return this.db.runTransaction(async (tx) => {
      const [proposalSnapshot, acceptanceSnapshot] = await Promise.all([
        tx.get(proposalRef),
        tx.get(acceptanceRef),
      ]);
      if (!proposalSnapshot.exists) {
        throw new NotFoundError('Cover policy proposal', acceptance.proposalId);
      }
      const proposal = toProposal(proposalSnapshot.data() ?? {});
      if (!isEventCoverPolicyAccepted(proposal, acceptance)) {
        throw new ConflictError(
          'Cover policy acceptance does not match the exact proposal version',
        );
      }
      if (acceptanceSnapshot.exists) {
        const current = toAcceptance(acceptanceSnapshot.data() ?? {});
        if (
          isEventCoverPolicyAccepted(proposal, current) &&
          current.acceptedByUserId === acceptance.acceptedByUserId
        ) {
          return current;
        }
        throw new ConflictError('Cover policy proposal has already been accepted');
      }
      tx.create(acceptanceRef, acceptanceDocument(acceptance));
      return acceptance;
    });
  }

  async getAcceptance(proposalId: EntityId): Promise<EventCoverPolicyAcceptance | null> {
    const snapshot = await this.acceptances.doc(proposalId).get();
    return snapshot.exists ? toAcceptance(snapshot.data() ?? {}) : null;
  }
}

function proposalDocument(proposal: EventCoverPolicyProposal): DocumentData {
  return { ...proposal, terms: { ...proposal.terms } };
}

function acceptanceDocument(acceptance: EventCoverPolicyAcceptance): DocumentData {
  return { ...acceptance };
}

function toProposal(data: DocumentData): EventCoverPolicyProposal {
  return data as EventCoverPolicyProposal;
}

function toAcceptance(data: DocumentData): EventCoverPolicyAcceptance {
  return data as EventCoverPolicyAcceptance;
}
