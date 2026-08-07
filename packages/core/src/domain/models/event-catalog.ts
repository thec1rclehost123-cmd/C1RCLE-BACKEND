import { InvalidOperationError } from '../errors.js';
import { newVersionedEntity, bumpVersion } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Event catalog ─────────────────────────────────────────────────────────
 * Pricing/promotion/capacity primitives that belong to an event's sales
 * surface. PromoterAssignment carries *versioned* commission terms so past
 * payouts keep their agreed rates if commissions change later.
 */

// ─── Ticket tiers ────────────────────────────────────────────────────────────

export type TicketTierStatus = 'active' | 'paused' | 'sold_out';

export interface TicketTier extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  /** Price in rupees (integer paise avoided to keep money as integers). */
  priceInPaise: number;
  /** Live sellable quantity; runs through inventory-service at sell time. */
  quantity: number;
  status: TicketTierStatus;
  salesStartAt: string | null;
  salesEndAt: string | null;
}

export interface CreateTicketTierInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  priceInPaise: number;
  quantity: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  now?: Date;
}

export function createTicketTier(input: CreateTicketTierInput): TicketTier {
  if (input.quantity < 0)
    throw new InvalidOperationError('Ticket tier quantity cannot be negative');
  if (input.priceInPaise < 0)
    throw new InvalidOperationError('Ticket tier price cannot be negative');
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    name: input.name,
    priceInPaise: input.priceInPaise,
    quantity: input.quantity,
    status: 'active',
    salesStartAt: input.salesStartAt ?? null,
    salesEndAt: input.salesEndAt ?? null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

export function updateTicketTier(
  tier: TicketTier,
  changes: Partial<
    Pick<TicketTier, 'name' | 'priceInPaise' | 'quantity' | 'salesStartAt' | 'salesEndAt'>
  >,
  now?: Date,
): TicketTier {
  if (changes.priceInPaise !== undefined && changes.priceInPaise < 0) {
    throw new InvalidOperationError('Ticket tier price cannot be negative');
  }
  return bumpVersion({ ...tier, ...changes }, now ?? new Date());
}

// ─── Promo codes ──────────────────────────────────────────────────────────────

export type PromoDiscountType = 'percent' | 'fixed';

export interface PromoCode extends VersionedEntity {
  id: EntityId;
  eventId: EntityId | null;
  organizationId: EntityId;
  code: string;
  discountType: PromoDiscountType;
  /** Percent (0–100) when `percent`; paise when `fixed`. */
  discountValue: number;
  maxUses: number | null;
  usedCount: number;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
}

export interface CreatePromoCodeInput {
  id: EntityId;
  eventId: EntityId | null;
  organizationId: EntityId;
  code: string;
  discountType: PromoDiscountType;
  discountValue: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  now?: Date;
}

export function createPromoCode(input: CreatePromoCodeInput): PromoCode {
  if (input.discountType === 'percent' && (input.discountValue <= 0 || input.discountValue > 100)) {
    throw new InvalidOperationError('Percent discount must be > 0 and <= 100');
  }
  if (input.discountType === 'fixed' && input.discountValue < 0) {
    throw new InvalidOperationError('Fixed discount cannot be negative');
  }
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    code: input.code.toUpperCase().trim(),
    discountType: input.discountType,
    discountValue: input.discountValue,
    maxUses: input.maxUses ?? null,
    usedCount: 0,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    isActive: true,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** Records one redemption (saturated at never above maxUses). */
export function markPromoUsed(promo: PromoCode, now?: Date): PromoCode {
  if (promo.maxUses !== null && promo.usedCount >= promo.maxUses) {
    throw new InvalidOperationError('Promo code usage limit reached');
  }
  return bumpVersion({ ...promo, usedCount: promo.usedCount + 1 }, now ?? new Date());
}

// ─── Table packages ───────────────────────────────────────────────────────────

export interface TablePackage extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  /** Minimum spend to reserve (paise). */
  minSpendPaise: number | null;
  capacity: number;
  pricePaise: number;
  isActive: boolean;
}

export interface CreateTablePackageInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  minSpendPaise?: number | null;
  capacity: number;
  pricePaise: number;
  now?: Date;
}

export function createTablePackage(input: CreateTablePackageInput): TablePackage {
  if (input.capacity <= 0) throw new InvalidOperationError('Table capacity must be positive');
  if (input.pricePaise < 0) throw new InvalidOperationError('Table price cannot be negative');
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    name: input.name,
    minSpendPaise: input.minSpendPaise ?? null,
    capacity: input.capacity,
    pricePaise: input.pricePaise,
    isActive: true,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

// ─── Promoter assignments (versioned commission terms) ───────────────────────

export interface CommissionTerms {
  /** Which number was in force at assignment time. */
  version: number;
  /** Percentage of eligible sales paid to the promoter. */
  ratePercent: number;
  /** Optional fixed fee (paise). */
  flatPaise: number;
}

export interface PromoterAssignment extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  status: PromoterAssignmentStatus;
  /** Commission terms frozen at assignment time. */
  terms: CommissionTerms;
  createdAt: string;
  /** When the assignment was revoked/unlinked, if ever. */
  endedAt: string | null;
}

export type PromoterAssignmentStatus = 'active' | 'ended';

export interface CreatePromoterAssignmentInput {
  id: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  terms: CommissionTerms;
  now?: Date;
}

export function createPromoterAssignment(input: CreatePromoterAssignmentInput): PromoterAssignment {
  if (input.terms.ratePercent < 0 || input.terms.ratePercent > 100) {
    throw new InvalidOperationError('Commission rate must be between 0 and 100');
  }
  if (input.terms.flatPaise < 0)
    throw new InvalidOperationError('Commission fee cannot be negative');
  if (input.terms.version < 1)
    throw new InvalidOperationError('Commission terms version must be >= 1');
  return {
    id: input.id,
    eventId: input.eventId,
    promoterId: input.promoterId,
    status: 'active',
    terms: input.terms,
    endedAt: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** Ends an assignment without mutating its frozen terms. */
export function endPromoterAssignment(
  assignment: PromoterAssignment,
  now?: Date,
): PromoterAssignment {
  if (assignment.status === 'ended') return assignment;
  const stamped = bumpVersion(assignment, now ?? new Date());
  return { ...stamped, status: 'ended', endedAt: (now ?? new Date()).toISOString() };
}
