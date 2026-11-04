import { createHash } from 'node:crypto';

import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';
import type { CommissionTerms } from './event-catalog.js';
import type { DiscountFundingOwner } from './financial-journal.js';
import type { PricingBreakdown } from './pricing.js';
import type { TicketAddonSelection } from './ticket-addon.js';

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
  /**
   * A refund is in flight against this order — locked so a second refund
   * request and a door scan can't race the first one's settlement. Always
   * entered from `paid` and always left back to `paid` (still has a
   * refundable remainder) or `refunded` (fully refunded). Never a terminal
   * state, never entered/left any other way — restoring to `paid` on
   * failure is therefore never a hardcoded guess, it's the FSM's only valid
   * predecessor. (v1's admin console hardcoded the restore value on refund
   * rejection and reopened an already-scanned ticket for re-entry — see
   * `refund-request.ts`'s header comment for the full story.)
   */
  | 'refund_requested'
  /** Fully refunded (`refundedPaise === grandTotalPaise`). Terminal. */
  | 'refunded';

const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['awaiting_payment', 'cancelled', 'expired'],
  // A payment can still lapse or fail after the intent exists.
  awaiting_payment: ['paid', 'failed', 'cancelled', 'expired'],
  paid: ['refund_requested'],
  expired: [],
  cancelled: [],
  // A retry after failure is a NEW order: reusing this one would make the
  // provider's payment id ambiguous across two attempts.
  failed: [],
  refund_requested: ['paid', 'refunded'],
  refunded: [],
};

/** A line as sold. Immutable once the order leaves `pending`. */
export interface OrderLine {
  tierId: EntityId;
  tierName: string;
  quantity: number;
  unitPricePaise: number;
  /** Component snapshot; absent on legacy orders where the tier price was admission only. */
  admissionUnitPricePaise?: number;
  coverUnitPricePaise?: number;
  coverPolicy?: { proposalId: EntityId; policyVersion: string; termsDigest: string };
  /** Non-cover products purchased per resulting admission entitlement. */
  ticketAddons?: TicketAddonSelection[];
  subtotalPaise: number;
  /** Immutable group issuance policy captured by the hold; absent on legacy orders. */
  guestCount?: number;
  admissionMode?: 'bundle' | 'per_person';
  /** Immutable eligibility policy and acknowledgement; absent on legacy orders. */
  eligibility?: {
    audienceType: string;
    minAge: number | null;
    maxAge: number | null;
    attested: true;
    attestedAt: string;
  };
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
  assignmentId: EntityId;
  assignmentVersion: number;
  termsSnapshot: CommissionTerms;
  eligibleTierIds: EntityId[] | null;
  commissionPolicyVersion: string;
  commercialPolicyVersion: string;
  attributedAt: string;
  attributionSignature: string;
  promoterCommissionPaise: number;
}

/**
 * Immutable evidence that the event was cancelled after this order was
 * created. The order's payment/refund status remains authoritative for money;
 * this marker is the cross-surface authority for admission and guest wording.
 */
export interface OrderEventCancellation {
  eventVersion: number;
  eventTitle: string;
  reason: string;
  cancelledAt: string;
}

export interface Order extends VersionedEntity {
  id: EntityId;
  /** Stable, support-safe reference shown to guests instead of the internal id. */
  bookingReference?: string;
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
  discountFundingOwner: DiscountFundingOwner | null;
  discountedSubtotalPaise: number;
  platformFeePaise: number;
  paymentFeePaise: number;
  gstPaise: number;
  grandTotalPaise: number;
  /** Admission and cover portions; absent on legacy orders. */
  admissionSubtotalPaise?: number;
  coverSubtotalPaise?: number;
  addOnSubtotalPaise?: number;
  discountedAdmissionSubtotalPaise?: number;
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

  /** Present once the owning event cancellation has affected this order. */
  eventCancellation?: OrderEventCancellation | null;

  /**
   * Cumulative amount refunded so far (Phase 6 admin refunds). A partial
   * refund keeps the order at `paid`; the order only reaches the terminal
   * `refunded` status once this equals `grandTotalPaise`.
   */
  refundedPaise: number;
  /** Refund request ids already reflected in `refundedPaise` (retry fence). */
  appliedRefundRequestIds: EntityId[];
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

/**
 * A stable 80-bit reference derived from the full immutable order id. This is
 * not a visible truncation of the id: the SHA-256 digest makes the value safe
 * to communicate while retaining enough collision resistance for lookup.
 */
export function bookingReferenceForOrderId(orderId: EntityId): string {
  const digest = createHash('sha256')
    .update(`c1rcle-booking:${orderId}`)
    .digest('hex')
    .slice(0, 20);
  return `C1-${digest.slice(0, 5)}-${digest.slice(5, 10)}-${digest.slice(10, 15)}-${digest.slice(15, 20)}`.toUpperCase();
}

export function createOrder(input: CreateOrderInput): Order {
  const now = input.now ?? new Date();
  const ttl = input.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  const pricing = input.pricing;

  return {
    id: input.id,
    bookingReference: bookingReferenceForOrderId(input.id),
    eventId: input.eventId,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    contact: input.contact,
    status: 'pending',
    lines: pricing.lines.map((line) => ({ ...line })),
    currency: pricing.currency,
    subtotalPaise: pricing.subtotalPaise,
    discountPaise: pricing.discountPaise,
    discountFundingOwner: pricing.discountFundingOwner ?? null,
    discountedSubtotalPaise: pricing.discountedSubtotalPaise,
    platformFeePaise: pricing.platformFeePaise,
    paymentFeePaise: pricing.paymentFeePaise,
    gstPaise: pricing.gstPaise,
    grandTotalPaise: pricing.grandTotalPaise,
    admissionSubtotalPaise: pricing.admissionSubtotalPaise ?? pricing.subtotalPaise,
    coverSubtotalPaise: pricing.coverSubtotalPaise ?? 0,
    addOnSubtotalPaise: pricing.addOnSubtotalPaise ?? 0,
    discountedAdmissionSubtotalPaise:
      pricing.discountedAdmissionSubtotalPaise ?? pricing.discountedSubtotalPaise,
    appliedPromoCode: pricing.appliedPromoCode,
    attribution: input.attribution ?? null,
    paymentIntentId: null,
    paymentId: null,
    paidAt: null,
    reservationExpiresAt: new Date(now.getTime() + ttl).toISOString(),
    failureReason: null,
    refundedPaise: 0,
    appliedRefundRequestIds: [],
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

/** Settles an explicitly zero-value order without inventing provider facts. */
export function markZeroValueOrderIssued(order: Order, now?: Date): Order {
  if (order.status === 'paid' && order.grandTotalPaise === 0 && order.paymentId === null) {
    return order;
  }
  if (
    order.status !== 'pending' ||
    order.grandTotalPaise !== 0 ||
    order.subtotalPaise !== 0 ||
    order.platformFeePaise !== 0 ||
    order.paymentFeePaise !== 0 ||
    order.gstPaise !== 0
  ) {
    throw new InvalidOperationError(
      'Only a zero-value order can be issued without provider payment',
    );
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: 'paid',
    paymentId: null,
    paymentIntentId: null,
    paidAt: at.toISOString(),
  };
}

/** Releases inventory for a zero-value order without creating provider refund facts. */
export function markZeroValueOrderVoided(order: Order, now?: Date): Order {
  if (order.status === 'refunded' && order.grandTotalPaise === 0 && order.paymentId === null) {
    return order;
  }
  if (
    order.status !== 'paid' ||
    order.grandTotalPaise !== 0 ||
    order.paymentId !== null ||
    order.paymentIntentId !== null
  ) {
    throw new InvalidOperationError(
      'Only a zero-value order can be voided without provider refund',
    );
  }
  return {
    ...bumpVersion(order, now ?? new Date()),
    status: 'refunded',
    refundedPaise: 0,
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
 * Applies event-cancellation state exactly once while preserving financial
 * history. Paid orders may be locked for the deterministic admin-approved
 * refund workflow; free/refunded orders retain their financial status.
 */
export function markOrderEventCancelled(
  order: Order,
  input: {
    eventVersion: number;
    eventTitle: string;
    reason: string;
    lockForRefund: boolean;
  },
  now?: Date,
): Order {
  const at = now ?? new Date();
  const alreadyMarked =
    order.eventCancellation?.eventVersion === input.eventVersion &&
    order.eventCancellation.eventTitle === input.eventTitle &&
    order.eventCancellation.reason === input.reason;
  let status = order.status;
  if (order.status === 'pending' || order.status === 'awaiting_payment') {
    status = transitionStatus(order.status, 'cancelled', ORDER_TRANSITIONS);
  } else if (order.status === 'paid' && input.lockForRefund) {
    status = transitionStatus(order.status, 'refund_requested', ORDER_TRANSITIONS);
  }
  if (alreadyMarked && status === order.status) return order;
  return {
    ...bumpVersion(order, at),
    status,
    eventCancellation: {
      eventVersion: input.eventVersion,
      eventTitle: input.eventTitle,
      reason: input.reason.trim(),
      cancelledAt: at.toISOString(),
    },
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

/** How much of this order can still be refunded. */
export function refundableBalance(order: Order): number {
  return order.grandTotalPaise - order.refundedPaise;
}

/**
 * Locks the order while a refund is being settled with the payment
 * provider. Refuses anything but `paid` — an order already mid-refund, not
 * yet paid, or already fully refunded has no business entering this state
 * a second way.
 */
export function lockOrderForRefund(order: Order, now?: Date): Order {
  // Idempotent, like markPaid: a caller retrying an already-locked order
  // (the second of two racing lock attempts) must not fail an optimistic-lock
  // check just for being second.
  if (order.status === 'refund_requested') return order;
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'refund_requested', ORDER_TRANSITIONS),
  };
}

/**
 * Restores the order after a refund fails to settle (provider error,
 * rejection). Always goes back to `paid` — the FSM's only valid
 * predecessor of `refund_requested` — never a value chosen by the caller.
 * This is the fix for v1's admin console bug: it hardcoded the restore
 * status on refund rejection, which would have reopened an already-scanned
 * ticket for re-entry had the order actually reached a checked-in state by
 * then.
 */
export function restoreOrderAfterRefundFailure(order: Order, now?: Date): Order {
  if (order.status !== 'refund_requested') {
    throw new InvalidOperationError(
      `Cannot restore order ${order.id}: not currently locked for refund`,
    );
  }
  const at = now ?? new Date();
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, 'paid', ORDER_TRANSITIONS),
  };
}

/**
 * Applies a settled refund. Partial refunds return the order to `paid`
 * with the remainder still refundable; a refund that exhausts the balance
 * moves the order to the terminal `refunded` status.
 */
export function applyOrderRefund(
  order: Order,
  amountPaise: number,
  now?: Date,
  refundRequestId?: EntityId,
): Order {
  if (refundRequestId && order.appliedRefundRequestIds.includes(refundRequestId)) return order;
  if (order.status !== 'refund_requested') {
    throw new InvalidOperationError(`Cannot apply a refund to order ${order.id}: not locked`);
  }
  if (amountPaise <= 0) {
    throw new InvalidOperationError('Refund amount must be positive');
  }
  const refundedPaise = order.refundedPaise + amountPaise;
  if (refundedPaise > order.grandTotalPaise) {
    throw new InvalidOperationError(`Refund of ${amountPaise} exceeds order ${order.id}'s balance`);
  }
  const at = now ?? new Date();
  const nextStatus = refundedPaise === order.grandTotalPaise ? 'refunded' : 'paid';
  return {
    ...bumpVersion(order, at),
    status: transitionStatus(order.status, nextStatus, ORDER_TRANSITIONS),
    refundedPaise,
    appliedRefundRequestIds: refundRequestId
      ? [...order.appliedRefundRequestIds, refundRequestId]
      : order.appliedRefundRequestIds,
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
