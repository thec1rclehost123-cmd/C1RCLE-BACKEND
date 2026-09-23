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
export type TicketAccessType = 'ENTRY' | 'VIP' | 'VVIP' | 'TABLE' | 'PACKAGE' | 'RSVP';
export type TicketAudienceType = 'GENERAL' | 'MALE' | 'FEMALE' | 'COUPLE' | 'GROUP';

export interface TicketPricingPhase {
  id: string;
  name: string;
  priceInPaise: number;
  startsAt: string;
  endsAt: string;
  quantity: number | null;
}

export interface PartialDateTicketPricingPhaseInput {
  id: string;
  name: string;
  priceInPaise: number;
  startDate: string;
  endDate: string;
  quantity: number | null;
}

export type CreateTicketPricingPhaseInput = PartialDateTicketPricingPhaseInput | TicketPricingPhase;

function resolvePricingPhase(input: CreateTicketPricingPhaseInput, now: Date): TicketPricingPhase {
  if ('startsAt' in input) return input;
  const dateParts = (value: string) => {
    const match = /^(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new InvalidOperationError('Phase dates must use DD-MM');
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31)
      throw new InvalidOperationError('Invalid phase date');
    return { day, month };
  };
  const startDate = dateParts(input.startDate);
  const endDate = dateParts(input.endDate);
  // Event calendar dates use the current editor timezone: Asia/Kolkata (UTC+05:30).
  const localNow = new Date(now.getTime() + 330 * 60_000);
  const validDay = (date: { day: number; month: number }, year: number) => {
    const stamp = Date.UTC(year, date.month - 1, date.day);
    return (
      new Date(stamp).getUTCMonth() === date.month - 1 && new Date(stamp).getUTCDate() === date.day
    );
  };
  const isoAt = (
    date: { day: number; month: number },
    time: { hour: number; minute: number; second?: number; millisecond?: number },
    year: number,
  ) =>
    new Date(
      Date.UTC(
        year,
        date.month - 1,
        date.day,
        time.hour,
        time.minute,
        time.second ?? 0,
        time.millisecond ?? 0,
      ) -
        330 * 60_000,
    ).toISOString();
  const localTodayStamp = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  );
  let startYear = localNow.getUTCFullYear();
  let startsAt = '';
  for (let yearOffset = 0; yearOffset <= 8; yearOffset += 1) {
    const year = startYear + yearOffset;
    if (!validDay(startDate, year)) continue;
    const candidate = Date.UTC(year, startDate.month - 1, startDate.day);
    if (candidate >= localTodayStamp) {
      startYear = year;
      startsAt = isoAt(startDate, { hour: 0, minute: 0 }, year);
      break;
    }
  }
  if (!startsAt) throw new InvalidOperationError('Could not resolve phase start date');
  let endYear = startYear;
  const startTuple = startDate.month * 100 + startDate.day;
  const endTuple = endDate.month * 100 + endDate.day;
  if (endTuple < startTuple) endYear += 1;
  let resolvedEndDate = false;
  for (let yearOffset = 0; yearOffset <= 8; yearOffset += 1) {
    if (validDay(endDate, endYear + yearOffset)) {
      endYear += yearOffset;
      resolvedEndDate = true;
      break;
    }
  }
  if (!resolvedEndDate) throw new InvalidOperationError('Could not resolve phase end date');
  const endExclusiveDate = new Date(Date.UTC(endYear, endDate.month - 1, endDate.day + 1));
  endYear = endExclusiveDate.getUTCFullYear();
  const endExclusive = {
    day: endExclusiveDate.getUTCDate(),
    month: endExclusiveDate.getUTCMonth() + 1,
  };
  const endsAt = isoAt(endExclusive, { hour: 0, minute: 0 }, endYear);
  if (Date.parse(startsAt) >= Date.parse(endsAt))
    throw new InvalidOperationError('Pricing phase must start before it ends');
  return {
    id: input.id,
    name: input.name,
    priceInPaise: input.priceInPaise,
    startsAt,
    endsAt,
    quantity: input.quantity,
  };
}

export interface TicketTier extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  description: string;
  /** Entry class shown to guests (V1 `entryType`, default 'general'). */
  entryType: string;
  /** ISO 4217; V1 default 'INR'. */
  currency: string;
  /** Price in paise. */
  priceInPaise: number;
  /** Live sellable quantity; runs through inventory-service at sell time. */
  quantity: number;
  status: TicketTierStatus;
  salesStartAt: string | null;
  salesEndAt: string | null;
  /** Maximum tickets that can be purchased per order. */
  maxPerOrder: number | null;
  accessType?: TicketAccessType;
  audienceType?: TicketAudienceType;
  guestCount?: number;
  pricingPhases?: TicketPricingPhase[];
  doorPriceInPaise?: number | null;
  benefits?: string[];
  minAge?: number | null;
  maxAge?: number | null;
  minPerOrder?: number | null;
  maxPerUser?: number | null;
  tableConfig?: {
    capacity: number;
    minimumSpendPaise: number;
    redeemableAmountPaise: number;
    tableCount: number;
  } | null;
  commissionEligible?: boolean;
}

export interface CreateTicketTierInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  name: string;
  description?: string;
  entryType?: string;
  currency?: string;
  priceInPaise?: number;
  quantity: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  maxPerOrder?: number | null;
  accessType?: TicketAccessType;
  audienceType?: TicketAudienceType;
  guestCount?: number;
  pricingPhases?: CreateTicketPricingPhaseInput[];
  doorPriceInPaise?: number | null;
  benefits?: string[];
  minAge?: number | null;
  maxAge?: number | null;
  minPerOrder?: number | null;
  maxPerUser?: number | null;
  tableConfig?: TicketTier['tableConfig'];
  commissionEligible?: boolean;
  now?: Date;
}

export function createTicketTier(input: CreateTicketTierInput): TicketTier {
  const accessType = input.accessType ?? 'ENTRY';
  const priceInPaise = input.priceInPaise ?? 0;
  if (
    accessType === 'RSVP' &&
    (input.priceInPaise !== undefined ||
      input.pricingPhases?.length ||
      input.commissionEligible !== undefined ||
      input.doorPriceInPaise !== undefined)
  )
    throw new InvalidOperationError(
      'RSVP tickets cannot include price, phases, door price, or commission',
    );
  if (accessType !== 'RSVP' && priceInPaise <= 0)
    throw new InvalidOperationError('Paid tickets require a positive price');
  if (input.quantity < 0)
    throw new InvalidOperationError('Ticket tier quantity cannot be negative');
  if (priceInPaise < 0) throw new InvalidOperationError('Ticket tier price cannot be negative');
  const guestCount = input.guestCount ?? 1;
  if (!Number.isInteger(guestCount) || guestCount < 1)
    throw new InvalidOperationError('Guest count must be at least 1');
  if (input.minPerOrder !== null && input.minPerOrder !== undefined && input.minPerOrder < 1)
    throw new InvalidOperationError('Minimum tickets per order must be positive');
  if (input.maxPerUser !== null && input.maxPerUser !== undefined && input.maxPerUser < 1)
    throw new InvalidOperationError('Maximum tickets per user must be positive');
  if (input.minPerOrder && input.maxPerOrder && input.minPerOrder > input.maxPerOrder)
    throw new InvalidOperationError('Minimum tickets per order cannot exceed maximum');
  const phases = (input.pricingPhases ?? []).map((phase) =>
    resolvePricingPhase(phase, input.now ?? new Date()),
  );
  if (
    input.salesStartAt &&
    input.salesEndAt &&
    Date.parse(input.salesStartAt) >= Date.parse(input.salesEndAt)
  )
    throw new InvalidOperationError('Ticket sales must start before they end');
  for (const phase of phases) {
    if (phase.priceInPaise <= 0 || (phase.quantity !== null && phase.quantity < 0))
      throw new InvalidOperationError(
        'Paid phase prices must be positive and quantities cannot be negative',
      );
    if (Date.parse(phase.startsAt) >= Date.parse(phase.endsAt))
      throw new InvalidOperationError('Pricing phase must start before it ends');
  }
  const sortedPhases = [...phases].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (let index = 1; index < sortedPhases.length; index += 1) {
    const prevPhase = sortedPhases[index - 1];
    const currPhase = sortedPhases[index];
    if (prevPhase && currPhase && Date.parse(prevPhase.endsAt) > Date.parse(currPhase.startsAt))
      throw new InvalidOperationError('Pricing phases cannot overlap');
  }
  if (accessType === 'TABLE' && !input.tableConfig)
    throw new InvalidOperationError('Table tickets require table configuration');
  if (
    input.tableConfig &&
    (input.tableConfig.capacity < 1 ||
      input.tableConfig.tableCount < 1 ||
      input.tableConfig.minimumSpendPaise < 0 ||
      input.tableConfig.redeemableAmountPaise < 0)
  )
    throw new InvalidOperationError('Invalid table configuration');
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    name: input.name,
    description: input.description ?? '',
    entryType: input.entryType ?? 'general',
    currency: input.currency ?? 'INR',
    priceInPaise,
    quantity: input.quantity,
    status: 'active',
    salesStartAt: input.salesStartAt ?? null,
    salesEndAt: input.salesEndAt ?? null,
    maxPerOrder: input.maxPerOrder ?? null,
    accessType,
    audienceType: input.audienceType ?? 'GENERAL',
    guestCount,
    pricingPhases: accessType === 'RSVP' ? [] : phases,
    doorPriceInPaise: accessType === 'RSVP' ? null : (input.doorPriceInPaise ?? null),
    benefits: input.benefits ?? [],
    minAge: input.minAge ?? null,
    maxAge: input.maxAge ?? null,
    minPerOrder: input.minPerOrder ?? null,
    maxPerUser: input.maxPerUser ?? null,
    tableConfig: input.tableConfig ?? null,
    commissionEligible:
      accessType === 'RSVP' ? false : (input.commissionEligible ?? priceInPaise > 0),
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

export function updateTicketTier(
  tier: TicketTier,
  changes: Partial<
    Pick<
      TicketTier,
      | 'name'
      | 'description'
      | 'entryType'
      | 'currency'
      | 'priceInPaise'
      | 'quantity'
      | 'salesStartAt'
      | 'salesEndAt'
      | 'maxPerOrder'
    >
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
/** V1-proven audience classes (`promo-service.js`): public, private, per-use. */
export type PromoType = 'public' | 'private' | 'single_use' | 'multi_use';

/**
 * Promo code. Field names are the V1-proven contract from `thec1rcle`
 * `promo-service.js` (`maxRedemptions`, `redemptionCount`, `startsAt`,
 * `endsAt`, `tierIds`, `maxPerUser`, `type`, `name`) — checkout/orders slice
 * validates against these exact names. Money (`discountValue`) is paise in V2
 * (V1 used rupees; converted at the Firestore adapter boundary, B12).
 */
export interface PromoCode extends VersionedEntity {
  id: EntityId;
  eventId: EntityId | null;
  organizationId: EntityId;
  /** Normalized uppercase — unique per (organization, event). */
  code: string;
  /** Display name; defaults to the code when not provided (V1 behavior). */
  name: string;
  type: PromoType;
  discountType: PromoDiscountType;
  /** Percent (0–100) when `percent`; paise when `fixed`. */
  discountValue: number;
  /** Empty = applies to all tiers (V1 semantics). */
  tierIds: EntityId[];
  /** Total allowed redemptions; null = unlimited. */
  maxRedemptions: number | null;
  /** Per-user redemption cap; null = unlimited. */
  maxPerUser: number | null;
  /** Cumulative redemptions (incremented by the redemption consumer). */
  redemptionCount: number;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
}

export interface CreatePromoCodeInput {
  id: EntityId;
  eventId: EntityId | null;
  organizationId: EntityId;
  code: string;
  name?: string;
  type?: PromoType;
  discountType: PromoDiscountType;
  discountValue: number;
  tierIds?: EntityId[];
  maxRedemptions?: number | null;
  maxPerUser?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  now?: Date;
}

export function createPromoCode(input: CreatePromoCodeInput): PromoCode {
  if (input.discountType === 'percent' && (input.discountValue <= 0 || input.discountValue > 100)) {
    throw new InvalidOperationError('Percent discount must be > 0 and <= 100');
  }
  if (input.discountType === 'fixed' && input.discountValue < 0) {
    throw new InvalidOperationError('Fixed discount cannot be negative');
  }
  const code = input.code.toUpperCase().trim();
  const trimmedName = input.name?.trim();
  // Falls back to `code` for both "not provided" and "provided but blank"
  // (V1-proven behavior) — explicit comparison rather than `||`/`??` so an
  // all-whitespace name still falls through (`??` alone would keep `''`).
  const name = trimmedName === undefined || trimmedName === '' ? code : trimmedName;
  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    code,
    name,
    type: input.type ?? 'private',
    discountType: input.discountType,
    discountValue: input.discountValue,
    tierIds: input.tierIds ?? [],
    maxRedemptions: input.maxRedemptions ?? null,
    maxPerUser: input.maxPerUser ?? null,
    redemptionCount: 0,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    isActive: true,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/** Records one redemption (saturated at never above maxRedemptions). */
export function markPromoUsed(promo: PromoCode, now?: Date): PromoCode {
  if (promo.maxRedemptions !== null && promo.redemptionCount >= promo.maxRedemptions) {
    throw new InvalidOperationError('Promo code usage limit reached');
  }
  return bumpVersion({ ...promo, redemptionCount: promo.redemptionCount + 1 }, now ?? new Date());
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
  tierRates?: Record<string, { ratePercent: number; flatPaise: number }>;
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
  for (const rate of Object.values(input.terms.tierRates ?? {})) {
    if (rate.ratePercent < 0 || rate.ratePercent > 100) {
      throw new InvalidOperationError('Tier commission rate must be between 0 and 100');
    }
    if (rate.flatPaise < 0)
      throw new InvalidOperationError('Tier commission fee cannot be negative');
  }
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
