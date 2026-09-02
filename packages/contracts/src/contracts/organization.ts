import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

/**
 * ─── Organization + Venue + Member Contracts ─────────────────────────────────
 */

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

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Invalid slug format'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

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

/* ─── Organization members ─────────────────────────────────────────────── */

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

/* ─── Venue profile / calendar / slot-requests ─────────────────────── */

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

/* ─── Organization invitations ─────────────────────────────────────────────── */

export const invitationStatusSchema = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationDtoSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  email: z.email(),
  role: organizationRoleSchema,
  capabilities: z.array(z.enum(['host', 'venue', 'promoter'])),
  status: invitationStatusSchema,
  invitedBy: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InvitationDto = z.infer<typeof invitationDtoSchema>;

/** Owner cannot be invited — the owner is set at creation and transferred. */
export const createInvitationSchema = z
  .object({
    email: z.email(),
    role: z.enum(['admin', 'manager', 'member']),
    capabilities: z.array(z.enum(['host', 'venue', 'promoter'])).optional(),
  })
  .strict();
export type CreateInvitationRequest = z.infer<typeof createInvitationSchema>;

/* ─── Venue availability (derived from calendar slots) ─────────────────────── */

export const venueAvailabilitySlotSchema = z.object({
  id: opaqueIdSchema,
  label: z.string(),
  startTime: z.iso.datetime(),
  endTime: z.iso.datetime(),
  status: z.enum(['open', 'booked', 'blocked', 'cancelled']),
  capacityFor: z.number().int().nonnegative().nullable(),
});

export const venueAvailabilityDtoSchema = z.object({
  venueId: opaqueIdSchema,
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  openSlots: z.number().int().nonnegative(),
  bookedSlots: z.number().int().nonnegative(),
  blockedSlots: z.number().int().nonnegative(),
  openMinutes: z.number().int().nonnegative(),
  fullyBooked: z.boolean(),
  slots: z.array(venueAvailabilitySlotSchema),
});
export type VenueAvailabilityDto = z.infer<typeof venueAvailabilityDtoSchema>;

/* ─── Venue menu ───────────────────────────────────────────────────────────── */

export const venueMenuItemSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** Integer paise, like every other money field on the wire. */
  pricePaise: z.number().int().nonnegative().nullable(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});

export const venueMenuSectionSchema = z.object({
  name: z.string().min(1).max(120),
  items: z.array(venueMenuItemSchema).max(200),
});

export const venueMenuDtoSchema = z.object({
  sections: z.array(venueMenuSectionSchema).max(50),
  updatedAt: z.iso.datetime().nullable(),
});
export type VenueMenuDto = z.infer<typeof venueMenuDtoSchema>;

/** PUT replaces the menu wholesale — a merge could not express a deletion. */
export const updateVenueMenuSchema = z
  .object({ sections: z.array(venueMenuSectionSchema).max(50) })
  .strict();
export type UpdateVenueMenuRequest = z.infer<typeof updateVenueMenuSchema>;
