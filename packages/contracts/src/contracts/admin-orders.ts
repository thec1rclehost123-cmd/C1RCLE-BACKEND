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
  // Phone-only guest checkout stores an empty string, not null -- OrderContact
  // has no way to represent "no email" otherwise, and that's a legitimate,
  // common state here (not malformed data), so the empty string must validate.
  email: z.union([z.email(), z.literal('')]),
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

export const adminPromoterOrderInvestigationSchema = z.object({
  bookingReference: z.string().nullable(),
  order: adminOrderDtoSchema,
  attribution: z
    .object({
      promoterId: opaqueIdSchema,
      assignmentId: opaqueIdSchema,
      assignmentVersion: z.number().int().positive(),
      referralLinkId: opaqueIdSchema,
      code: z.string(),
      termsVersion: z.number().int().positive(),
      attributedAt: z.iso.datetime(),
      promoterCommissionPaise: z.number().int().nonnegative(),
      commissionPolicyVersion: z.string().nullable(),
      commercialPolicyVersion: z.string().nullable(),
    })
    .nullable(),
  journals: z.array(
    z.object({
      id: opaqueIdSchema,
      sourceType: z.string(),
      sourceId: opaqueIdSchema,
      assignmentId: opaqueIdSchema.nullable(),
      commissionPolicyVersion: z.string().nullable(),
      commercialPolicyVersion: z.string().nullable(),
      componentPromoterCommissionPaise: z.number().int().nonnegative().nullable(),
      reversalOfJournalId: opaqueIdSchema.nullable(),
      status: z.literal('posted'),
      postedAt: z.iso.datetime(),
    }),
  ),
});
export type AdminPromoterOrderInvestigation = z.infer<typeof adminPromoterOrderInvestigationSchema>;
