import { newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Partner Ledger (Phase 6) ──────────────────────────────────────────────────
 *
 * Append-only settlement ledger. All amounts in integer paise. The ledger is
 * the ONLY source of truth for partner balances — never trust a cache without
 * being able to rebuild it from these entries (see `finance-service.ts`).
 *
 * One ticket sale produces up to 5 entries in the same idempotent write:
 * ticket_revenue (platform, settled) + platform_fee (host->platform,
 * settled) + venue_share (host->venue, pending) + host_payout (->host,
 * pending) + promoter_commission (host->promoter, pending, optional).
 * Invariant: platformFee + venueShare + promoterCommission + hostPayout ==
 * grossAmount.
 */

export type LedgerEntryType =
  | 'ticket_revenue'
  | 'platform_fee'
  | 'venue_share'
  | 'host_payout'
  | 'promoter_commission'
  | 'refund';

export type LedgerEntryStatus = 'pending' | 'settled' | 'paid_out';

export interface LedgerEntry extends VersionedEntity {
  id: EntityId;
  organizationId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  entryType: LedgerEntryType;
  /** Amount in paise. Always non-negative; direction is implied by `entryType`. */
  amount: number;
  status: LedgerEntryStatus;
  /** Idempotency guard: one ledger write per (orderId, entryType). */
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerSettlementSplit {
  platformFee: number;
  venueShare: number;
  promoterCommission: number;
  hostPayout: number;
}

/**
 * Proven v1 formula (`thec1rcle/apps/api-gateway/src/services/unified/finance-service.ts:494-501`).
 * Rounds each share independently, then derives hostPayout as the remainder
 * so the four legs always sum exactly to `grossAmount` (never off-by-a-paise
 * from independent rounding).
 */
export function computeSettlementSplit(
  grossAmount: number,
  platformFeeRate: number,
  venueShareRate: number,
  promoterCommissionRate: number | null,
): LedgerSettlementSplit {
  const platformFee = Math.round(grossAmount * platformFeeRate);
  const venueShare = Math.round(grossAmount * venueShareRate);
  const promoterCommission =
    promoterCommissionRate !== null ? Math.round(grossAmount * promoterCommissionRate) : 0;
  const hostPayout = grossAmount - platformFee - venueShare - promoterCommission;
  return { platformFee, venueShare, promoterCommission, hostPayout };
}

export function createLedgerEntry(input: {
  id: EntityId;
  organizationId: EntityId;
  orderId: EntityId;
  eventId: EntityId;
  entryType: LedgerEntryType;
  amount: number;
  status: LedgerEntryStatus;
  idempotencyKey: string;
  now?: Date;
}): LedgerEntry {
  const now = input.now ?? new Date();
  return {
    id: input.id,
    organizationId: input.organizationId,
    orderId: input.orderId,
    eventId: input.eventId,
    entryType: input.entryType,
    amount: input.amount,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    ...newVersionedEntity(now),
  };
}

/** Plan-tier -> platform fee rate. No proven v1 table exists; defined per roadmap. */
export const PLAN_TIER_PLATFORM_FEE_RATE: Record<string, number> = {
  basic: 0.15,
  silver: 0.12,
  gold: 0.12,
  diamond: 0.1,
};

export function platformFeeRateForTier(tier: string | null | undefined): number {
  if (!tier) return PLAN_TIER_PLATFORM_FEE_RATE.basic ?? 0.15;
  return PLAN_TIER_PLATFORM_FEE_RATE[tier] ?? PLAN_TIER_PLATFORM_FEE_RATE.basic ?? 0.15;
}
