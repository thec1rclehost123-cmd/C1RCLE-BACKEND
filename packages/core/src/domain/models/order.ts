import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { PricingBreakdown } from './pricing.js';

/**
 * ─── Order aggregate (Phase 4) ───────────────────────────────────────────────
 *
 * Ported from v1's checkout flow:
 *   calculate → reserve → intent → initiate → confirm (two racing paths) →
 *   cancel/fail/expire.
 *
 * The design constraint that shapes everything: **two confirmation paths race
 * for every order.** Razorpay's webhook and the guest's browser redirect both
 * report the same payment, in either order, and both must be safe to apply.
 * v1 solved this by making confirmation idempotent; so does this, but with the
 * rule stated in the type system rather than in a comment: `markPaid` on an
 * already-paid order returns it **unchanged** rather than transitioning again.
 *
 * The other rule worth naming: **the pricing breakdown is frozen onto the
 * order at intent time.** A tier's price, a promo's value or a fee rate may all
 * change between quote and capture; none of them may change what the guest was
 * charged. Nothing downstream ever recalculates an order's total — it reads it.
 */

export type OrderStatus =
  /** Cart held, inventory reserved, nothing charged yet. */
  | 'pending'
  /** Payment intent created with the provider; awaiting the guest. */
  | 'awaiting_payment'
  /** Money captured. Terminal for the happy path; entitlements follow. */
  | 'paid'
  /** Guest abandoned, or the hold lapsed. Inventory released. */
  | 'expired'
  /** Guest cancelled before paying. */
  | 'cancelled'
  /** Provider reported a failure. */
  | 'failed'
  /** Paid, then refunded (Phase 6 owns the money movement). */
  | 'refunded';

const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['awaiting_payment', 'cancelled', 'expired'],
  // A payment can still lapse or fail after the intent exists.
  awaiting_payment: ['paid', 'failed', 'cancelled', 'expired'],
  paid: ['refunded'],
  expired: [],
  cancelled: [],
  // A retry after failure is a NEW order: reusing this one would make the
  // provider's payment id ambiguous across two attempts.
  failed: [],
  refunded: [],
};

/** A line as sold. Immutable once the order leaves `pending`. */
export interface OrderLine {
  tierId: EntityId;
  tierName: string;
  quantity: number;
  unitPricePaise: number;
  subtotalPaise: number;
}

/**
 * Who the tickets are for. A guest may check out without an account (v1
 * allowed this), so contact details are carried on the order itself rather
 * than looked up from a user record that may not exist.
 */
export interface OrderContact {
  name: string;
  email: string;
  phone: string;
}

/** Promoter attribution, captured at purchase and never recalculated. */
export interface OrderAttribution {
  referralLinkId: EntityId;
  promoterId: EntityId;
  code: string;
}

export interface Order extends VersionedEntity {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  /** Null for a guest checkout with no account. */
  userId: EntityId | null;
  contact: OrderContact;
  status: OrderStatus;
  lines: OrderLine[];
  currency: string;

  /* Money — all integer paise, all frozen at intent time. */
  subtotalPaise: number;
  discountPaise: number;
  discountedSubtotalPaise: number;
  platformFeePaise: number;
  paymentFeePaise: number;
  gstPaise: number;
  grandTotalPaise: number;
  appliedPromoCode: string | null;

  attribution: OrderAttribution | null;

  /** Provider's order id (Razorpay `order_...`), set at intent. */
  paymentIntentId: string | null;
  /** Provider's payment id, set on capture. The idempotency anchor. */
  paymentId: string | null;
  paidAt: string | null;

  /** When the inventory hold lapses. ISO-8601. */
  reservationExpiresAt: string;
  /** Why the order ended, when it ended unhappily. */
  failureReason: string | null;
}

export interface CreateOrderInput {
  id: EntityId;
  eventId: EntityId;
  organizationId: EntityId;
  userId?: EntityId | null;
  contact: OrderContact;
  pricing: PricingBreakdown;
  attribution?: OrderAttribution | null;
  /** How long the cart hold lasts. v1 used ~10 minutes. */
  reservationTtlMs?: number;
  now?: Date;
}

/** v1's cart-hold TTL. Long enough to pay, short enough not to starve the event. */
export const DEFAULT_RESERVATION_TTL_MS = 10 * 60 * 1000;

export function createOrder(input: CreateOrderInput): Order {
  const now = input.now ?? new Date();
  const ttl = input.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  const pricing = input.pricing;

  return {
    id: input.id,
    eventId: input.eventId,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    contact: input.contact,
    status: 'pending',
    lines: pricing.lines.map((line) => ({ ...line })),
    currency: pricing.currency,
    subtotalPaise: pricing.subtotalPaise,
    discountPaise: pricing.discountPaise,
    discountedSubtotalPaise: pricing.discountedSubtotalPaise,
    platformFeePaise: pricing.platformFeePaise,
    paymentFeePaise: pricing.paymentFeePaise,
    gstPaise: pricing.gstPaise,
    grandTotalPaise: pricing.grandTotalPaise,
    appliedPromoCode: pricing.appliedPromoCode,
    attribution: input.attribution ?? null,
    paymentIntentId: null,
    paymentId: null,
    paidAt: null,
    reservationExpiresAt: new Date(now.getTime() + ttl).toISOString(),
    failureReason: null,
    ...newVersionedEntity(now),
  };
}

/** Total ticket units across all lines — what inventory and issuance count. */
export function totalUnits(order: Order): number {
  return order.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function isReservationExpired(order: Order, now: Date): boolean {
  return now.getTime() > Date.parse(order.reservationExpiresAt);
}

/**
 * Attaches the provider's intent. Refuses when the hold has already lapsed —
 * sending a guest to a payment page for inventory that has been released is
 * how you end up charging for a ticket you cannot issue.
 */
export function attachPaymentIntent(order: Order, paymentIntentId: string, now?: Date): Order {
  const at = now ?? new Date();
  if (isReservationExpired(order, at)) {
    throw new InvalidOperationError('This reservation has expired — start a new order');
  }
  if (order.paymentIntentId && order.paymentIntentId !== paymentIntentId) {
    // Two intents for one order means two ways to pay it.
    throw new InvalidOperationError('This order already has a different payment intent');
  }
  if (order.status === 'awaiting_payment' && order.paymentIntentId === paymentIntentId) {
    return order; // Idempotent retry of the same intent.
  }
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'awaiting_payment', ORDER_TRANSITIONS),
    paymentIntentId,
  };
}

/**
 * Records capture. **This is the function both confirmation paths call**, and
 * it is deliberately total:
 *
 *  - Already paid with this same `paymentId` → returns unchanged. The webhook
 *    and the redirect both land here and the second is a no-op, whichever
 *    order they arrive in.
 *  - Already paid with a *different* `paymentId` → throws. That is not a race,
 *    it is two payments against one order, and it needs a human.
 *
 * Returning the order unchanged (rather than bumping the version) matters:
 * the second path must not fail an optimistic-lock check just for being second.
 */
export function markPaid(order: Order, paymentId: string, now?: Date): Order {
  if (order.status === 'paid') {
    if (order.paymentId === paymentId) return order;
    throw new InvalidOperationError(
      `Order ${order.id} is already paid under a different payment id`,
    );
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'paid', ORDER_TRANSITIONS),
    paymentId,
    paidAt: at.toISOString(),
  };
}

export function markFailed(order: Order, reason: string, now?: Date): Order {
  if (order.status === 'failed') return order;
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'failed', ORDER_TRANSITIONS),
    failureReason: reason,
  };
}

export function cancelOrder(order: Order, reason?: string, now?: Date): Order {
  if (order.status === 'cancelled') return order;
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'cancelled', ORDER_TRANSITIONS),
    failureReason: reason ?? null,
  };
}

/**
 * Lapses an unpaid hold. Separate from `cancelOrder` because the guest did not
 * choose it, and the two read differently in a support conversation.
 */
export function expireOrder(order: Order, now?: Date): Order {
  if (order.status === 'expired') return order;
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'expired', ORDER_TRANSITIONS),
    failureReason: 'Reservation expired before payment',
  };
}

export function refundOrder(order: Order, reason: string, now?: Date): Order {
  if (order.status === 'refunded') return order;
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'refunded', ORDER_TRANSITIONS),
    failureReason: reason,
  };
}

/** Whether this order still holds inventory. */
export function holdsInventory(order: Order, now: Date): boolean {
  if (order.status === 'paid') return true;
  if (order.status === 'pending' || order.status === 'awaiting_payment') {
    return !isReservationExpired(order, now);
  }
  return false;
}
