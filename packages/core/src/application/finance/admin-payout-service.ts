import { InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { isExecutable } from '../../domain/models/admin-authority.js';
import { beginProcessing, freezePayout, releasePayout } from '../../domain/models/payout.js';

import type { EntityId } from '../../domain/identity.js';
import type { Payout } from '../../domain/models/payout.js';
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
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get payouts() {
    return this.deps.repositories.payouts;
  }

  async freezePayoutFromProposal(adminUserId: EntityId, proposalId: EntityId): Promise<Payout> {
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
    await this.authority.record(admin, {
      action: 'PAYOUT_FREEZE',
      targetType: 'payout',
      targetId: payout.id,
      before: { status: payout.status },
      after: { status: frozen.status, previousStatus: frozen.previousStatus },
      reason: proposal.reason,
    });
    return frozen;
  }

  async releasePayoutFromProposal(adminUserId: EntityId, proposalId: EntityId): Promise<Payout> {
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
    await this.authority.record(admin, {
      action: 'PAYOUT_RELEASE',
      targetType: 'payout',
      targetId: payout.id,
      before: { status: payout.status },
      after: { status: released.status },
      reason: proposal.reason,
    });
    return released;
  }

  /** Moves the named payouts from `requested` to `processing`. Non-eligible ids are skipped. */
  async runBatch(
    adminUserId: EntityId,
    payoutIds: EntityId[],
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
      const started = beginProcessing(payout, now);
      await this.payouts.save(started);
      processed.push(started);
    }

    await this.authority.record(admin, {
      action: 'PAYOUT_BATCH_RUN',
      targetType: 'payout_batch',
      targetId: this.deps.config.ids(),
      before: { requested: payoutIds.length },
      after: { processed: processed.length, skipped: skipped.length },
      reason: null,
    });
    return { processed, skipped };
  }

  async listByStatus(adminUserId: EntityId, status: Payout['status'], query: PaginationQuery) {
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
