import { NotFoundError } from '../../domain/errors.js';
import { adminResolveDispute } from '../../domain/models/dispute.js';
import { createLedgerEntry } from '../../domain/models/ledger.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute, DisputeResolutionOutcome } from '../../domain/models/dispute.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin dispute resolution desk (Phase 6 admin) ───────────────────────────
 *
 * `dispute-service.ts` is partner-facing and deliberately never mutates the
 * ledger on resolution (see its header comment) — that follow-up is this
 * desk. Resolving `upheld` writes a correcting `refund`-type ledger entry
 * for the disputed amount (idempotent per dispute, so a retried resolve
 * cannot double-correct); `denied` leaves the ledger untouched. TIER2,
 * single admin — a dispute resolution is reversible-but-costly, same tier
 * as `FINANCIAL_REFUND`, not TIER3 dual control.
 */
export class AdminDisputeService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get disputes() {
    return this.deps.repositories.disputes;
  }

  private get orders() {
    return this.deps.repositories.orders;
  }

  private get ledger() {
    return this.deps.repositories.ledger;
  }

  async resolve(
    adminUserId: EntityId,
    disputeId: EntityId,
    outcome: DisputeResolutionOutcome,
    resolutionNote: string,
  ): Promise<Dispute> {
    const admin = await this.authority.authorize(adminUserId, 'DISPUTE_RESOLVE');
    const dispute = await this.requireDispute(disputeId);
    const now = this.deps.config.clock.now();
    const resolved = adminResolveDispute(dispute, outcome, resolutionNote, now);

    if (outcome === 'upheld') {
      const order = await this.orders.getById(dispute.orderId);
      if (!order) throw new NotFoundError('order', dispute.orderId);
      await this.ledger.createBatch([
        createLedgerEntry({
          id: this.deps.config.ids(),
          organizationId: dispute.organizationId,
          orderId: dispute.orderId,
          eventId: order.eventId,
          entryType: 'refund',
          amount: dispute.amount,
          status: 'settled',
          // Stable per dispute — a retried resolve must not write a second
          // correction (`createBatch`'s own idempotency, see its doc comment).
          idempotencyKey: `dispute-resolve-${dispute.id}`,
          now,
        }),
      ]);
    }

    await this.disputes.save(resolved);
    await this.authority.record(admin, {
      action: 'DISPUTE_RESOLVE',
      targetType: 'dispute',
      targetId: dispute.id,
      before: { status: dispute.status },
      after: { status: resolved.status, resolution: resolved.resolution },
      reason: resolutionNote,
    });
    return resolved;
  }

  async listByStatus(
    adminUserId: EntityId,
    status: Dispute['status'] | null,
    query: PaginationQuery,
  ) {
    await this.authority.requireAdmin(adminUserId);
    return this.disputes.listByStatus(status, query);
  }

  async getDispute(adminUserId: EntityId, disputeId: EntityId): Promise<Dispute> {
    await this.authority.requireAdmin(adminUserId);
    return this.requireDispute(disputeId);
  }

  private async requireDispute(disputeId: EntityId): Promise<Dispute> {
    const dispute = await this.disputes.findById(disputeId);
    if (!dispute) throw new NotFoundError('dispute', disputeId);
    return dispute;
  }
}
