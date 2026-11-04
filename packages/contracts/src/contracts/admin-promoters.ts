import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin promoters desk DTOs ───────────────────────────────────────
 * V2 has no standalone "promoter" entity — a promoter is an `Organization`
 * member with a versioned commission assignment per event
 * (`PromoterAssignment`). Platform-wide, read-only listing for the
 * `/promoters` admin dashboard.
 */
export const adminPromoterAssignmentStatusSchema = z.enum([
  'invited',
  'accepted',
  'rejected',
  'revoked',
  'expired',
  'active',
  'ended',
  'suspended',
]);
export type AdminPromoterAssignmentStatus = z.infer<typeof adminPromoterAssignmentStatusSchema>;

export const adminPromoterAssignmentDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  promoterId: opaqueIdSchema,
  status: adminPromoterAssignmentStatusSchema,
  ratePercent: z.number().nonnegative(),
  flatPaise: z.number().int().nonnegative(),
  termsVersion: z.number().int().positive(),
  tierRates: z
    .record(
      z.string(),
      z.object({
        ratePercent: z.number().nonnegative(),
        flatPaise: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  eligibleTierIds: z.array(opaqueIdSchema).nullable(),
  createdAt: z.iso.datetime(),
  invitedAt: z.iso.datetime().nullable(),
  invitedBy: opaqueIdSchema.nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  respondedBy: opaqueIdSchema.nullable(),
  endedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: opaqueIdSchema.nullable(),
  revocationReason: z.string().nullable(),
  suspendedAt: z.iso.datetime().nullable(),
});
export type AdminPromoterAssignmentDto = z.infer<typeof adminPromoterAssignmentDtoSchema>;

export const adminPromoterAssignmentListResponseSchema = paginatedSchema(
  adminPromoterAssignmentDtoSchema,
);
export type AdminPromoterAssignmentListResponse = z.infer<
  typeof adminPromoterAssignmentListResponseSchema
>;

/** Minimal Admin read model for link state and vanity counters; no signatures or PII. */
export const adminPromoterReferralLinkDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  assignmentId: opaqueIdSchema.nullable(),
  eventTitle: z.string(),
  code: z.string().min(4).max(16),
  label: z.string().min(1).max(120),
  isActive: z.boolean(),
  clicks: z.number().int().nonnegative(),
  lastClickedAt: z.iso.datetime().nullable(),
  conversions: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminPromoterReferralLinkDto = z.infer<typeof adminPromoterReferralLinkDtoSchema>;
export const adminPromoterReferralLinkListResponseSchema = paginatedSchema(
  adminPromoterReferralLinkDtoSchema,
);
export type AdminPromoterReferralLinkListResponse = z.infer<
  typeof adminPromoterReferralLinkListResponseSchema
>;

/** Active provider disputes tied to this promoter's immutable attributed orders. */
export const adminPromoterRiskFlagSchema = z.object({
  paymentId: opaqueIdSchema,
  disputeId: z.string().min(1).max(200),
  orderId: opaqueIdSchema,
  bookingReference: z.string().nullable(),
  eventId: opaqueIdSchema,
  status: z.enum(['open', 'under_review']),
  amountPaise: z.number().int().nonnegative(),
  providerOccurredAt: z.iso.datetime().nullable(),
});
export type AdminPromoterRiskFlag = z.infer<typeof adminPromoterRiskFlagSchema>;

export const adminPromoterRiskFlagsResponseSchema = z.object({
  promoterId: opaqueIdSchema,
  complete: z.boolean(),
  flags: z.array(adminPromoterRiskFlagSchema),
});
export type AdminPromoterRiskFlagsResponse = z.infer<typeof adminPromoterRiskFlagsResponseSchema>;

export const adminPromoterReferralLinkActionResponseSchema = z.object({
  linkId: opaqueIdSchema,
  action: z.literal('deactivated'),
  changed: z.boolean(),
  at: z.iso.datetime(),
});
export type AdminPromoterReferralLinkActionResponse = z.infer<
  typeof adminPromoterReferralLinkActionResponseSchema
>;

/* ─── Promoter lifecycle (suspend / reinstate) ─────────────────────────────── */

export const adminPromoterSuspendRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type AdminPromoterSuspendRequest = z.infer<typeof adminPromoterSuspendRequestSchema>;

export const adminPromoterActionResponseSchema = z.object({
  promoterId: opaqueIdSchema,
  action: z.enum(['suspended', 'reinstated']),
  affectedAssignments: z.number().int().nonnegative(),
  at: z.iso.datetime(),
});
export type AdminPromoterActionResponse = z.infer<typeof adminPromoterActionResponseSchema>;
