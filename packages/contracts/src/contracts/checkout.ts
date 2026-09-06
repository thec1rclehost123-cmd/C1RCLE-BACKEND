import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

/**
 * ─── Checkout + Orders + Payments Contracts ──────────────────────────────────
 */

/**
 * Line items shared by the quote and hold request bodies — a tier + how many.
 */
const checkoutLineRequestSchema = z.object({
  tierId: opaqueIdSchema,
  quantity: z.number().int().positive().max(100),
});

/** One priced line, as `CheckoutService.quote`/`createHold` actually return it. */
export const pricingLineDtoSchema = z.object({
  tierId: opaqueIdSchema,
  tierName: z.string(),
  quantity: z.number().int().positive(),
  unitPricePaise: z.number().int().nonnegative(),
  subtotalPaise: z.number().int().nonnegative(),
});
export type PricingLineDto = z.infer<typeof pricingLineDtoSchema>;

/**
 * The full pricing breakdown, matching `packages/core`'s `PricingBreakdown`
 * exactly (subtotal -> discount -> fees on the discounted subtotal -> GST on
 * fees only; see `domain/models/pricing.ts`). Money is always integer paise.
 */
export const pricingBreakdownDtoSchema = z.object({
  lines: z.array(pricingLineDtoSchema),
  subtotalPaise: z.number().int().nonnegative(),
  discountPaise: z.number().int().nonnegative(),
  discountedSubtotalPaise: z.number().int().nonnegative(),
  platformFeePaise: z.number().int().nonnegative(),
  paymentFeePaise: z.number().int().nonnegative(),
  gstPaise: z.number().int().nonnegative(),
  grandTotalPaise: z.number().int().nonnegative(),
  appliedPromoCode: z.string().nullable(),
  currency: z.string().length(3),
});
export type PricingBreakdownDto = z.infer<typeof pricingBreakdownDtoSchema>;

/**
 * `POST /checkout/quote` — pure pricing calculation, no side effects, no
 * inventory hold. No `idempotencyKey`: a quote is a read-ish calculation, not
 * a write (unlike `POST /checkout/holds` below, which does reserve inventory
 * and therefore needs one).
 */
export const checkoutQuoteRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    lines: z.array(checkoutLineRequestSchema).min(1),
    promoCode: z.string().optional().nullable(),
    referralCode: z.string().optional().nullable(),
  })
  .strict();
export type CheckoutQuoteRequest = z.infer<typeof checkoutQuoteRequestSchema>;

/** Bare pricing breakdown — `checkout.quote()` creates no hold and no order. */
export const checkoutQuoteResponseSchema = pricingBreakdownDtoSchema;
export type CheckoutQuoteResponse = z.infer<typeof checkoutQuoteResponseSchema>;

export const cartReservationStatusSchema = z.enum(['active', 'converted', 'released']);

/**
 * `POST /checkout/holds` — reserves inventory for the hold TTL.
 * `Idempotency-Key` is REQUIRED (a header, not a body field — see
 * `routes/v2/partner/events.ts`'s `createEventHeaders` for the pattern this
 * mirrors; the previous body-level `idempotencyKey` here did not match how
 * every other V2 write route carries it).
 */
export const checkoutHoldRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    lines: z.array(checkoutLineRequestSchema).min(1),
    promoCode: z.string().optional().nullable(),
    referralCode: z.string().optional().nullable(),
  })
  .strict();
export type CheckoutHoldRequest = z.infer<typeof checkoutHoldRequestSchema>;

/**
 * A hold has no `orderId` — `CartReservation` only gains a `convertedOrderId`
 * once payment is confirmed (`checkout.confirmPayment()`). The previous
 * schema required a non-optional `orderId` a hold response can never carry.
 */
export const checkoutHoldResponseSchema = z.object({
  holdId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  status: cartReservationStatusSchema,
  pricing: pricingBreakdownDtoSchema,
  convertedOrderId: opaqueIdSchema.nullable(),
});
export type CheckoutHoldResponse = z.infer<typeof checkoutHoldResponseSchema>;

/* ─── Payment attempts / confirmation ─────────────────────────────────────── */

/** `POST /payments/attempts` — creates a provider payment intent for a hold. */
export const paymentAttemptRequestSchema = z
  .object({
    holdId: opaqueIdSchema,
  })
  .strict();
export type PaymentAttemptRequest = z.infer<typeof paymentAttemptRequestSchema>;

export const paymentAttemptResponseSchema = z.object({
  paymentIntentId: z.string().min(1),
  amountPaise: z.number().int().nonnegative(),
  /** Razorpay's publishable key id — safe to expose, needed to open the checkout widget. */
  keyId: z.string().optional(),
});
export type PaymentAttemptResponse = z.infer<typeof paymentAttemptResponseSchema>;

/**
 * `POST /payments/:id/verify` — client-redirect confirmation. `:id` is the
 * provider payment id; the body carries the rest of what the provider's
 * checkout widget hands back to the browser.
 */
export const paymentConfirmRequestSchema = z
  .object({
    holdId: opaqueIdSchema,
    paymentIntentId: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();
export type PaymentConfirmRequest = z.infer<typeof paymentConfirmRequestSchema>;

const checkoutOrderStatusSchema = z.enum([
  'pending',
  'awaiting_payment',
  'paid',
  'expired',
  'cancelled',
  'failed',
  'refunded',
]);

const checkoutOrderLineDtoSchema = z.object({
  tierId: opaqueIdSchema,
  tierName: z.string(),
  quantity: z.number().int().positive(),
  unitPricePaise: z.number().int().nonnegative(),
  subtotalPaise: z.number().int().nonnegative(),
});

/**
 * `Order` as `CheckoutService` actually returns it (see
 * `domain/models/order.ts`). Deliberately separate from `orderDtoSchema`
 * below, which does not match the committed `Order` model (no `feesPaise`/
 * `taxPaise`/`paymentProvider`/`paymentStatus` fields exist on `Order`) —
 * reconciling that DTO is out of scope for the checkout/payments slice and
 * left for the orders/tickets/wallet PR.
 */
export const checkoutOrderDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema.nullable(),
  status: checkoutOrderStatusSchema,
  lines: z.array(checkoutOrderLineDtoSchema),
  currency: z.string().length(3),
  subtotalPaise: z.number().int().nonnegative(),
  discountPaise: z.number().int().nonnegative(),
  discountedSubtotalPaise: z.number().int().nonnegative(),
  platformFeePaise: z.number().int().nonnegative(),
  paymentFeePaise: z.number().int().nonnegative(),
  gstPaise: z.number().int().nonnegative(),
  grandTotalPaise: z.number().int().nonnegative(),
  appliedPromoCode: z.string().nullable(),
  paymentIntentId: z.string().nullable(),
  paymentId: z.string().nullable(),
  paidAt: z.iso.datetime().nullable(),
  reservationExpiresAt: z.iso.datetime(),
  failureReason: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CheckoutOrderDto = z.infer<typeof checkoutOrderDtoSchema>;

/* ─── Orders ───────────────────────────────────────────────────────────────── */
/* `orderDtoSchema` is `checkoutOrderDtoSchema` under its canonical name — see
 * that schema's doc comment (above) for why the two were briefly separate:
 * this one never matched the committed `Order` model (wrong status enum,
 * fields like `feesPaise`/`totalPaise`/`paymentStatus` that don't exist on
 * `Order`) and was left unreconciled for the orders/tickets/wallet PR. */

export const orderStatusSchema = checkoutOrderStatusSchema;
export const orderDtoSchema = checkoutOrderDtoSchema;
export type OrderDto = CheckoutOrderDto;

export const ordersListResponseSchema = paginatedSchema(orderDtoSchema);
export type OrdersListResponse = z.infer<typeof ordersListResponseSchema>;

/** Slim projection for `GET /orders/:id/status` — polling shouldn't refetch the full order. */
export const orderStatusResponseSchema = z.object({
  id: opaqueIdSchema,
  status: orderStatusSchema,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type OrderStatusResponse = z.infer<typeof orderStatusResponseSchema>;

/* ─── Entitlements / Tickets ───────────────────────────────────────────────── */

export const entitlementStatusSchema = z.enum(['valid', 'redeemed', 'void']);

export const entitlementDtoSchema = z.object({
  id: opaqueIdSchema,
  orderId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  tierId: opaqueIdSchema,
  tierName: z.string(),
  userId: opaqueIdSchema.nullable(),
  holderName: z.string(),
  status: entitlementStatusSchema,
  scanCountAllowed: z.number().int().positive(),
  scanCount: z.number().int().nonnegative(),
  scannedAt: z.array(z.iso.datetime()),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EntitlementDto = z.infer<typeof entitlementDtoSchema>;

export const entitlementsListResponseSchema = paginatedSchema(entitlementDtoSchema);
export type EntitlementsListResponse = z.infer<typeof entitlementsListResponseSchema>;

/** `POST /payments/:id/verify` response — the fulfilled order + its tickets. */
export const paymentConfirmResponseSchema = z.object({
  order: checkoutOrderDtoSchema,
  entitlements: z.array(entitlementDtoSchema),
});
export type PaymentConfirmResponse = z.infer<typeof paymentConfirmResponseSchema>;

/* ─── Wallet ───────────────────────────────────────────────────────────────── */
/** `GET /wallet` — a light summary; the full lists live at .../tickets and .../orders. */
export const walletSummaryDtoSchema = z.object({
  activeTicketCount: z.number().int().nonnegative(),
  upcomingOrderCount: z.number().int().nonnegative(),
});
export type WalletSummaryDto = z.infer<typeof walletSummaryDtoSchema>;

/* ─── Payments ──────────────────────────────────────────────────────────────── */

export const paymentProviderSchema = z.enum(['razorpay', 'stripe']);

export const paymentOrderRequestSchema = z
  .object({
    amountPaise: z.number().int().positive(),
    currency: z.string().length(3),
    receipt: z.string().max(40),
    notes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type PaymentOrderRequest = z.infer<typeof paymentOrderRequestSchema>;

export const paymentOrderResponseSchema = z.object({
  id: z.string(),
  amountPaise: z.number().int().positive(),
  currency: z.string().length(3),
  status: z.string(),
});
export type PaymentOrderResponse = z.infer<typeof paymentOrderResponseSchema>;

export const paymentVerificationRequestSchema = z
  .object({
    paymentId: z.string().min(1),
    orderId: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();
export type PaymentVerificationRequest = z.infer<typeof paymentVerificationRequestSchema>;

export const paymentVerificationResponseSchema = z.object({
  verified: z.boolean(),
  paymentId: z.string(),
  amountPaise: z.number().int().nonnegative(),
  captured: z.boolean(),
});
export type PaymentVerificationResponse = z.infer<typeof paymentVerificationResponseSchema>;

export const refundRequestSchema = z
  .object({
    paymentId: z.string().min(1),
    amountPaise: z.number().int().positive().optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export const refundResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  amountPaise: z.number().int().nonnegative(),
});
export type RefundResponse = z.infer<typeof refundResponseSchema>;
