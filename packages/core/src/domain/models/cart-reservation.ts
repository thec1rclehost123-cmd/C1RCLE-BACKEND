import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { TicketAdmissionMode } from './event-catalog.js';
import type { OrderAttribution, OrderContact } from './order.js';
import type { PricingBreakdown } from './pricing.js';
import type { TicketAddonSelection } from './ticket-addon.js';

/**
 * ─── Cart Reservation (Phase 4) ────────────────────────────────────────────────
 *
 * Short-lived inventory hold created when a guest initiates checkout.
 * Mirrors v1's cart hold (~10 min TTL) with idempotency key for safe retry.
 *
 * States:
 * - active: inventory reserved, guest can proceed to payment
 * - converted: hold turned into an order (payment succeeded)
 * - released: hold expired or cancelled, inventory returned
 */

export type CartReservationStatus = 'active' | 'converted' | 'released';

export interface TicketUpgradeSnapshot {
  sourceEntitlementId: EntityId;
  sourceEntitlementVersion: number;
  sourceOrderId: EntityId;
  sourceTierId: EntityId;
  targetTierId: EntityId;
  priorAdmissionPaidPaise: number;
  replacementAdmissionPaise: number;
  incrementalAdmissionPaise: number;
}

export interface CartReservation extends VersionedEntity {
  /** Deterministic id from idempotency key: `HOLD-{idempotencyKey}`. */
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  userId: EntityId | null;
  lines: {
    tierId: EntityId;
    tierName: string;
    quantity: number;
    unitPricePaise: number;
    admissionUnitPricePaise?: number;
    coverUnitPricePaise?: number;
    coverPolicy?: { proposalId: EntityId; policyVersion: string; termsDigest: string };
    /** Server-priced non-cover products attached to each admission entitlement. */
    ticketAddons?: TicketAddonSelection[];
    /** Access grant accepted during quote/hold for private events or tiers. */
    accessGrantId?: EntityId;
    /** Snapshot of group shape at hold time; absent on legacy holds. */
    guestCount?: number;
    admissionMode?: TicketAdmissionMode;
    /** Policy and acknowledgement snapshot; never contains attendee demographics. */
    eligibility?: {
      audienceType: string;
      minAge: number | null;
      maxAge: number | null;
      attested: true;
      attestedAt: string;
    };
  }[];
  pricing: PricingBreakdown;
  appliedPromoCode: string | null;
  attribution: OrderAttribution | null;
  status: CartReservationStatus;
  /** When this hold expires and inventory is returned. ISO-8601. */
  expiresAt: string;
  /** Set when converted to an order. */
  convertedOrderId: EntityId | null;
  /**
   * The provider (Razorpay) order bound to this hold when the payment attempt
   * was created. Fulfilment only accepts a payment made against exactly this
   * order, so a genuine payment for one hold can never be replayed to
   * fulfil another. First writer wins (see `bindProviderOrder`).
   */
  providerOrderId?: string | null;
  /** Who the tickets are for, captured at hold time; becomes the order contact. */
  attendee?: OrderContact | null;
  /** Present only for the bounded one-ticket paid upgrade flow. */
  upgrade?: TicketUpgradeSnapshot;
  /**
   * Position in the event's strict order of hold creation, assigned by the
   * repository inside a transaction (so no two holds for an event share one).
   * Capacity is judged against the holds ordered at or before this one, which
   * is what stops two simultaneous buyers both keeping the last seat. Absent on
   * holds made before this existed; those count as ahead of everything.
   */
  sequence?: number | null;
  /** Idempotency key used to create this hold. */
  idempotencyKey: string;
}

export interface CreateCartReservationInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  userId: EntityId | null;
  lines: {
    tierId: EntityId;
    tierName: string;
    quantity: number;
    unitPricePaise: number;
    guestCount?: number;
    admissionMode?: TicketAdmissionMode;
  }[];
  pricing: PricingBreakdown;
  appliedPromoCode: string | null;
  attribution: OrderAttribution | null;
  /** How long the hold lasts. v1 used ~10 minutes. */
  reservationTtlMs?: number;
  idempotencyKey: string;
  now?: Date;
}

export function createCartReservation(input: CreateCartReservationInput): CartReservation {
  const now = input.now ?? new Date();
  const ttl = input.reservationTtlMs ?? 10 * 60 * 1000;

  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    lines: input.lines.map((line) => ({ ...line })),
    pricing: input.pricing,
    appliedPromoCode: input.appliedPromoCode,
    attribution: input.attribution ?? null,
    status: 'active',
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    convertedOrderId: null,
    providerOrderId: null,
    idempotencyKey: input.idempotencyKey,
    ...newVersionedEntity(now),
  };
}

export function convertCartReservation(
  reservation: CartReservation,
  orderId: EntityId,
  now?: Date,
): CartReservation {
  if (reservation.status !== 'active') {
    throw new InvalidOperationError(`Cannot convert hold in status ${reservation.status}`);
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(reservation, at),
    status: 'converted',
    convertedOrderId: orderId,
  };
}

export function releaseCartReservation(reservation: CartReservation, now?: Date): CartReservation {
  if (reservation.status === 'released') return reservation;
  return {
    ...bumpVersion(reservation, now ?? new Date()),
    status: 'released',
  };
}

export function isCartReservationExpired(reservation: CartReservation, now: Date): boolean {
  return now.getTime() > Date.parse(reservation.expiresAt);
}
