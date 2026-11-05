import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

export const guestSocialPrivacySchema = z
  .object({
    profileVisible: z.boolean(),
    showOnGuestlists: z.boolean(),
    showUpcomingEvents: z.boolean(),
  })
  .strict();
export const guestSocialPrivacyStateSchema = guestSocialPrivacySchema
  .extend({
    blockedUsers: z.array(
      z.object({ id: opaqueIdSchema, displayName: z.string().min(1).max(200) }).strict(),
    ),
    hiddenEvents: z.array(z.object({ id: opaqueIdSchema, title: z.string().max(300) }).strict()),
  })
  .strict();
export const socialGuestIdentitySchema = z
  .object({
    id: opaqueIdSchema,
    displayName: z.string().min(2).max(200),
    avatarUrl: z
      .url()
      .regex(/^https?:\/\//)
      .nullable(),
    interests: z
      .array(
        z.enum([
          'Techno',
          'House',
          'Hip-Hop',
          'Bollywood',
          'Live Music',
          'Festivals',
          'College Events',
          'Comedy',
          'Food & Experiences',
        ]),
      )
      .max(9),
  })
  .strict();
export const socialEventSummarySchema = z
  .object({
    id: opaqueIdSchema,
    slug: z.string().min(1).max(300),
    title: z.string().min(1).max(300),
    startAt: z.iso.datetime(),
    imageUrl: z.url().nullable(),
  })
  .strict();
export const socialGuestProfileSchema = z
  .object({
    identity: socialGuestIdentitySchema,
    upcomingEvents: z.array(socialEventSummarySchema),
  })
  .strict();
export const socialGuestlistSchema = z
  .object({
    event: socialEventSummarySchema,
    items: z.array(socialGuestIdentitySchema),
    visibleCount: z.number().int().nonnegative(),
    nextCursor: z.string().regex(/^\d+$/).nullable(),
    hiddenForMe: z.boolean(),
  })
  .strict();
export const socialListQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{1,4}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const socialHiddenEventSchema = z.object({ hidden: z.boolean() }).strict();
export const socialBlockSchema = z.object({ blocked: z.boolean() }).strict();
export const socialReportSchema = z
  .object({
    category: z.enum(['harassment', 'impersonation', 'safety', 'other']),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();
export const socialReportReceiptSchema = z.object({ reference: opaqueIdSchema }).strict();
export const socialEventPolicySchema = z.object({ enabled: z.boolean() }).strict();
export const managedSocialEventsSchema = z
  .object({
    items: z.array(
      z.object({ id: opaqueIdSchema, title: z.string(), enabled: z.boolean() }).strict(),
    ),
  })
  .strict();
export type GuestSocialPrivacy = z.infer<typeof guestSocialPrivacySchema>;
export type GuestSocialPrivacyState = z.infer<typeof guestSocialPrivacyStateSchema>;
export type SocialGuestProfile = z.infer<typeof socialGuestProfileSchema>;
export type SocialGuestlist = z.infer<typeof socialGuestlistSchema>;
export const socialMutationReceiptSchema = z.null();
