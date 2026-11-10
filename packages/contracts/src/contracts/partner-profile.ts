import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

export const partnerPublicProfileEventSchema = z.object({
  id: opaqueIdSchema,
  title: z.string().min(1).max(200),
  startAt: z.iso.datetime(),
  imageUrl: z.url().nullable(),
});

export const partnerPublicProfileDtoSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(['host', 'venue', 'promoter']),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(60),
  city: z.string().max(100).nullable(),
  verified: z.boolean(),
  bio: z.string().max(2000),
  photoUrl: z.url().nullable(),
  coverUrl: z.url().nullable(),
  genres: z.array(z.string().min(1).max(60)).max(20),
  stats: z.array(z.object({ label: z.string().max(80), value: z.string().max(40) })).max(8),
  upcomingEvents: z.array(partnerPublicProfileEventSchema).max(6),
  venue: z
    .object({
      capacity: z.number().int().nonnegative().nullable(),
      facilities: z.array(z.string().max(60)).max(50),
      address: z.object({
        street: z.string().max(200).optional(),
        city: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        zip: z.string().max(20).optional(),
        country: z.string().max(100).optional(),
      }),
    })
    .nullable(),
});

export const partnerProfileFieldsSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  bio: z.string().max(2000).optional(),
  photoUrl: z.url().nullable().optional(),
  coverUrl: z.url().nullable().optional(),
  city: z.string().max(100).optional(),
  genres: z.array(z.string().min(1).max(60)).max(20).optional(),
  instagram: z.string().max(200).optional(),
  website: z.url().optional(),
});

export const partnerPrivacySchema = z.object({
  profileVisible: z.boolean(),
  showGuestList: z.boolean(),
});

export const partnerInAppNotificationsSchema = z.object({
  eventUpdates: z.boolean(),
  orderUpdates: z.boolean(),
  requests: z.boolean(),
  partnerships: z.boolean(),
  payouts: z.boolean(),
});

export const partnerSettingsDtoSchema = z.object({
  organizationId: opaqueIdSchema,
  displayName: z.string().min(1).max(200),
  handle: z.string().min(1).max(60),
  profile: partnerProfileFieldsSchema,
  privacy: partnerPrivacySchema,
  inAppNotifications: partnerInAppNotificationsSchema,
  memberSince: z.iso.datetime(),
  stats: z.object({
    events: z.number().int().nonnegative().nullable(),
    ticketsSold: z.number().int().nonnegative().nullable(),
    checkIns: z.number().int().nonnegative().nullable(),
    connections: z.number().int().nonnegative(),
  }),
});

export const updatePartnerSettingsSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    handle: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    profile: partnerProfileFieldsSchema.partial().optional(),
    privacy: partnerPrivacySchema.partial().optional(),
    inAppNotifications: partnerInAppNotificationsSchema.partial().optional(),
  })
  .strict();

export type PartnerSettingsDto = z.infer<typeof partnerSettingsDtoSchema>;
export type UpdatePartnerSettingsInput = z.infer<typeof updatePartnerSettingsSchema>;
export type PartnerPublicProfileDto = z.infer<typeof partnerPublicProfileDtoSchema>;
