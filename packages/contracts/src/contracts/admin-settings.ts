import { z } from 'zod';

/**
 * ─── Phase 7 admin platform-settings DTOs ────────────────────────────────────
 * Singleton platform-wide settings doc. Editable by admin via
 * `GET /admin/settings/platform` (read) and `PUT /admin/settings/platform`
 * (merge-update).
 */

export const platformSettingsDtoSchema = z.object({
  platformFeeRate: z.number().min(0).max(1),
  refundSingleApproverThresholdPaise: z.number().int().nonnegative(),
  refundDualApproverThresholdPaise: z.number().int().nonnegative(),
  maintenanceMode: z.boolean(),
  featureFlags: z.record(z.string(), z.boolean()),
  updatedAt: z.iso.datetime(),
});
export type PlatformSettingsDto = z.infer<typeof platformSettingsDtoSchema>;

export const platformSettingsUpdateRequestSchema = z
  .object({
    platformFeeRate: z.number().min(0).max(1).optional(),
    refundSingleApproverThresholdPaise: z.number().int().nonnegative().optional(),
    refundDualApproverThresholdPaise: z.number().int().nonnegative().optional(),
    maintenanceMode: z.boolean().optional(),
    featureFlags: z.record(z.string(), z.boolean()).optional(),
  })
  .strict();
export type PlatformSettingsUpdateRequest = z.infer<typeof platformSettingsUpdateRequestSchema>;
