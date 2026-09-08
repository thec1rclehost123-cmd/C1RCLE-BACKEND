import { createHash } from 'node:crypto';

import { computeSettlementSplit, createLedgerEntry } from '../../domain/models/ledger.js';
import { requireOrgAccess } from '../context.js';

import type { EntityId } from '../../domain/identity.js';
import type { LedgerEntry, LedgerEntryType } from '../../domain/models/ledger.js';
import type { LedgerRepository } from '../../domain/ports/repositories.js';
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
}

export interface BalanceSummary {
  availablePaise: number;
  pendingPaise: number;
  lifetimePaise: number;
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

    const split = computeSettlementSplit(
      input.grossAmount,
      input.platformFeeRate,
      input.venueShareRate,
      input.promoterCommissionRate,
    );
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
    const sums = await ledger.sumByOrganizationAndType(organizationId);

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
      availablePaise: settled - paidOut,
      pendingPaise: pending,
      lifetimePaise: pending + settled + paidOut,
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
