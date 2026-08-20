import { z } from 'zod';
import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

/**
 * ─── Checkout + Orders + Payments Contracts ──────────────────────────────────
 */

export const checkoutQuoteRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    lines: z
      .array(
        z.object({
          tierId: opaqueIdSchema,
          quantity: z.number().int().positive().max(100),
        })
      )
      .min(1),
    promoCode: z.string().optional().nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CheckoutQuoteRequest = z.infer<typeof checkoutQuoteRequestSchema>;

export const checkoutQuoteResponseSchema = z.object({
  holdId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  order: z.object({
    id: opaqueIdSchema,
    eventId: opaqueIdSchema,
    lines: z.array(
      z.object({
        tierId: opaqueIdSchema,
        tierName: z.string(),
        quantity: z.number().int().positive(),
        unitPricePaise: z.number().int().nonnegative(),
        lineTotalPaise: z.number().int().nonnegative(),
      })
    ),
    subtotalPaise: z.number().int().nonnegative(),
    feesPaise: z.number().int().nonnegative(),
    taxPaise: z.number().int().nonnegative(),
    discountPaise: z.number().int().nonnegative(),
    totalPaise: z.number().int().nonnegative(),
    currency: z.string().length(3),
  }),
  payment: z
    .object({
      required: z.boolean(),
      amountPaise: z.number().int().nonnegative(),
      currency: z.string().length(3),
      provider: z.string().optional(),
    })
    .optional(),
});
export type CheckoutQuoteResponse = z.infer<typeof checkoutQuoteResponseSchema>;

export const checkoutHoldRequestSchema = z
  .object({
    eventId: opaqueIdSchema,
    lines: z
      .array(
        z.object({
          tierId: opaqueIdSchema,
          quantity: z.number().int().positive().max(100),
        })
      )
      .min(1),
    promoCode: z.string().optional().nullable(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CheckoutHoldRequest = z.infer<typeof checkoutHoldRequestSchema>;

export const checkoutHoldResponseSchema = z.object({
  holdId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  orderId: opaqueIdSchema,
});
export type CheckoutHoldResponse = z.infer<typeof checkoutHoldResponseSchema>;

/* ─── Orders ───────────────────────────────────────────────────────────────── */

export const orderStatusSchema = z.enum([
  'created',
  'hold',
  'paid',
  'fulfilled',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

export const orderLineDtoSchema = z.object({
  tierId: opaqueIdSchema,
  tierName: z.string(),
  quantity: z.number().int().positive(),
  unitPricePaise: z.number().int().nonnegative(),
  lineTotalPaise: z.number().int().nonnegative(),
});

export const orderDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema.nullable(),
  lines: z.array(orderLineDtoSchema),
  subtotalPaise: z.number().int().nonnegative(),
  feesPaise: z.number().int().nonnegative(),
  taxPaise: z.number().int().nonnegative(),
  discountPaise: z.number().int().nonnegative(),
  totalPaise: z.number().int().nonnegative(),
  currency: z.string().length(3),
  promoCodeId: opaqueIdSchema.nullable(),
  promoDiscountPaise: z.number().int().nonnegative(),
  status: orderStatusSchema,
  paymentId: opaqueIdSchema.nullable(),
  paymentProvider: z.string().nullable(),
  paymentStatus: z.enum(['pending', 'succeeded', 'failed', 'refunded']).nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderDto = z.infer<typeof orderDtoSchema>;

export const ordersListResponseSchema = paginatedSchema(z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  eventTitle: z.string(),
  totalPaise: z.number().int().nonnegative(),
  status: orderStatusSchema,
  createdAt: z.iso.datetime(),
}));
export type OrdersListResponse = z.infer<typeof ordersListResponseSchema>;

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