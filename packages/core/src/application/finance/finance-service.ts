import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../../domain/errors.js';
import { computeSettlementSplit, createLedgerEntry } from '../../domain/models/ledger.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { LedgerEntry, LedgerEntryType } from '../../domain/models/ledger.js';
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
}

export interface RecordTicketSaleInput {
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
  };
  readModel: 'legacy_ledger_v1' | 'financial_journal_v2';
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
    if (existing.length > 0) {
      // Already recorded — idempotent replay, not a re-computation.
      return existing;
    }

    const calculated = computeSettlementSplit(
      input.grossAmount,
      input.platformFeeRate,
      input.venueShareRate,
      input.promoterCommissionRate,
    );
    const promoterCommission = input.promoterCommissionPaise ?? calculated.promoterCommission;
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

    return ledger.createBatch(entries);
  }

  async function getBalances(
    organizationId: EntityId,
    actor: ActorContext,
  ): Promise<BalanceSummary> {
    requireOrgAccess(actor, organizationId);
    const transition = await deps.journalTransition.get();
    if (transition.readModel === 'financial_journal_v2') {
      const [lines, reserved, paid, unresolved] = await Promise.all([
        deps.financialJournals.listPayableLinesByOrganization(organizationId),
        deps.payouts.sumRequestedOrProcessingByOrganization(organizationId),
        deps.payouts.sumPaidByOrganization(organizationId),
        deps.reconciliations.listDiscrepancies({ organizationId, limit: 1_000 }),
      ]);
      let net = 0;
      let pending = 0;
      let policyReserve = 0;
      const chargebackHolds = new Map<EntityId, { amountPaise: number; closed: boolean }>();
      let cancellationHeld = 0;
      let lifetime = 0;
      let holdOnUnresolvedReconciliation = false;
      const eventCache = new Map<EntityId, Awaited<ReturnType<EventRepository['getById']>>>();
      const orderBalances = new Map<
        EntityId,
        {
          credits: (typeof lines)[number][];
          debitPaise: number;
        }
      >();
      for (const payableLine of lines) {
        const signed =
          payableLine.side === 'credit' ? payableLine.amountPaise : -payableLine.amountPaise;
        net += signed;
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
        if (
          payableLine.side !== 'credit' ||
          payableLine.source.type === 'payout_failure_reversal'
        ) {
          continue;
        }
        lifetime += payableLine.amountPaise;
        holdOnUnresolvedReconciliation ||=
          payableLine.accountingPolicy.holdsOnUnresolvedReconciliation;
      }

      // Classify the remaining liability for each order, not its historical
      // gross credit. Refund/adjustment/chargeback debits therefore reduce the
      // amount that can still be pending, reserved, or cancellation-held.
      for (const group of orderBalances.values()) {
        const creditPaise = group.credits.reduce((sum, line) => sum + line.amountPaise, 0);
        const remainingPaise = Math.max(0, creditPaise - group.debitPaise);
        const representative = group.credits[0];
        if (!representative || remainingPaise === 0) continue;
        const eligibleAt =
          new Date(representative.postedAt).getTime() +
          representative.accountingPolicy.settlementDelayDays * 86_400_000;
        let eventComplete = true;
        if (
          (representative.accountingPolicy.requiresEventCompletion ||
            representative.accountingPolicy.holdsOnCancellation) &&
          representative.source.eventId !== null
        ) {
          let event = eventCache.get(representative.source.eventId);
          if (event === undefined) {
            event = await deps.events.getById(representative.source.eventId);
            eventCache.set(representative.source.eventId, event);
          }
          if (representative.accountingPolicy.requiresEventCompletion) {
            eventComplete = event?.status === 'ended' || event?.status === 'archived';
          }
        }
        const event =
          representative.source.eventId === null
            ? null
            : (eventCache.get(representative.source.eventId) ?? null);
        if (representative.accountingPolicy.holdsOnCancellation && event?.status === 'cancelled') {
          cancellationHeld += remainingPaise;
        } else if (config.clock.now().getTime() < eligibleAt || !eventComplete) {
          pending += remainingPaise;
        } else {
          policyReserve += Math.round(
            (remainingPaise * representative.accountingPolicy.reserveBasisPoints) / 10_000,
          );
        }
      }
      const chargebackHeld = [...chargebackHolds.values()].reduce(
        (sum, hold) => sum + (hold.closed ? 0 : hold.amountPaise),
        0,
      );
      const unresolvedForOrganization = unresolved.items.filter(
        (item) => item.state !== 'resolved',
      );
      const reconciliationHeld = !holdOnUnresolvedReconciliation
        ? 0
        : unresolvedForOrganization.some((item) => item.amountPaise === null)
          ? Math.max(0, net - pending - policyReserve - cancellationHeld)
          : Math.min(
              Math.max(0, net - pending - policyReserve - cancellationHeld),
              unresolvedForOrganization.reduce((sum, item) => sum + (item.amountPaise ?? 0), 0),
            );
      return {
        availablePaise: Math.max(
          0,
          net - pending - policyReserve - cancellationHeld - reconciliationHeld,
        ),
        pendingPaise: pending,
        reservedPaise: reserved,
        heldPaise: chargebackHeld + policyReserve + cancellationHeld + reconciliationHeld,
        paidPaise: paid,
        lifetimePaise: lifetime,
        holds: {
          reservePaise: policyReserve,
          cancellationPaise: cancellationHeld,
          chargebackPaise: chargebackHeld,
          reconciliationPaise: reconciliationHeld,
        },
        readModel: 'financial_journal_v2',
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

    return {
      availablePaise: settled - paidOut - reserved - paid,
      pendingPaise: pending,
      reservedPaise: reserved,
      heldPaise: 0,
      paidPaise: paid,
      lifetimePaise: pending + settled + paidOut,
      holds: {
        reservePaise: 0,
        cancellationPaise: 0,
        chargebackPaise: 0,
        reconciliationPaise: 0,
      },
      readModel: 'legacy_ledger_v1',
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
