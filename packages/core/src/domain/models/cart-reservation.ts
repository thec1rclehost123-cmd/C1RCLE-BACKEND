import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { PricingBreakdown } from './pricing.js';

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
  }[];
  pricing: PricingBreakdown;
  appliedPromoCode: string | null;
  attribution: {
    referralLinkId: EntityId;
    promoterId: EntityId;
    code: string;
  } | null;
  status: CartReservationStatus;
  /** When this hold expires and inventory is returned. ISO-8601. */
  expiresAt: string;
  /** Set when converted to an order. */
  convertedOrderId: EntityId | null;
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
  }[];
  pricing: PricingBreakdown;
  appliedPromoCode: string | null;
  attribution: {
    referralLinkId: EntityId;
    promoterId: EntityId;
    code: string;
  } | null;
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
