import type { OrderDto } from '@c1rcle/contracts/client';
import type { Order } from '@c1rcle/core/domain';

/**
 * Wire `Order` → `orderDtoSchema` (= `checkoutOrderDtoSchema`, see
 * `packages/contracts/src/contracts/checkout.ts`). One mapping, shared by
 * every route that serializes an order — `payment-routes.ts`'s verify
 * response and every PR3 orders/wallet route below.
 */
export function orderToDto(order: Order): OrderDto {
  return {
    id: order.id,
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
    appliedPromoCode: order.appliedPromoCode,
    paymentIntentId: order.paymentIntentId,
    paymentId: order.paymentId,
    paidAt: order.paidAt,
    reservationExpiresAt: order.reservationExpiresAt,
    failureReason: order.failureReason,
    version: order.version,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}
