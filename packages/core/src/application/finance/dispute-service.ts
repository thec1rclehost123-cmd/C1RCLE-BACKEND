import { NotFoundError } from '../../domain/errors.js';
import { beginReview, createDispute, resolveDispute } from '../../domain/models/dispute.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute, DisputeStatus } from '../../domain/models/dispute.js';
import type { DisputeRepository, Page } from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Dispute Service (Phase 6) ──────────────────────────────────────────────────
 *
 * A partner's challenge against a ledger entry or payout amount. Minimal FSM
 * (`open -> under_review -> resolved`, `domain/models/dispute.ts`) — no
 * automatic linkage back into the ledger (a resolved dispute does not itself
 * mutate ledger entries; that stays a manual operator follow-up until a
 * richer reconciliation flow is scoped).
 */

export interface DisputeServiceDeps {
  disputes: DisputeRepository;
  config: ServiceDeps['config'];
}

export interface RaiseDisputeInput {
  organizationId: EntityId;
  orderId: EntityId;
  ledgerEntryId?: EntityId | null;
  reason: string;
  amount: number; // paise
}

export interface DisputeService {
  raiseDispute(input: RaiseDisputeInput, actor: ActorContext): Promise<Dispute>;
  beginReview(disputeId: EntityId, actor: ActorContext): Promise<Dispute>;
  resolve(disputeId: EntityId, resolutionNote: string, actor: ActorContext): Promise<Dispute>;
  getDispute(disputeId: EntityId, actor: ActorContext): Promise<Dispute>;
  listDisputes(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number; status?: DisputeStatus },
  ): Promise<Page<Dispute>>;
}

export function createDisputeService(deps: DisputeServiceDeps): DisputeService {
  const { disputes, config } = deps;

  async function raiseDispute(input: RaiseDisputeInput, actor: ActorContext): Promise<Dispute> {
    requireOrgAccess(actor, input.organizationId);

    const dispute = createDispute({
      organizationId: input.organizationId,
      orderId: input.orderId,
      ledgerEntryId: input.ledgerEntryId,
      raisedBy: actor.userId,
      reason: input.reason,
      amount: input.amount,
      now: config.clock.now(),
    });
    return disputes.create(dispute);
  }

  async function findOwned(disputeId: EntityId, actor: ActorContext): Promise<Dispute> {
    const dispute = await disputes.findById(disputeId);
    if (!dispute) throw new NotFoundError('Dispute', disputeId);
    requireOrgAccess(actor, dispute.organizationId);
    return dispute;
  }

  async function beginReviewOp(disputeId: EntityId, actor: ActorContext): Promise<Dispute> {
    const dispute = await findOwned(disputeId, actor);
    return disputes.save(beginReview(dispute, config.clock.now()));
  }

  async function resolve(
    disputeId: EntityId,
    resolutionNote: string,
    actor: ActorContext,
  ): Promise<Dispute> {
    const dispute = await findOwned(disputeId, actor);
    return disputes.save(resolveDispute(dispute, resolutionNote, config.clock.now()));
  }

  async function getDispute(disputeId: EntityId, actor: ActorContext): Promise<Dispute> {
    return findOwned(disputeId, actor);
  }

  async function listDisputes(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number; status?: DisputeStatus },
  ): Promise<Page<Dispute>> {
    requireOrgAccess(actor, organizationId);
    return disputes.listByOrganization(organizationId, query);
  }

  return { raiseDispute, beginReview: beginReviewOp, resolve, getDispute, listDisputes };
}
