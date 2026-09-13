import { z } from 'zod';

import { eventStatusSchema } from './event.js';
import { organizationStatusSchema } from './organization.js';
import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin directory DTOs ────────────────────────────────────────────
 * Platform-wide registration reads (venues / events / hosts / users). Lean
 * summary shapes only — detailed resources stay on their own desks. Money in
 * paise, timestamps epoch ms, matching every other contract in this package.
 */
export const adminVenueDtoSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  status: z.enum(['active', 'suspended']),
  capacity: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminVenueDto = z.infer<typeof adminVenueDtoSchema>;

export const adminVenueListResponseSchema = paginatedSchema(adminVenueDtoSchema);
export type AdminVenueListResponse = z.infer<typeof adminVenueListResponseSchema>;

export const adminEventDtoSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  venueId: opaqueIdSchema.nullable(),
  slug: z.string(),
  title: z.string(),
  status: eventStatusSchema,
  isPublic: z.boolean(),
  adminOverride: z.boolean(),
  startAt: z.string(),
  endAt: z.string().nullable(),
  startingPricePaise: z.number().int().nonnegative().nullable(),
  isFree: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminEventDto = z.infer<typeof adminEventDtoSchema>;

export const adminEventListResponseSchema = paginatedSchema(adminEventDtoSchema);
export type AdminEventListResponse = z.infer<typeof adminEventListResponseSchema>;

export const adminHostDtoSchema = z.object({
  id: opaqueIdSchema,
  ownerId: opaqueIdSchema,
  name: z.string(),
  slug: z.string(),
  status: organizationStatusSchema,
  platformFeePercent: z.number(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminHostDto = z.infer<typeof adminHostDtoSchema>;

export const adminHostListResponseSchema = paginatedSchema(adminHostDtoSchema);
export type AdminHostListResponse = z.infer<typeof adminHostListResponseSchema>;

export const adminUserDtoSchema = z.object({
  id: opaqueIdSchema,
  email: z.email(),
  name: z.string(),
  image: z.string().nullable(),
  emailVerified: z.boolean(),
  role: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type AdminUserDto = z.infer<typeof adminUserDtoSchema>;

export const adminUserListResponseSchema = paginatedSchema(adminUserDtoSchema);
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;
