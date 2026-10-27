import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { isExecutable } from '../../domain/models/admin-authority.js';
import {
  beginProcessing,
  freezePayout,
  markPayoutPaid,
  releasePayout,
} from '../../domain/models/payout.js';

import { FinancialPostingService } from './financial-posting-service.js';
import { appendPayoutStatusEvent } from './payout-events.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout, PayoutTransferEvidence } from '../../domain/models/payout.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Admin payout controls (Phase 6 admin) ───────────────────────────────────
 *
 * Freeze/release are TIER3 (dual control — see `admin-authority.ts`), and
 * unlike v1, symmetric: v1 had `PAYOUT_FREEZE` dual-controlled but
 * `PAYOUT_RELEASE` single-admin, which is backwards — unfreezing money is
 * the direction that needs the second signature. Both route through
 * `admin-authority`'s propose→approve, then execute from the approved
 * proposal (same shape as `provisionAdminFromProposal` — the payload is
 * read from the proposal, never trusted from the executing call's args).
 *
 * Batch run is TIER2 (single admin, already-established authority tier) —
 * moves eligible `requested` payouts to `processing` in one operator action.
 * Idempotent per payout: anything not `requested` is skipped, not errored,
 * so a retried batch call is safe.
 */
export class AdminPayoutService {
  private readonly posting: FinancialPostingService;

  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {
    this.posting = new FinancialPostingService(deps.repositories.financialJournals);
  }

  private get payouts() {
    return this.deps.repositories.payouts;
  }

  async freezePayoutFromProposal(
    adminUserId: EntityId,
    proposalId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<Payout> {
    const admin = await this.authority.authorize(adminUserId, 'PAYOUT_FREEZE');
    const proposal = await this.authority.getProposal(adminUserId, proposalId);
    if (proposal.action !== 'PAYOUT_FREEZE') {
      throw new InvalidOperationError('This proposal does not freeze a payout');
    }
    if (!isExecutable(proposal)) {
      throw new InvalidOperationError('This proposal has not been approved by a second admin');
    }
    const payoutId = readPayoutIdPayload(proposal.payload);
    const payout = await this.requirePayout(payoutId);
    const now = this.deps.config.clock.now();
    const frozen = freezePayout(payout, now);
    await this.payouts.save(frozen);
    await appendPayoutStatusEvent(this.deps.outbox, frozen, adminUserId, now);
    await this.authority.record(admin, {
      action: 'PAYOUT_FREEZE',
      targetType: 'payout',
      targetId: payout.id,
      before: { status: payout.status },
      after: { status: frozen.status, previousStatus: frozen.previousStatus },
      reason: proposal.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return frozen;
  }

  async releasePayoutFromProposal(
    adminUserId: EntityId,
    proposalId: EntityId,
    meta?: AuditRequestMeta,
  ): Promise<Payout> {
    const admin = await this.authority.authorize(adminUserId, 'PAYOUT_RELEASE');
    const proposal = await this.authority.getProposal(adminUserId, proposalId);
    if (proposal.action !== 'PAYOUT_RELEASE') {
      throw new InvalidOperationError('This proposal does not release a payout');
    }
    if (!isExecutable(proposal)) {
      throw new InvalidOperationError('This proposal has not been approved by a second admin');
    }
    const payoutId = readPayoutIdPayload(proposal.payload);
    const payout = await this.requirePayout(payoutId);
    const now = this.deps.config.clock.now();
    const released = releasePayout(payout, now);
    await this.payouts.save(released);
    await appendPayoutStatusEvent(this.deps.outbox, released, adminUserId, now);
    await this.authority.record(admin, {
      action: 'PAYOUT_RELEASE',
      targetType: 'payout',
      targetId: payout.id,
      before: { status: payout.status },
      after: { status: released.status },
      reason: proposal.reason,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return released;
  }

  /** Moves the named payouts from `requested` to `processing`. Non-eligible ids are skipped. */
  async runBatch(
    adminUserId: EntityId,
    payoutIds: EntityId[],
    meta?: AuditRequestMeta,
  ): Promise<{ processed: Payout[]; skipped: { id: EntityId; reason: string }[] }> {
    const admin = await this.authority.authorize(adminUserId, 'PAYOUT_BATCH_RUN');
    const now = this.deps.config.clock.now();
    const processed: Payout[] = [];
    const skipped: { id: EntityId; reason: string }[] = [];

    for (const id of payoutIds) {
      const payout = await this.payouts.findById(id);
      if (!payout) {
        skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (payout.status !== 'requested') {
        skipped.push({ id, reason: `not eligible — status is ${payout.status}` });
        continue;
      }
      const reservation = await this.deps.repositories.financialJournals.findBySource(
        'payout_reservation',
        payout.id,
      );
      if (reservation.length === 0) {
        skipped.push({ id, reason: 'reservation journal is missing' });
        continue;
      }
      const started = beginProcessing(payout, now);
      await this.payouts.save(started);
      await appendPayoutStatusEvent(this.deps.outbox, started, adminUserId, now);
      processed.push(started);
    }

    await this.authority.record(admin, {
      action: 'PAYOUT_BATCH_RUN',
      targetType: 'payout_batch',
      targetId: this.deps.config.ids(),
      before: { requested: payoutIds.length },
      after: { processed: processed.length, skipped: skipped.length },
      reason: null,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return { processed, skipped };
  }

  async completeManualPayout(
    adminUserId: EntityId,
    payoutId: EntityId,
    evidence: Omit<PayoutTransferEvidence, 'approvedBy'>,
    meta?: AuditRequestMeta,
  ): Promise<Payout> {
    const admin = await this.authority.authorize(adminUserId, 'PAYOUT_COMPLETE');
    const payout = await this.requirePayout(payoutId);
    const paid = markPayoutPaid(
      payout,
      { ...evidence, approvedBy: adminUserId },
      this.deps.config.clock.now(),
    );
    await this.posting.postPayoutCompletion({
      organizationId: payout.organizationId,
      payoutId: payout.id,
      amountPaise: payout.amount,
      transferReference: paid.transferReference ?? evidence.transferReference,
      postedAt: this.deps.config.clock.now(),
    });
    await this.payouts.save(paid);
    await appendPayoutStatusEvent(
      this.deps.outbox,
      paid,
      adminUserId,
      this.deps.config.clock.now(),
    );
    await this.authority.record(admin, {
      action: 'PAYOUT_COMPLETE',
      targetType: 'payout',
      targetId: payout.id,
      before: { status: payout.status },
      after: {
        status: paid.status,
        transferReference: paid.transferReference,
        transferredAt: paid.transferredAt,
        transferMethod: paid.transferMethod,
        transferProofSha256: paid.transferProof?.sha256 ?? null,
      },
      reason: 'Manual bank transfer evidence recorded',
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
    return paid;
  }

  async listByStatus(
    adminUserId: EntityId,
    status: Payout['status'] | null,
    query: PaginationQuery,
  ) {
    await this.authority.requireAdmin(adminUserId);
    return this.payouts.listByStatus(status, query);
  }

  async getPayout(adminUserId: EntityId, payoutId: EntityId): Promise<Payout> {
    await this.authority.requireAdmin(adminUserId);
    return this.requirePayout(payoutId);
  }

  private async requirePayout(payoutId: EntityId): Promise<Payout> {
    const payout = await this.payouts.findById(payoutId);
    if (!payout) throw new NotFoundError('payout', payoutId);
    return payout;
  }
}

function readPayoutIdPayload(payload: Record<string, unknown>): string {
  const payoutId = payload.payoutId;
  if (typeof payoutId !== 'string' || payoutId.length === 0) {
    throw new InvalidOperationError('Proposal payload is missing `payoutId`');
  }
  return payoutId;
}
