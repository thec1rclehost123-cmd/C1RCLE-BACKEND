import { z } from 'zod';

import { orderStatusSchema } from './checkout.js';
import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin orders desk DTOs ──────────────────────────────────────────
 * Lean platform-wide order summary for the `/orders` admin read-only dashboard.
 * Mirrors `CheckoutOrderDto` core fields only — full order detail stays on the
 * guest/partner desks. Money in paise, timestamps ISO 8601, matching every other
 * contract in this package.
 */
export const adminOrderContactDtoSchema = z.object({
  name: z.string(),
  email: z.email(),
  phone: z.string(),
});
export type AdminOrderContactDto = z.infer<typeof adminOrderContactDtoSchema>;

export const adminOrderDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema.nullable(),
  status: orderStatusSchema,
  ticketCount: z.number().int().nonnegative(),
  grandTotalPaise: z.number().int().nonnegative(),
  refundedPaise: z.number().int().nonnegative(),
  contact: adminOrderContactDtoSchema,
  paymentId: z.string().nullable(),
  paidAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminOrderDto = z.infer<typeof adminOrderDtoSchema>;

export const adminOrderListResponseSchema = paginatedSchema(adminOrderDtoSchema);
export type AdminOrderListResponse = z.infer<typeof adminOrderListResponseSchema>;
