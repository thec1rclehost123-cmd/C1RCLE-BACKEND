import { InvalidOperationError } from '../errors.js';
import { newVersionedEntity, bumpVersion } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { DiscountFundingOwner } from './financial-journal.js';

/**
 * ─── Event catalog ─────────────────────────────────────────────────────────
 * Pricing/promotion/capacity primitives that belong to an event's sales
 * surface. PromoterAssignment carries *versioned* commission terms so past
 * payouts keep their agreed rates if commissions change later.
 */

// ─── Ticket tiers ────────────────────────────────────────────────────────────

export type TicketTierStatus = 'active' | 'paused' | 'sold_out';
export type TicketAdmissionMode = 'bundle' | 'per_person';
export type TicketTierAccessMode = 'public' | 'code' | 'invited';
export type TicketAccessType = 'ENTRY' | 'VIP' | 'VVIP' | 'TABLE' | 'PACKAGE' | 'RSVP';
export type TicketAudienceType =
  'GENERAL' | 'MALE' | 'FEMALE' | 'COUPLE' | 'GROUP' | 'STUDENT' | 'MEMBER';

export interface TicketPricingPhase {
  id: string;
  name: string;
  priceInPaise: number;
  /** Separate per-admission event cover component; absent on legacy tiers. */
  coverAmountPaise?: number;
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
  /** Optional separate cover charged once per issued admission entitlement. */
  coverAmountPaise?: number;
  /** Live sellable quantity; runs through inventory-service at sell time. */
  quantity: number;
  status: TicketTierStatus;
  salesStartAt: string | null;
  salesEndAt: string | null;
  /** Maximum tickets that can be purchased per order. */
  maxPerOrder: number | null;
  /** Missing on legacy rows is public. Restricted modes require a server grant before sale. */
  accessMode?: TicketTierAccessMode;
  accessType?: TicketAccessType;
  audienceType?: TicketAudienceType;
  guestCount?: number;
  /** `bundle` preserves one legacy multi-admit credential; `per_person` issues each attendee separately. */
  admissionMode?: TicketAdmissionMode;
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
  coverAmountPaise?: number;
  quantity: number;
  salesStartAt?: string | null;
  salesEndAt?: string | null;
  maxPerOrder?: number | null;
  accessMode?: TicketTierAccessMode;
  accessType?: TicketAccessType;
  audienceType?: TicketAudienceType;
  guestCount?: number;
  admissionMode?: TicketAdmissionMode;
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
  if (
    input.coverAmountPaise !== undefined &&
    (!Number.isSafeInteger(input.coverAmountPaise) || input.coverAmountPaise < 0)
  ) {
    throw new InvalidOperationError('Ticket cover must be a nonnegative whole paise amount');
  }
  if (accessType === 'RSVP' && (input.coverAmountPaise ?? 0) > 0) {
    throw new InvalidOperationError('Free RSVPs cannot include paid event cover');
  }
  const guestCount = input.guestCount ?? 1;
  if (!Number.isInteger(guestCount) || guestCount < 1)
    throw new InvalidOperationError('Guest count must be at least 1');
  const admissionMode = input.admissionMode ?? 'bundle';
  if (admissionMode === 'per_person' && guestCount < 2)
    throw new InvalidOperationError('Per-person group admission requires at least two guests');
  if (accessType === 'RSVP' && guestCount > 1)
    throw new InvalidOperationError('Free RSVPs are limited to one person per ticket');
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
    ...(input.coverAmountPaise === undefined ? {} : { coverAmountPaise: input.coverAmountPaise }),
    quantity: input.quantity,
    status: 'active',
    salesStartAt: input.salesStartAt ?? null,
    salesEndAt: input.salesEndAt ?? null,
    maxPerOrder: input.maxPerOrder ?? null,
    accessMode: input.accessMode ?? 'public',
    accessType,
    audienceType: input.audienceType ?? 'GENERAL',
    guestCount,
    admissionMode,
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
      | 'coverAmountPaise'
      | 'accessType'
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
  if (
    changes.coverAmountPaise !== undefined &&
    (!Number.isSafeInteger(changes.coverAmountPaise) || changes.coverAmountPaise < 0)
  ) {
    throw new InvalidOperationError('Ticket cover amount must be non-negative whole paise');
  }
  if (
    (changes.accessType ?? tier.accessType) === 'RSVP' &&
    (changes.coverAmountPaise ?? tier.coverAmountPaise ?? 0) > 0
  ) {
    throw new InvalidOperationError('RSVP tiers cannot include paid event cover');
  }
  return bumpVersion({ ...tier, ...changes }, now ?? new Date());
}

/**
 * Effective unit price for reads against tiers that predate `priceInPaise`.
 * Legacy tier docs (written by the pre-V2 catalog) carry `doorPriceInPaise`
 * or no price field at all. RSVP and public listings must not crash on those
 * docs — and must never invent a price: the legacy door price wins when it
 * is a valid non-negative integer, otherwise the tier prices as zero, and
 * callers still gate free-vs-paid on `event.isFree`, never on this alone.
 */
export function effectiveTierPricePaise(tier: TicketTier): number {
  if (typeof tier.priceInPaise === 'number') return tier.priceInPaise;
  const legacy = (tier as unknown as { doorPriceInPaise?: unknown }).doorPriceInPaise;
  if (typeof legacy === 'number' && Number.isInteger(legacy) && legacy >= 0) return legacy;
  return 0;
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
  /** Commercial owner that absorbs this discount. */
  discountFundingOwner: DiscountFundingOwner;
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
  discountFundingOwner: DiscountFundingOwner;
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
    discountFundingOwner: input.discountFundingOwner,
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

/**
 * Whether a promo may be applied right now: switched on, inside its date window.
 * Counting redemptions needs the redemption store, so that part lives in the
 * checkout service; this is the part that needs only the promo and the clock.
 */
export function assertPromoUsable(promo: PromoCode, now: Date): void {
  if (!promo.isActive) {
    throw new InvalidOperationError(`Promo code ${promo.code} is not active`);
  }
  if (promo.startsAt && Date.parse(promo.startsAt) > now.getTime()) {
    throw new InvalidOperationError(`Promo code ${promo.code} is not valid yet`);
  }
  if (promo.endsAt && Date.parse(promo.endsAt) <= now.getTime()) {
    throw new InvalidOperationError(`Promo code ${promo.code} has expired`);
  }
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

/** Technical identifiers for the observed M3 calculations preserved by M4. */
export const PROMOTER_COMMISSION_POLICY_VERSION = 'm3-assignment-terms-v1';
export const COMMERCIAL_ALLOCATION_POLICY_VERSION = 'm3-observed-v1';

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
  /** When the assignment was suspended by an admin, if ever. */
  suspendedAt: string | null;
  suspendedFromStatus: 'invited' | 'accepted' | 'active' | null;
  /** Invite and campaign evidence. Null values identify legacy assignments. */
  invitedAt: string | null;
  invitedBy: EntityId | null;
  respondedAt: string | null;
  respondedBy: EntityId | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  revokedAt: string | null;
  revokedBy: EntityId | null;
  revocationReason: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  eligibleTierIds: EntityId[] | null;
}

/**
 * 'active' and 'ended' remain readable for M3 records. New assignments use
 * explicit invitation states and are never active until accepted.
 */
export type PromoterAssignmentStatus =
  'invited' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'suspended' | 'active' | 'ended';

/** Read projection for time-bounded campaign state; storage remains unchanged. */
export function promoterAssignmentStatusAt(
  assignment: PromoterAssignment,
  now = new Date(),
): PromoterAssignmentStatus {
  if (
    (assignment.status === 'invited' ||
      assignment.status === 'accepted' ||
      assignment.status === 'active') &&
    assignment.expiresAt &&
    Date.parse(assignment.expiresAt) <= now.getTime()
  ) {
    return 'expired';
  }
  return assignment.status;
}

/** Persists the terminal expiration state once its authored deadline has passed. */
export function expirePromoterAssignment(
  assignment: PromoterAssignment,
  now = new Date(),
): PromoterAssignment {
  if (
    promoterAssignmentStatusAt(assignment, now) !== 'expired' ||
    assignment.status === 'expired'
  ) {
    return assignment;
  }
  return { ...bumpVersion(assignment, now), status: 'expired' };
}

export interface CreatePromoterAssignmentInput {
  id: EntityId;
  eventId: EntityId;
  promoterId: EntityId;
  terms: CommissionTerms;
  status?: 'invited' | 'accepted' | 'active';
  invitedBy?: EntityId;
  startsAt?: string | null;
  expiresAt?: string | null;
  eligibleTierIds?: EntityId[];
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
  const now = input.now ?? new Date();
  if (input.startsAt && Number.isNaN(Date.parse(input.startsAt))) {
    throw new InvalidOperationError('Campaign start must be a valid date');
  }
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    throw new InvalidOperationError('Campaign expiration must be a valid date');
  }
  if (
    input.startsAt &&
    input.expiresAt &&
    Date.parse(input.expiresAt) <= Date.parse(input.startsAt)
  ) {
    throw new InvalidOperationError('Campaign expiration must be after its start');
  }
  const status = input.status ?? 'active';
  return {
    id: input.id,
    eventId: input.eventId,
    promoterId: input.promoterId,
    status,
    terms: input.terms,
    endedAt: null,
    suspendedAt: null,
    suspendedFromStatus: null,
    invitedAt: status === 'invited' ? now.toISOString() : null,
    invitedBy: input.invitedBy ?? null,
    respondedAt: null,
    respondedBy: null,
    acceptedAt: null,
    rejectedAt: null,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    startsAt: input.startsAt ?? null,
    expiresAt: input.expiresAt ?? null,
    eligibleTierIds:
      input.eligibleTierIds === undefined ? null : [...new Set(input.eligibleTierIds)],
    ...newVersionedEntity(now),
  };
}

export function acceptPromoterAssignment(
  assignment: PromoterAssignment,
  actorId: EntityId,
  now?: Date,
): PromoterAssignment {
  const at = now ?? new Date();
  if (assignment.status !== 'invited') {
    throw new InvalidOperationError('Only a pending Promoter invitation can be accepted');
  }
  if (assignment.expiresAt && Date.parse(assignment.expiresAt) <= at.getTime()) {
    throw new InvalidOperationError('This Promoter invitation has expired');
  }
  const stamped = bumpVersion(assignment, at);
  return {
    ...stamped,
    status: 'accepted',
    acceptedAt: at.toISOString(),
    respondedAt: at.toISOString(),
    respondedBy: actorId,
  };
}

export function rejectPromoterAssignment(
  assignment: PromoterAssignment,
  actorId: EntityId,
  now?: Date,
): PromoterAssignment {
  const at = now ?? new Date();
  if (assignment.status !== 'invited') {
    throw new InvalidOperationError('Only a pending Promoter invitation can be rejected');
  }
  const stamped = bumpVersion(assignment, at);
  return {
    ...stamped,
    status: 'rejected',
    rejectedAt: at.toISOString(),
    respondedAt: at.toISOString(),
    respondedBy: actorId,
  };
}

export function revokePromoterAssignment(
  assignment: PromoterAssignment,
  actorId: EntityId,
  reason: string,
  now?: Date,
): PromoterAssignment {
  if (
    assignment.status !== 'invited' &&
    assignment.status !== 'accepted' &&
    assignment.status !== 'active'
  ) {
    throw new InvalidOperationError('Only a pending or accepted assignment can be revoked');
  }
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3 || normalizedReason.length > 500) {
    throw new InvalidOperationError('A revocation reason between 3 and 500 characters is required');
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(assignment, at),
    status: 'revoked',
    endedAt: at.toISOString(),
    revokedAt: at.toISOString(),
    revokedBy: actorId,
    revocationReason: normalizedReason,
  };
}

export function isPromoterAssignmentAttributable(
  assignment: PromoterAssignment,
  now = new Date(),
): boolean {
  if (assignment.status !== 'accepted' && assignment.status !== 'active') return false;
  if (assignment.startsAt && Date.parse(assignment.startsAt) > now.getTime()) return false;
  if (assignment.expiresAt && Date.parse(assignment.expiresAt) <= now.getTime()) return false;
  return true;
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

/**
 * Suspends an assignment — the promoter can no longer earn commission on this
 * event while the suspension is active. The partner endpoint should stop
 * issuing referral codes until the admin reinstates.
 */
export function suspendPromoterAssignment(
  assignment: PromoterAssignment,
  now?: Date,
): PromoterAssignment {
  if (assignment.status === 'ended') return assignment;
  if (assignment.status === 'suspended') return assignment;
  if (
    assignment.status !== 'invited' &&
    assignment.status !== 'accepted' &&
    assignment.status !== 'active'
  ) {
    throw new InvalidOperationError('Only a pending or accepted assignment can be suspended');
  }
  const stamped = bumpVersion(assignment, now ?? new Date());
  return {
    ...stamped,
    status: 'suspended',
    suspendedAt: (now ?? new Date()).toISOString(),
    suspendedFromStatus: assignment.status,
  };
}

/**
 * Reinstates a suspended assignment. The frozen commission terms are preserved
 * and the promoter may resume earning.
 */
export function reinstatePromoterAssignment(
  assignment: PromoterAssignment,
  now?: Date,
): PromoterAssignment {
  if (assignment.status !== 'suspended') return assignment;
  const stamped = bumpVersion(assignment, now ?? new Date());
  return {
    ...stamped,
    status: assignment.suspendedFromStatus ?? 'active',
    suspendedAt: null,
    suspendedFromStatus: null,
  };
}
