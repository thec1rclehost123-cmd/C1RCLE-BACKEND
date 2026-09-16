import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin promotions desk DTOs ──────────────────────────────────────
 * Platform-wide, read-only promo code listing for the `/promotions` admin
 * dashboard. Creation/editing stays a partner action, scoped to their own
 * event (`EventCatalogService.createPromotion`) — the admin desk is a
 * cross-event view, not a second write path.
 */
export const adminPromoTypeSchema = z.enum(['public', 'private', 'single_use', 'multi_use']);
export type AdminPromoType = z.infer<typeof adminPromoTypeSchema>;

export const adminPromoDiscountTypeSchema = z.enum(['percent', 'fixed']);
export type AdminPromoDiscountType = z.infer<typeof adminPromoDiscountTypeSchema>;

export const adminPromoDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema.nullable(),
  organizationId: opaqueIdSchema,
  code: z.string(),
  name: z.string(),
  type: adminPromoTypeSchema,
  discountType: adminPromoDiscountTypeSchema,
  discountValue: z.number().int().nonnegative(),
  maxRedemptions: z.number().int().nonnegative().nullable(),
  redemptionCount: z.number().int().nonnegative(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AdminPromoDto = z.infer<typeof adminPromoDtoSchema>;

export const adminPromoListResponseSchema = paginatedSchema(adminPromoDtoSchema);
export type AdminPromoListResponse = z.infer<typeof adminPromoListResponseSchema>;
