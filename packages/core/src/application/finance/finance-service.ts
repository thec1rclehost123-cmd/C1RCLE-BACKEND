import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../../domain/errors.js';
import { computeSettlementSplit, createLedgerEntry } from '../../domain/models/ledger.js';
import { validateSaleAllocation } from '../../domain/models/sale-allocation.js';
import { requireOrgAccess } from '../context.js';

import { stagedSettlement } from './settlement-policy.js';

import type { EntityId } from '../../domain/identity.js';
import type { Dispute } from '../../domain/models/dispute.js';
import type { LedgerEntry, LedgerEntryType } from '../../domain/models/ledger.js';
import type { ReconciliationDiscrepancy } from '../../domain/models/reconciliation.js';
import type { SaleAllocationSnapshot } from '../../domain/models/sale-allocation.js';
import type {
  EventRepository,
  FinancialJournalRepository,
  JournalTransitionRepository,
  LedgerRepository,
  PayoutRepository,
  ReconciliationRepository,
} from '../../domain/ports/repositories.js';
import type { ServiceDeps, ActorContext } from '../context.js';

/**
 * ─── Finance Service (Phase 6) ──────────────────────────────────────────────────
 *
 * Records ticket-sale settlement splits into the append-only ledger and
 * computes partner balances. Balances are ALWAYS derived from the ledger
 * (`sumByOrganizationAndType`) — never trusted from an external cache — per
 * the roadmap's "no cache-ledger drift" design.
 */

export interface FinanceServiceDeps {
  ledger: LedgerRepository;
  financialJournals: FinancialJournalRepository;
  journalTransition: JournalTransitionRepository;
  payouts: PayoutRepository;
  events: EventRepository;
  reconciliations: ReconciliationRepository;
  config: ServiceDeps['config'];
  financialExposure?: Pick<
    ServiceDeps['repositories'],
    'orders' | 'refundRequests' | 'providerPayments' | 'disputes'
  >;
}

export interface RecordTicketSaleInput {
  allocation?: SaleAllocationSnapshot;
  organizationId: EntityId; // the organization the order belongs to (host org)
  orderId: EntityId;
  eventId: EntityId;
  grossAmount: number; // paise
  hostOrganizationId: EntityId;
  venueOrganizationId: EntityId;
  promoterOrganizationId: EntityId | null;
  platformFeeRate: number;
  venueShareRate: number;
  promoterCommissionRate: number | null;
  /** Frozen assignment calculation, when attribution carries V2 terms. */
  promoterCommissionPaise?: number | null;
}

export interface BalanceSummary {
  availablePaise: number;
  pendingPaise: number;
  reservedPaise: number;
  heldPaise: number;
  paidPaise: number;
  lifetimePaise: number;
  holds: {
    reservePaise: number;
    cancellationPaise: number;
    chargebackPaise: number;
    reconciliationPaise: number;
    refundPaise?: number;
    disputePaise?: number;
    providerUncertaintyPaise?: number;
  };
  readModel: 'legacy_ledger_v1' | 'financial_journal_v2';
  settlementUnavailableReason?: string | null;
}

export interface FinanceService {
  /** Idempotent per orderId — a repeated call with the same orderId is a no-op replay. */
  recordTicketSale(input: RecordTicketSaleInput, actor: ActorContext): Promise<LedgerEntry[]>;
  getBalances(organizationId: EntityId, actor: ActorContext): Promise<BalanceSummary>;
  listLedgerEntries(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number },
  ): Promise<{ items: LedgerEntry[]; total: number; nextCursor: string | null }>;
}

function entryId(
  orderId: EntityId,
  entryType: LedgerEntryType,
  organizationId: EntityId,
): EntityId {
  const readable = `led-${orderId}-${entryType}-${organizationId}`;
  if (readable.length <= 64) return readable;
  // The composite key can exceed the frozen wire contract's 64-char opaque-id
  // limit (e.g. a long Razorpay order id plus a 36-char UUID org id). Fall back
  // to a fixed-width digest so the id stays deterministic — keeping idempotent
  // replay safe (the repo dedups on idempotencyKey, and `findByOrder` replays by
  // order, not reconstructed id) — and collision-resistant without ever blowing
  // the length cap.
  const digest = createHash('sha256').update(readable).digest('hex').slice(0, 24);
  return `led-${digest}`;
}

function idempotencyKey(
  orderId: EntityId,
  entryType: LedgerEntryType,
  organizationId: EntityId,
): string {
  return `${orderId}:${entryType}:${organizationId}`;
}

export function createFinanceService(deps: FinanceServiceDeps): FinanceService {
  const { ledger, config } = deps;

  async function recordTicketSale(
    input: RecordTicketSaleInput,
    actor: ActorContext,
  ): Promise<LedgerEntry[]> {
    requireOrgAccess(actor, input.organizationId);

    const existing = await ledger.findByOrder(input.orderId);
    if (existing.length > 0 && !input.allocation) {
      // Already recorded — idempotent replay, not a re-computation.
      return existing;
    }

    const frozen = input.allocation
      ? validateSaleAllocation(input.allocation, input.grossAmount, input.hostOrganizationId)
      : null;
    const calculated = frozen
      ? {
          platformFee: frozen.platformPaise,
          venueShare: frozen.venuePaise,
          promoterCommission: frozen.promoterPaise,
          hostPayout: frozen.hostPaise,
        }
      : computeSettlementSplit(
          input.grossAmount,
          input.platformFeeRate,
          input.venueShareRate,
          input.promoterCommissionRate,
        );
    const promoterCommission =
      frozen?.promoterPaise ?? input.promoterCommissionPaise ?? calculated.promoterCommission;
    if (
      promoterCommission < 0 ||
      promoterCommission > input.grossAmount - calculated.platformFee - calculated.venueShare
    ) {
      throw new InvalidOperationError(
        'Promoter commission exceeds the distributable ticket revenue',
      );
    }
    const split = {
      ...calculated,
      promoterCommission,
      hostPayout:
        input.grossAmount - calculated.platformFee - calculated.venueShare - promoterCommission,
    };
    const now = config.clock.now();

    const entries: LedgerEntry[] = [
      createLedgerEntry({
        id: entryId(input.orderId, 'ticket_revenue', input.organizationId),
        organizationId: input.organizationId,
        orderId: input.orderId,
        eventId: input.eventId,
        entryType: 'ticket_revenue',
        amount: input.grossAmount,
        status: 'settled',
        idempotencyKey: idempotencyKey(input.orderId, 'ticket_revenue', input.organizationId),
        now,
      }),
      createLedgerEntry({
        id: entryId(input.orderId, 'platform_fee', input.hostOrganizationId),
        organizationId: input.hostOrganizationId,
        orderId: input.orderId,
        eventId: input.eventId,
        entryType: 'platform_fee',
        amount: split.platformFee,
        status: 'settled',
        idempotencyKey: idempotencyKey(input.orderId, 'platform_fee', input.hostOrganizationId),
        now,
      }),
      createLedgerEntry({
        id: entryId(input.orderId, 'venue_share', input.venueOrganizationId),
        organizationId: input.venueOrganizationId,
        orderId: input.orderId,
        eventId: input.eventId,
        entryType: 'venue_share',
        amount: split.venueShare,
        status: 'pending',
        idempotencyKey: idempotencyKey(input.orderId, 'venue_share', input.venueOrganizationId),
        now,
      }),
      createLedgerEntry({
        id: entryId(input.orderId, 'host_payout', input.hostOrganizationId),
        organizationId: input.hostOrganizationId,
        orderId: input.orderId,
        eventId: input.eventId,
        entryType: 'host_payout',
        amount: split.hostPayout,
        status: 'pending',
        idempotencyKey: idempotencyKey(input.orderId, 'host_payout', input.hostOrganizationId),
        now,
      }),
    ];

    if (input.promoterOrganizationId && split.promoterCommission > 0) {
      entries.push(
        createLedgerEntry({
          id: entryId(input.orderId, 'promoter_commission', input.promoterOrganizationId),
          organizationId: input.promoterOrganizationId,
          orderId: input.orderId,
          eventId: input.eventId,
          entryType: 'promoter_commission',
          amount: split.promoterCommission,
          status: 'pending',
          idempotencyKey: idempotencyKey(
            input.orderId,
            'promoter_commission',
            input.promoterOrganizationId,
          ),
          now,
        }),
      );
    }

    if (frozen) {
      const validateExisting = (rows: LedgerEntry[]): void => {
        const saleRows = rows.filter((row) => row.entryType !== 'refund');
        for (const row of saleRows) {
          const expected = entries.find((candidate) => candidate.entryType === row.entryType);
          if (
            !expected ||
            saleRows.filter((candidate) => candidate.entryType === row.entryType).length !== 1 ||
            row.orderId !== expected.orderId ||
            row.eventId !== expected.eventId ||
            row.organizationId !== expected.organizationId ||
            row.amount !== expected.amount
          )
            throw new InvalidOperationError(
              'Original sale allocation conflicts with immutable ledger',
            );
        }
      };
      validateExisting(existing);
      const missing = entries.filter(
        (entry) => !existing.some((row) => row.entryType === entry.entryType),
      );
      if (missing.length > 0) await ledger.createBatch(missing);
      const persisted = await ledger.findByOrder(input.orderId);
      validateExisting(persisted);
      if (entries.some((entry) => !persisted.some((row) => row.entryType === entry.entryType)))
        throw new InvalidOperationError('Original sale compatibility ledger is incomplete');
      return persisted;
    }
    return ledger.createBatch(entries);
  }

  async function getBalances(
    organizationId: EntityId,
    actor: ActorContext,
  ): Promise<BalanceSummary> {
    requireOrgAccess(actor, organizationId);
    const transition = await deps.journalTransition.get();
    if (transition.readModel === 'financial_journal_v2') {
      const [lines, reserved, paid] = await Promise.all([
        deps.financialJournals.listPayableLinesByOrganization(organizationId),
        deps.payouts.sumRequestedOrProcessingByOrganization(organizationId),
        deps.payouts.sumPaidByOrganization(organizationId),
      ]);
      const unresolved: ReconciliationDiscrepancy[] = [];
      let discrepancyCursor: string | null = null;
      do {
        const page = await deps.reconciliations.listDiscrepancies({
          organizationId,
          cursor: discrepancyCursor,
          limit: 250,
        });
        unresolved.push(...page.items.filter((item) => item.state !== 'resolved'));
        discrepancyCursor = page.nextCursor;
      } while (discrepancyCursor !== null);
      const disputes: Dispute[] = [];
      if (deps.financialExposure) {
        let cursor: string | null = null;
        do {
          const page = await deps.financialExposure.disputes.listByOrganization(organizationId, {
            cursor,
            limit: 250,
          });
          disputes.push(...page.items.filter((item) => item.status !== 'resolved'));
          cursor = page.nextCursor;
        } while (cursor !== null);
      }
      let net = 0;
      let pending = 0;
      let policyReserve = 0;
      let cancellationHeld = 0;
      let lifetime = 0;
      let totalEligible = 0;
      let totalRemaining = 0;
      let refundHeld = 0;
      let disputeHeld = 0;
      let providerHeld = 0;
      let reconciliationHeld = 0;
      const chargebackHolds = new Map<EntityId, { amountPaise: number; closed: boolean }>();
      const eventCache = new Map<EntityId, Awaited<ReturnType<EventRepository['getById']>>>();
      const orderBalances = new Map<
        EntityId,
        { credits: (typeof lines)[number][]; debitPaise: number }
      >();
      for (const payableLine of lines) {
        net += payableLine.side === 'credit' ? payableLine.amountPaise : -payableLine.amountPaise;
        if (payableLine.source.type === 'chargeback' && payableLine.side === 'debit') {
          const current = chargebackHolds.get(payableLine.source.id);
          chargebackHolds.set(payableLine.source.id, {
            amountPaise: (current?.amountPaise ?? 0) + payableLine.amountPaise,
            closed: current?.closed ?? false,
          });
        } else if (
          payableLine.source.type === 'chargeback_reversal' ||
          payableLine.source.type === 'chargeback_loss'
        ) {
          const current = chargebackHolds.get(payableLine.source.id);
          chargebackHolds.set(payableLine.source.id, {
            amountPaise: current?.amountPaise ?? 0,
            closed: true,
          });
        }
        if (payableLine.source.orderId !== null) {
          const group = orderBalances.get(payableLine.source.orderId) ?? {
            credits: [],
            debitPaise: 0,
          };
          if (payableLine.side === 'credit') group.credits.push(payableLine);
          else group.debitPaise += payableLine.amountPaise;
          orderBalances.set(payableLine.source.orderId, group);
        }
        if (payableLine.side === 'credit' && payableLine.source.type !== 'payout_failure_reversal')
          lifetime += payableLine.amountPaise;
      }
      for (const [orderId, group] of orderBalances) {
        const remaining = Math.max(
          0,
          group.credits.reduce((sum, row) => sum + row.amountPaise, 0) - group.debitPaise,
        );
        const representative = group.credits[0];
        if (!representative || remaining === 0) continue;
        totalRemaining += remaining;
        const eventId = representative.source.eventId;
        let event = eventId ? eventCache.get(eventId) : null;
        if (event === undefined && eventId) {
          event = await deps.events.getById(eventId);
          eventCache.set(eventId, event);
        }
        const staged = stagedSettlement(event ?? null, remaining, config.clock.now());
        pending += staged.pendingPaise;
        policyReserve += staged.reservePaise;
        cancellationHeld += staged.cancellationPaise;
        totalEligible += staged.eligiblePaise;
        let available = staged.eligiblePaise;
        if (available === 0) continue;
        const exposure = deps.financialExposure;
        if (!exposure) {
          providerHeld += available;
          continue;
        }
        const [order, requests] = await Promise.all([
          exposure.orders.getById(orderId),
          exposure.refundRequests.listByOrder(orderId),
        ]);
        if (
          !order ||
          order.eventId !== eventId ||
          order.fulfillmentState === 'pending' ||
          !['paid', 'refund_requested', 'refunded'].includes(order.status)
        ) {
          providerHeld += available;
          continue;
        }
        const active = requests.filter((request) =>
          ['pending', 'approved', 'executing'].includes(request.status),
        );
        const refundExposure = active.length
          ? active.reduce((sum, request) => sum + request.amountPaise, 0)
          : order.status === 'refund_requested'
            ? remaining
            : 0;
        const refund = Math.min(available, refundExposure);
        refundHeld += refund;
        available -= refund;
        const businessExposure = disputes
          .filter((dispute) => dispute.orderId === orderId)
          .reduce((sum, dispute) => sum + dispute.amount, 0);
        const businessHold = Math.min(available, businessExposure);
        disputeHeld += businessHold;
        available -= businessHold;
        const payment = order.paymentId
          ? await exposure.providerPayments.findByPaymentId(order.paymentId)
          : null;
        let uncertain =
          order.grandTotalPaise > 0 &&
          (!payment ||
            !['fulfilled', 'refunded'].includes(payment.processingState) ||
            payment.orderId !== order.id ||
            payment.currency !== order.currency ||
            payment.capturedPaise !== order.grandTotalPaise)
            ? remaining
            : 0;
        if (payment) {
          uncertain = Math.max(
            uncertain,
            Object.values(payment.refunds).reduce((sum, amount) => sum + amount, 0) -
              order.refundedPaise,
          );
          const unpostedDisputes = Object.entries(payment.disputes)
            .filter(
              ([id, dispute]) =>
                !['won', 'closed'].includes(dispute.status) && !chargebackHolds.has(id),
            )
            .reduce((sum, [, dispute]) => sum + dispute.amountPaise, 0);
          const held = Math.min(available, unpostedDisputes);
          disputeHeld += held;
          available -= held;
        }
        const provider = Math.min(available, Math.max(0, uncertain));
        providerHeld += provider;
        available -= provider;
        const scoped = unresolved.filter(
          (item) =>
            item.orderId === orderId ||
            (item.orderId === null &&
              item.paymentId !== null &&
              item.paymentId === order.paymentId),
        );
        const risks = new Map<string, number>();
        for (const item of scoped)
          risks.set(
            `${item.kind}:${item.paymentId ?? ''}`,
            Math.max(
              risks.get(`${item.kind}:${item.paymentId ?? ''}`) ?? 0,
              item.amountPaise ?? remaining,
            ),
          );
        reconciliationHeld += Math.min(
          available,
          [...risks.values()].reduce((sum, amount) => sum + amount, 0),
        );
      }
      // Unknown-scope evidence cannot safely be assigned to a particular order.
      const unscoped: ReconciliationDiscrepancy[] = [];
      for (const item of unresolved) {
        if (item.orderId !== null) {
          if (!orderBalances.has(item.orderId)) unscoped.push(item);
        } else if (item.paymentId === null) {
          unscoped.push(item);
        } else {
          const payment = await deps.financialExposure?.providerPayments.findByPaymentId(
            item.paymentId,
          );
          if (!payment?.orderId || !orderBalances.has(payment.orderId)) unscoped.push(item);
        }
      }
      const unscopedAmount = unscoped.some((item) => item.amountPaise === null)
        ? totalEligible
        : unscoped.reduce((sum, item) => sum + (item.amountPaise ?? 0), 0);
      reconciliationHeld += Math.min(
        Math.max(0, totalEligible - refundHeld - disputeHeld - providerHeld - reconciliationHeld),
        unscopedAmount,
      );
      const chargebackHeld = [...chargebackHolds.values()].reduce(
        (sum, hold) => sum + (hold.closed ? 0 : hold.amountPaise),
        0,
      );
      const commitments = Math.max(0, totalRemaining - net, reserved + paid);
      return {
        availablePaise: Math.max(
          0,
          totalEligible -
            refundHeld -
            disputeHeld -
            providerHeld -
            reconciliationHeld -
            commitments,
        ),
        pendingPaise: pending,
        reservedPaise: reserved,
        heldPaise:
          chargebackHeld +
          policyReserve +
          cancellationHeld +
          refundHeld +
          disputeHeld +
          providerHeld +
          reconciliationHeld,
        paidPaise: paid,
        lifetimePaise: lifetime,
        holds: {
          reservePaise: policyReserve,
          cancellationPaise: cancellationHeld,
          chargebackPaise: chargebackHeld,
          reconciliationPaise: reconciliationHeld,
          refundPaise: refundHeld,
          disputePaise: disputeHeld,
          providerUncertaintyPaise: providerHeld,
        },
        readModel: 'financial_journal_v2',
        settlementUnavailableReason: null,
      };
    }

    const [sums, reserved, paid] = await Promise.all([
      ledger.sumByOrganizationAndType(organizationId),
      deps.payouts.sumRequestedOrProcessingByOrganization(organizationId),
      deps.payouts.sumPaidByOrganization(organizationId),
    ]);

    // Available = settled inflows credited to this org (host_payout/venue_share/
    // promoter_commission once settled) minus whatever has already been paid out.
    // Pending = the same legs while still pending settlement.
    let pending = 0;
    let settled = 0;
    let paidOut = 0;
    for (const entryType of ['host_payout', 'venue_share', 'promoter_commission'] as const) {
      pending += sums[entryType].pending;
      settled += sums[entryType].settled;
      paidOut += sums[entryType].paidOut;
    }

    // Keep cancellation holds within the selected legacy read model. We do
    // not combine journal totals here: settled legacy payable entries for a
    // cancelled event are simply withheld until the controlled journal
    // cutover (or the legacy records are resolved).
    let cancellationHeld = 0;
    let cursor: string | null = null;
    const eventCache = new Map<EntityId, Awaited<ReturnType<EventRepository['getById']>>>();
    do {
      const page = await ledger.listByOrganization(organizationId, { cursor, limit: 250 });
      for (const entry of page.items) {
        if (
          entry.status !== 'settled' ||
          !['host_payout', 'venue_share', 'promoter_commission'].includes(entry.entryType)
        ) {
          continue;
        }
        let event = eventCache.get(entry.eventId);
        if (event === undefined) {
          event = await deps.events.getById(entry.eventId);
          eventCache.set(entry.eventId, event);
        }
        if (event?.status === 'cancelled') cancellationHeld += entry.amount;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    return {
      availablePaise: 0,
      pendingPaise: pending + Math.max(0, settled - paidOut - reserved - paid - cancellationHeld),
      reservedPaise: reserved,
      heldPaise: cancellationHeld,
      paidPaise: paid,
      lifetimePaise: pending + settled + paidOut,
      holds: {
        reservePaise: 0,
        cancellationPaise: cancellationHeld,
        chargebackPaise: 0,
        reconciliationPaise: 0,
      },
      readModel: 'legacy_ledger_v1',
      settlementUnavailableReason:
        'Settlement eligibility requires the controlled journal transition.',
    };
  }

  async function listLedgerEntries(
    organizationId: EntityId,
    actor: ActorContext,
    query: { cursor?: string | null; limit: number },
  ): Promise<{ items: LedgerEntry[]; total: number; nextCursor: string | null }> {
    requireOrgAccess(actor, organizationId);
    return ledger.listByOrganization(organizationId, query);
  }

  return { recordTicketSale, getBalances, listLedgerEntries };
}
