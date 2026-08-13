import { z } from 'zod';

/**
 * ─── V2 API contract runtime schemas ─────────────────────────────────────────
 * Ported from thec1rcle `packages/types/src/client.ts` (browser-safe, frozen).
 * This package mirrors `C1RCLE-FRONTEND/packages/types` 1:1.
 */

export const roleSchema = z.enum(['guest', 'partner', 'admin']);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  displayName: z.string().min(1),
  role: roleSchema,
  avatarUrl: z.url().nullable(),
});
export type User = z.infer<typeof userSchema>;

export const sessionSchema = z.object({
  user: userSchema,
  expiresAt: z.number().int().positive(),
});
export type Session = z.infer<typeof sessionSchema>;

/* ─── B10 auth bridge (Better Auth session ↔ frontend contract) ─────────── */

export const signupRequestSchema = z
  .object({
    email: z.email(),
    password: z.string().min(8).max(128),
    displayName: z.string().min(1).max(200),
  })
  .strict();
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z
  .object({
    email: z.email(),
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** `POST /auth/{signup,login,refresh}` response — task.md §0 frontend bridge shape. */
export const authBridgeResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type AuthBridgeResponse = z.infer<typeof authBridgeResponseSchema>;

export const pageInfoSchema = z.object({
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasNextPage: z.boolean(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

export function paginatedSchema<TItem extends z.ZodType>(itemSchema: TItem) {
  return z.object({
    items: z.array(itemSchema),
    pageInfo: pageInfoSchema,
  });
}
export interface Paginated<TItem> {
  items: TItem[];
  pageInfo: PageInfo;
}

export const noContentSchema = z.void();
export type NoContent = z.infer<typeof noContentSchema>;

/* ─── T06 shared validation helpers ──────────────────────────────────────── */

export const opaqueIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Invalid opaque id format');
export type OpaqueId = z.infer<typeof opaqueIdSchema>;

export const cursorSchema = z.string().min(1).max(256);
export type Cursor = z.infer<typeof cursorSchema>;

export const paginationQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid Idempotency-Key format');
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

export const versionHeaderSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'If-Match must be a positive integer version');
export type IfMatchVersion = z.infer<typeof versionHeaderSchema>;

export const organizationIdSchema = opaqueIdSchema;
export type OrganizationId = z.infer<typeof organizationIdSchema>;

/* ─── V2 partner Event DTO ───────────────────────────────────────────────── */

export const eventStatusSchema = z.enum([
  'draft',
  'review',
  'scheduled',
  'published',
  'sales_paused',
  'started',
  'ended',
  'archived',
  'cancelled',
]);
export type EventStatusDto = z.infer<typeof eventStatusSchema>;

export const eventDtoSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  venueId: opaqueIdSchema.nullable(),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Invalid slug format'),
  title: z.string().min(1).max(200),
  summary: z.string().max(1000).default(''),
  description: z.string().max(20_000).default(''),
  imageUrl: z.url().nullable(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().nullable(),
  status: eventStatusSchema,
  isPublic: z.boolean(),
  tags: z.array(z.string().min(1)).max(50).default([]),
  startingPricePaise: z.number().int().nonnegative().nullable(),
  isFree: z.boolean(),
  cancellationReason: z.string().max(1000).nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EventDto = z.infer<typeof eventDtoSchema>;

/* ─── Organization + venue DTOs ──────────────────────────────────────────── */

export const organizationRoleSchema = z.enum(['owner', 'admin', 'manager', 'member']);
export type OrganizationRoleDto = z.infer<typeof organizationRoleSchema>;

export const organizationStatusSchema = z.enum(['active', 'suspended', 'archived']);
export type OrganizationStatusDto = z.infer<typeof organizationStatusSchema>;

export const organizationDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
  role: organizationRoleSchema,
  status: organizationStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export const venueStatusSchema = z.enum(['active', 'suspended']);
export type VenueStatusDto = z.infer<typeof venueStatusSchema>;

export const venueDtoSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
  status: venueStatusSchema,
  description: z.string().max(2000).default(''),
  capacity: z.number().int().nonnegative().nullable(),
  city: z.string().max(100).nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VenueDto = z.infer<typeof venueDtoSchema>;

/* ─── Request DTOs (write surfaces) ──────────────────────────────────────── */

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const createVenueSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
  description: z.string().max(2000).optional(),
  capacity: z.number().int().nonnegative().nullable().optional(),
  city: z.string().max(100).nullable().optional(),
});
export type CreateVenueInput = z.infer<typeof createVenueSchema>;

/* ─── Organization members (B11) ─────────────────────────────────────────── */

export const organizationMemberDtoSchema = z.object({
  userId: opaqueIdSchema,
  role: organizationRoleSchema,
  capabilities: z.array(z.enum(['host', 'venue', 'promoter'])),
  joinedAt: z.iso.datetime(),
  invitedBy: opaqueIdSchema.optional(),
});
export type OrganizationMemberDto = z.infer<typeof organizationMemberDtoSchema>;

export const inviteMemberSchema = z
  .object({
    userId: opaqueIdSchema,
    role: organizationRoleSchema,
    capabilities: z.array(z.enum(['host', 'venue', 'promoter'])).optional(),
  })
  .strict();
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/* ─── Venue profile / calendar / slot-requests (B11) ─────────────────────── */

export const venueAddressSchema = z.object({
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export const venuePublicProfileSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(60),
  description: z.string().max(2000),
  shortDescription: z.string().max(200).optional(),
  photoUrl: z.url().nullable(),
  address: venueAddressSchema,
  facilities: z.array(z.string().min(1).max(60)),
  capacity: z.number().int().nonnegative().nullable(),
  settings: z.object({ showGuestList: z.boolean(), activityEnabled: z.boolean() }),
});

export const venuePrivateProfileSchema = z.object({
  contactEmail: z.email().nullable(),
  contactPhone: z.string().max(20).nullable(),
  socials: z.object({
    instagram: z.string().max(200).optional(),
    website: z.url().optional(),
    facebook: z.string().max(200).optional(),
  }),
  internalNotes: z.string().max(5000),
});

/** `GET/PATCH /venues/:venueId/profile` — full profile, owner-scoped only. */
export const venueProfileDtoSchema = z.object({
  public: venuePublicProfileSchema,
  private: venuePrivateProfileSchema,
});
export type VenueProfileDto = z.infer<typeof venueProfileDtoSchema>;

export const venueSlotDtoSchema = z.object({
  id: opaqueIdSchema,
  venueId: opaqueIdSchema,
  label: z.string().min(1).max(200),
  startTime: z.iso.datetime(),
  endTime: z.iso.datetime(),
  recurring: z.boolean(),
  status: z.enum(['open', 'booked', 'blocked', 'cancelled']),
  capacityFor: z.number().int().nonnegative().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VenueSlotDto = z.infer<typeof venueSlotDtoSchema>;

export const slotRequestDtoSchema = z.object({
  id: opaqueIdSchema,
  venueId: opaqueIdSchema,
  eventId: opaqueIdSchema.nullable(),
  hostId: opaqueIdSchema,
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']),
  message: z.string().max(2000).optional(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SlotRequestDto = z.infer<typeof slotRequestDtoSchema>;

export const createSlotRequestSchema = z
  .object({
    eventId: opaqueIdSchema.nullable().optional(),
    message: z.string().max(2000).optional(),
  })
  .strict();
export type CreateSlotRequestInput = z.infer<typeof createSlotRequestSchema>;

/* ─── Event lifecycle (B11) ───────────────────────────────────────────────── */

export const updateEventSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(1000).optional(),
    description: z.string().max(20_000).optional(),
    imageUrl: z.url().nullable().optional(),
    startAt: z.iso.datetime().optional(),
    endAt: z.iso.datetime().nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(50).optional(),
    startingPricePaise: z.number().int().nonnegative().optional(),
    isFree: z.boolean().optional(),
  })
  .strict();
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const cancelEventSchema = z
  .object({
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type CancelEventInput = z.infer<typeof cancelEventSchema>;

export const eventPreviewDtoSchema = z.object({
  event: eventDtoSchema,
  isPublic: z.boolean(),
});
export type EventPreviewDto = z.infer<typeof eventPreviewDtoSchema>;

export const createEventSchema = z.object({
  venueId: opaqueIdSchema,
  title: z.string().min(1).max(200),
  summary: z.string().max(1000).optional(),
  description: z.string().max(20_000).optional(),
  imageUrl: z.url().nullable().optional(),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime().nullable(),
  tags: z.array(z.string().min(1)).max(50).default([]),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;
