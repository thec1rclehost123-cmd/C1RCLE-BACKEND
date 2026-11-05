import { ConflictError, InvalidOperationError, NotFoundError } from '../../domain/errors.js';
import { bumpVersion } from '../../domain/identity.js';
import { adminResolveDispute } from '../../domain/models/dispute.js';
import { journalTotals } from '../../domain/models/financial-journal.js';

import { FinancialPostingService } from './financial-posting-service.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute, DisputeResolutionOutcome } from '../../domain/models/dispute.js';
import type { FinancialJournal } from '../../domain/models/financial-journal.js';
import type { AuditRequestMeta } from '../../domain/ports/audit.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/** Admin business disputes reverse only an exact identified partner-payable journal.
 * Provider chargebacks and unlinked financial adjustments retain their separate authority paths.
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
    meta?: AuditRequestMeta,
  ): Promise<Dispute> {
    const admin = await this.authority.authorize(adminUserId, 'DISPUTE_RESOLVE');
    let dispute = await this.requireDispute(disputeId);
    const note = resolutionNote.trim();
    if (!note || note.length > 2000 || !Number.isSafeInteger(dispute.amount) || dispute.amount <= 0)
      throw new InvalidOperationError(
        'Dispute resolution requires a reason and positive integer paise',
      );
    const intent = dispute.resolutionIntent;
    if (intent && (intent.outcome !== outcome || intent.resolutionNote !== note))
      throw new ConflictError('A different dispute resolution is already in progress');
    if (dispute.status === 'resolved') {
      if (dispute.resolution !== outcome || (outcome === 'upheld' && !intent))
        throw new ConflictError(
          'Dispute is already resolved; use a separately approved financial adjustment',
        );
      await this.recordResolution(dispute);
      return dispute;
    }
    const journal = outcome === 'upheld' ? await this.requireCorrectionJournal(dispute) : null;
    if (intent && intent.journalId !== (journal?.id ?? null))
      throw new ConflictError('The identified dispute journal changed');
    const now = this.deps.config.clock.now();
    if (!intent) {
      dispute = await this.disputes.save({
        ...bumpVersion(dispute, now),
        status: 'under_review',
        resolutionIntent: {
          outcome,
          resolutionNote: note,
          claimedBy: admin.id,
          claimedRole: admin.role,
          ...(meta?.ipAddress ? { ipAddress: meta.ipAddress } : {}),
          ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
          claimedAt: now.toISOString(),
          journalId: journal?.id ?? null,
        },
      });
    }
    if (journal) {
      await new FinancialPostingService(this.deps.repositories.financialJournals).reverseJournal({
        journalId: journal.id,
        source: {
          type: 'partner_dispute_reversal',
          id: dispute.id,
          orderId: dispute.orderId,
          paymentId: journal.source.paymentId,
          eventId: journal.source.eventId,
        },
        // One original entry can be corrected only once, even across dispute IDs.
        idempotencyKey: `m4:partner-dispute:${journal.id}:reversal`,
        postedAt: now,
      });
    }
    const resolved = adminResolveDispute(dispute, outcome, note, now);
    await this.disputes.save(resolved);
    await this.recordResolution(resolved);
    return resolved;
  }

  private async recordResolution(dispute: Dispute): Promise<void> {
    const intent = dispute.resolutionIntent;
    if (!intent) return;
    await this.deps.adminAudit.append({
      id: `m4:dispute-resolution:${dispute.id}`,
      adminId: intent.claimedBy,
      adminRole: intent.claimedRole,
      action: 'DISPUTE_RESOLVE',
      targetType: 'dispute',
      targetId: dispute.id,
      before: { status: 'under_review' },
      after: {
        status: dispute.status,
        resolution: dispute.resolution,
        journalId: intent.journalId,
        correction: intent.journalId ? 'canonical_journal_reversal' : null,
      },
      reason: intent.resolutionNote,
      occurredAt: Date.parse(intent.claimedAt),
      ...(intent.ipAddress ? { ipAddress: intent.ipAddress } : {}),
      ...(intent.userAgent ? { userAgent: intent.userAgent } : {}),
    });
  }

  private async requireCorrectionJournal(dispute: Dispute): Promise<FinancialJournal> {
    const adjustmentRequired = () =>
      new ConflictError(
        'This claim does not identify an exact reversible partner entry; use a separately approved financial adjustment',
      );
    const order = await this.orders.getById(dispute.orderId);
    if (!order) throw new NotFoundError('order', dispute.orderId);
    const journals = this.deps.repositories.financialJournals;
    let journal: FinancialJournal | null = null;
    if (dispute.journalId) journal = await journals.findById(dispute.journalId);
    if (dispute.ledgerEntryId) {
      const entry = (await this.ledger.findByOrder(dispute.orderId)).find(
        (item) => item.id === dispute.ledgerEntryId,
      );
      if (
        !entry ||
        entry.organizationId !== dispute.organizationId ||
        entry.eventId !== order.eventId ||
        entry.amount !== dispute.amount ||
        !['host_payout', 'venue_share', 'promoter_commission'].includes(entry.entryType)
      )
        throw adjustmentRequired();
      // This is a persisted explicit source relationship established by legacy backfill.
      const linked = await journals.findBySource('legacy_backfill', entry.id);
      if (linked.length !== 1 || (journal && journal.id !== linked[0]?.id))
        throw adjustmentRequired();
      journal = linked[0] ?? null;
    }
    if (
      !journal ||
      journal.organizationId !== dispute.organizationId ||
      journal.source.orderId !== dispute.orderId ||
      journal.source.eventId !== order.eventId ||
      journal.currency !== order.currency ||
      journal.reversalOfJournalId !== null ||
      journal.source.type.startsWith('chargeback') ||
      journal.evidenceOnly
    )
      throw adjustmentRequired();
    const totals = journalTotals(journal);
    const payableAccounts = [
      'host_payable',
      'venue_payable',
      'promoter_payable',
      'partner_payable',
    ];
    const payableLines = journal.lines.filter((entry) => payableAccounts.includes(entry.account));
    const payableSide = payableLines[0]?.side;
    if (
      totals.debitPaise !== dispute.amount ||
      totals.creditPaise !== dispute.amount ||
      payableLines.length === 0 ||
      payableLines.some(
        (entry) => entry.side !== payableSide || entry.organizationId !== dispute.organizationId,
      ) ||
      journal.lines.some(
        (entry) =>
          !payableAccounts.includes(entry.account) &&
          (entry.account !== 'ticket_collection_control' ||
            entry.side === payableSide ||
            entry.organizationId !== dispute.organizationId),
      )
    )
      throw adjustmentRequired();
    const reversals = await journals.findReversals(journal.id);
    if (
      reversals.some(
        (reversal) =>
          reversal.source.type !== 'partner_dispute_reversal' || reversal.source.id !== dispute.id,
      )
    )
      throw new ConflictError('The identified entry has already been corrected');
    // A committed own reversal is already authoritative; finish its interrupted resolution
    // even if a later refund has since changed the order. No additional money is posted.
    if (
      reversals.some(
        (reversal) =>
          reversal.source.type === 'partner_dispute_reversal' && reversal.source.id === dispute.id,
      )
    )
      return journal;
    if (order.status === 'refund_requested' || order.refundedPaise > 0) throw adjustmentRequired();
    const related = await journals.findByOrderId(dispute.orderId);
    if (
      related.some(
        (entry) =>
          entry.id !== journal.id &&
          entry.source.id !== dispute.id &&
          ['refund', 'chargeback', 'chargeback_loss', 'partner_dispute_reversal'].includes(
            entry.source.type,
          ) &&
          entry.lines.some(
            (line) =>
              line.side === 'debit' &&
              line.organizationId === dispute.organizationId &&
              payableAccounts.includes(line.account),
          ),
      )
    )
      throw adjustmentRequired();
    return journal;
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
