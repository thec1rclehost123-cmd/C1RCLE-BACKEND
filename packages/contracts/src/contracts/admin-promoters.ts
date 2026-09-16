import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin promoters desk DTOs ───────────────────────────────────────
 * V2 has no standalone "promoter" entity — a promoter is an `Organization`
 * member with a versioned commission assignment per event
 * (`PromoterAssignment`). Platform-wide, read-only listing for the
 * `/promoters` admin dashboard.
 */
export const adminPromoterAssignmentStatusSchema = z.enum(['active', 'ended']);
export type AdminPromoterAssignmentStatus = z.infer<typeof adminPromoterAssignmentStatusSchema>;

export const adminPromoterAssignmentDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  promoterId: opaqueIdSchema,
  status: adminPromoterAssignmentStatusSchema,
  ratePercent: z.number().nonnegative(),
  flatPaise: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});
export type AdminPromoterAssignmentDto = z.infer<typeof adminPromoterAssignmentDtoSchema>;

export const adminPromoterAssignmentListResponseSchema = paginatedSchema(
  adminPromoterAssignmentDtoSchema,
);
export type AdminPromoterAssignmentListResponse = z.infer<
  typeof adminPromoterAssignmentListResponseSchema
>;
