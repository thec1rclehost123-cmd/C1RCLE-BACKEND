import { bookingReferenceForOrderId } from '@c1rcle/core/domain';

import type { OrderDto } from '@c1rcle/contracts/client';
import type { Order } from '@c1rcle/core/domain';

/**
 * Wire `Order` → `orderDtoSchema` (= `checkoutOrderDtoSchema`, see
 * `packages/contracts/src/contracts/checkout.ts`). One mapping, shared by
 * every route that serializes an order — `payment-routes.ts`'s verify
 * response and every PR3 orders/wallet route below.
 */
export function orderToDto(order: Order): OrderDto {
  const originalIds = new Set(order.refundSnapshot?.tickets.map((ticket) => ticket.entitlementId));
  const applied = new Set(order.appliedRefundRequestIds);
  const settledIds = new Set(
    (order.refundedTicketClaims ?? [])
      .filter((claim) => originalIds.has(claim.entitlementId) && applied.has(claim.refundRequestId))
      .map((claim) => claim.entitlementId),
  );
  const admissionRefundState =
    originalIds.size === 0
      ? undefined
      : settledIds.size === 0
        ? 'none'
        : settledIds.size === originalIds.size
          ? 'all'
          : 'partial';
  return {
    ...(admissionRefundState ? { admissionRefundState } : {}),
    id: order.id,
    ...(order.fulfillmentState ? { fulfillmentState: order.fulfillmentState } : {}),
    ...(order.fulfillmentCompletedAt
      ? { fulfillmentCompletedAt: order.fulfillmentCompletedAt }
      : {}),
    ...(order.receiptFacts ? { receiptFacts: order.receiptFacts } : {}),
    ...(order.feePolicy ? { feePolicy: order.feePolicy } : {}),
    bookingReference: order.bookingReference ?? bookingReferenceForOrderId(order.id),
    eventId: order.eventId,
    organizationId: order.organizationId,
    userId: order.userId,
    status: order.status,
    lines: order.lines,
    currency: order.currency,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    discountedSubtotalPaise: order.discountedSubtotalPaise,
    platformFeePaise: order.platformFeePaise,
    paymentFeePaise: order.paymentFeePaise,
    gstPaise: order.gstPaise,
    grandTotalPaise: order.grandTotalPaise,
    ...(order.addOnSubtotalPaise === undefined
      ? {}
      : { addOnSubtotalPaise: order.addOnSubtotalPaise }),
    appliedPromoCode: order.appliedPromoCode,
    paymentIntentId: order.paymentIntentId,
    paymentId: order.paymentId,
    paidAt: order.paidAt,
    reservationExpiresAt: order.reservationExpiresAt,
    failureReason: order.failureReason,
    eventCancellation: order.eventCancellation ?? null,
    refundedPaise: order.refundedPaise,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
