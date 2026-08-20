import { InvalidOperationError } from '../errors.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Door Sale (Phase 5) ────────────────────────────────────────────────────────
 *
 * Walk-in and dine-in sales at the door. Price is always recalculated
 * server-side from the event's ticket catalog. Synthetic order doc, idempotent
 * via client-supplied idempotency key.
 *
 * Categories:
 * - `walkin`: walk-up entry sale
 * - `dinein`: dine-in reservation/sale
 */

export type DoorSaleCategory = 'walkin' | 'dinein';

export type DoorSaleStatus = 'active' | 'voided' | 'refunded';

export type DoorSalePaymentMode = 'cash' | 'card' | 'upi' | 'other';

export interface DoorSale extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  /** Category: walkin or dinein */
  category: DoorSaleCategory;
  /** Guest name */
  guestName: string;
  /** Guest phone (optional) */
  guestPhone: string | null;
  /** Guest age (optional) */
  guestAge: number | null;
  /** Gender (optional) */
  gender: string | null;
  /** Contact info (optional) */
  contact: string | null;
  /** Total guests in party */
  totalGuests: number;
  /** Category-specific fields */
  /** Table number for dine-in */
  tableNumber: string | null;
  /** Gate identifier */
  gate: string | null;
  /** Payment mode */
  paymentMode: DoorSalePaymentMode;
  /** Amount charged (paise) */
  amountPaise: number;
  /** Payment status */
  paymentStatus: 'collected' | 'pending' | 'failed';
  /** Payment reference/transaction ID */
  paymentRef: string | null;
  /** Staff who created */
  createdBy: EntityId;
  createdByName: string | null;
  /** Status */
  status: DoorSaleStatus;
  /** Voided/refunded timestamp */
  voidedAt: string | null;
  /** Voided by */
  voidedBy: EntityId | null;
  /** Voiding reason */
  voidReason: string | null;
  /** Refunded amount (if refunded) */
  refundedAmountPaise: number | null;
  /** Refund timestamp */
  refundedAt: string | null;
  /** Refunded by */
  refundedBy: EntityId | null,
}

export interface DoorSaleCreateInput {
  eventId: EntityId;
  organizationId: EntityId;
  venueId: EntityId | null;
  category: DoorSaleCategory;
  guestName: string;
  guestPhone: string | null;
  guestAge: number | null;
  gender: string | null;
  contact: string | null;
  totalGuests: number;
  tableNumber: string | null;
  gate: string | null;
  paymentMode: DoorSalePaymentMode;
  amountPaise: number;
  createdBy: EntityId;
  createdByName: string | null;
  idempotencyKey: string | null;
  now?: Date;
}

export function createDoorSale(input: DoorSaleCreateInput): any {
  const now = input.now ?? new Date();

  return {
    id: `DS-${input.venueId ?? 'unknown'}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    eventId: input.eventId,
    organizationId: input.organizationId,
    venueId: input.venueId,
    category: input.category,
    guestName: input.guestName,
    guestPhone: input.guestPhone,
    guestAge: input.guestAge,
    gender: input.gender,
    contact: input.contact,
    totalGuests: input.totalGuests,
    tableNumber: input.tableNumber,
    gate: input.gate,
    paymentMode: input.paymentMode,
    amountPaise: input.amountPaise,
    paymentStatus: 'collected',
    paymentRef: null,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
    status: 'active',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    refundedAmountPaise: null,
    refundedAt: null,
    refundedBy: null,
    idempotencyKey: input.idempotencyKey,
    ...newVersionedEntity(now),
  };
}