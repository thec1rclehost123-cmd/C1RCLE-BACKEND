import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

/**
 * ─── Partnerships / Promoters / Referrals / Analytics ─────────────────────────
 */

export const partnershipStatusSchema = z.enum([
  'pending',
  'active',
  'rejected',
  'blocked',
  'ended',
]);

/**
 * Whole-number percent, matching v1's `venueCommissionRate` convention (NOT a
 * 0..1 ratio). `null` = not yet negotiated. Capped at 50 by the domain.
 */
const venueShareRateSchema = z.number().int().min(0).max(50);

export const partnershipDtoSchema = z.object({
  id: opaqueIdSchema,
  hostOrganizationId: opaqueIdSchema,
  venueOrganizationId: opaqueIdSchema,
  venueId: opaqueIdSchema,
  initiatedBy: z.enum(['host', 'venue']),
  status: partnershipStatusSchema,
  message: z.string().nullable(),
  venueShareRate: venueShareRateSchema.nullable(),
  resolutionReason: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Public-safe display enrichment (real backend names, never fabricated). */
  hostName: z.string().min(1).max(200).nullish(),
  hostSlug: z.string().min(1).max(60).nullish(),
  venueName: z.string().min(1).max(200).nullish(),
  venueSlug: z.string().min(1).max(60).nullish(),
  venueCity: z.string().max(100).nullish(),
});
export type PartnershipDto = z.infer<typeof partnershipDtoSchema>;

/**
 * `initiatedBy` says which side the CALLER is.
 * - host-initiated: the caller IS the host; the venue's owning org is resolved
 *   server-side from `venueId`.
 * - venue-initiated: the caller IS the venue owner; the counterparty host org
 *   must be named explicitly via `hostOrganizationId` (a venueId alone cannot
 *   identify which host is being invited).
 */
export const requestPartnershipSchema = z
  .object({
    venueId: opaqueIdSchema,
    initiatedBy: z.enum(['host', 'venue']),
    hostOrganizationId: opaqueIdSchema.optional(),
    message: z.string().max(1000).optional(),
    venueShareRate: venueShareRateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.initiatedBy === 'venue' && !value.hostOrganizationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['hostOrganizationId'],
        message: 'hostOrganizationId is required when initiatedBy is venue',
      });
    }
  });
export type RequestPartnershipRequest = z.infer<typeof requestPartnershipSchema>;

export const resolvePartnershipSchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict();
export type ResolvePartnershipRequest = z.infer<typeof resolvePartnershipSchema>;

/** Negotiate (or clear) the venue's share on a live partnership. */
export const setVenueShareRequestSchema = z
  .object({ venueShareRate: venueShareRateSchema.nullable() })
  .strict();
export type SetVenueShareRequest = z.infer<typeof setVenueShareRequestSchema>;

/* ─── Partner access context ─────────────────────────────────────────────── */

export const partnerTypeSchema = z.enum(['venue', 'host', 'promoter']);

export const partnerPermissionSchema = z.enum([
  'VIEW_FINANCIALS',
  'MANAGE_STAFF',
  'MANAGE_EVENTS',
  'EDIT_EVENT_RULES',
  'MANAGE_TABLES',
  'VIEW_GUESTLIST',
  'SCAN_ENTRY',
  'LOG_INCIDENTS',
  'VIEW_ANALYTICS',
  'MANAGE_SETTINGS',
  'MANAGE_PROMOTERS',
  'MANAGE_PAYOUTS',
  'MANAGE_PARTNERSHIPS',
  'MANAGE_PAGE_CONTENT',
  'VIEW_REAL_TIME_SCANS',
  'MANAGE_GUEST_OPS',
  'CHARGE_COVER_WALLETS',
  'EXPORT_GUESTS',
]);

/**
 * What a member may see and do, computed by the backend. The dashboard renders
 * from this; it must never derive permissions locally (v1's own rule, kept).
 * `tabVisibility: null` means "no restriction — show every tab".
 */
export const partnerAccessDtoSchema = z.object({
  organizationId: opaqueIdSchema,
  userId: opaqueIdSchema,
  partnerType: partnerTypeSchema,
  role: z.string().min(1),
  permissions: z.array(partnerPermissionSchema),
  tabVisibility: z.record(z.string(), z.boolean()).nullable(),
});
export type PartnerAccessDto = z.infer<typeof partnerAccessDtoSchema>;

/* ─── Partner analytics ──────────────────────────────────────────────────── */

export const topEventDtoSchema = z.object({
  eventId: opaqueIdSchema,
  title: z.string(),
  revenuePaise: z.number().int().nonnegative(),
  tickets: z.number().int().nonnegative(),
  date: z.iso.datetime(),
});

/**
 * Read model first, compute-on-request fallback: cached values when the
 * projection has run, otherwise a bounded scan of source aggregates. Nothing
 * here is an unbounded per-request collection reduce.
 */
export const organizationOverviewDtoSchema = z.object({
  organizationId: opaqueIdSchema,
  totalEvents: z.number().int().nonnegative(),
  publishedEvents: z.number().int().nonnegative(),
  totalRevenuePaise: z.number().int().nonnegative(),
  totalTicketsSold: z.number().int().nonnegative(),
  totalCheckIns: z.number().int().nonnegative(),
  topEvents: z.array(topEventDtoSchema),
  /** null until the organization has a finished event. */
  lastEventAt: z.iso.datetime().nullable(),
});
export type OrganizationOverviewDto = z.infer<typeof organizationOverviewDtoSchema>;

/** Ratios are 0..1, not percentages — the UI decides how to render them. */
const ratio = () => z.number().min(0).max(1);

export const eventAnalyticsDtoSchema = z.object({
  eventId: opaqueIdSchema,
  totalRevenuePaise: z.number().int().nonnegative(),
  ticketsSold: z.number().int().nonnegative(),
  totalCheckIns: z.number().int().nonnegative(),
  capacity: z.number().int().nonnegative(),
  views: z.number().int().nonnegative(),
  guestlistSignups: z.number().int().nonnegative(),
  avgTicketPricePaise: z.number().int().nonnegative(),
  occupancyRate: ratio(),
  sellThroughRate: ratio(),
  refundAmountPaise: z.number().int().nonnegative(),
  refundRate: ratio(),
  noShowRate: ratio(),
  repeatGuests: z.number().int().nonnegative(),
  conversionRate: ratio(),
});
export type EventAnalyticsDto = z.infer<typeof eventAnalyticsDtoSchema>;

/* ─── Promoter referral links ────────────────────────────────────────────── */

export const referralLinkDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  promoterId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  code: z.string().min(4).max(16),
  label: z.string().min(1).max(120),
  isActive: z.boolean(),
  /** Vanity counters. The authoritative attribution lives on the order. */
  clicks: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReferralLinkDto = z.infer<typeof referralLinkDtoSchema>;

export const createReferralLinkSchema = z
  .object({
    promoterId: opaqueIdSchema,
    /** Omit to have one generated from an unambiguous alphabet. */
    code: z
      .string()
      .min(4)
      .max(16)
      .regex(/^[A-Za-z0-9 -]+$/, 'A referral code may contain letters and digits only')
      .optional(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();
export type CreateReferralLinkRequest = z.infer<typeof createReferralLinkSchema>;

/* ─── Promoter Compensation Models ───────────────────────────────────────── */

export const promoterRateTypeSchema = z.enum(['percentage', 'fixed']);
export type PromoterRateType = z.infer<typeof promoterRateTypeSchema>;

export const promoterCompensationModelSchema = z.enum(['standard', 'custom', 'salary']);
export type PromoterCompensationModel = z.infer<typeof promoterCompensationModelSchema>;

export const promoterCompensationRateSchema = z.object({
  rateType: promoterRateTypeSchema,
  rateValue: z.number().nonnegative(),
});
export type PromoterCompensationRate = z.infer<typeof promoterCompensationRateSchema>;

export const promoterCompensationConfigSchema = z.object({
  model: promoterCompensationModelSchema,
  globalCommission: promoterCompensationRateSchema,
  tierCommissions: z.record(z.string(), promoterCompensationRateSchema).optional(),
  salaryAmount: z.number().nonnegative().optional(),
  salaryNotes: z.string().optional(),
});
export type PromoterCompensationConfig = z.infer<typeof promoterCompensationConfigSchema>;

/* ─── Promoter connections ───────────────────────────────────────────────── */

export const promoterConnectionStatusSchema = z.enum([
  'pending',
  'active',
  'rejected',
  'blocked',
  'revoked',
]);

export const promoterConnectionDtoSchema = z.object({
  id: opaqueIdSchema,
  promoterId: opaqueIdSchema,
  targetId: opaqueIdSchema,
  targetType: z.enum(['host', 'venue']),
  initiatedBy: z.enum(['promoter', 'target']),
  status: promoterConnectionStatusSchema,
  message: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Public-safe display enrichment (real backend names, never fabricated). */
  promoterName: z.string().min(1).max(200).nullish(),
  promoterSlug: z.string().min(1).max(60).nullish(),
  targetName: z.string().min(1).max(200).nullish(),
  targetSlug: z.string().min(1).max(60).nullish(),
  targetCity: z.string().max(100).nullish(),
});
export type PromoterConnectionDto = z.infer<typeof promoterConnectionDtoSchema>;

/**
 * `initiatedBy` says which side the CALLER is; the caller's own organization
 * is taken from the session, so only the counterparty is named here.
 */
export const requestConnectionSchema = z
  .object({
    counterpartyId: opaqueIdSchema,
    targetType: z.enum(['host', 'venue']),
    initiatedBy: z.enum(['promoter', 'target']),
    message: z.string().max(1000).optional(),
  })
  .strict();
export type RequestConnectionRequest = z.infer<typeof requestConnectionSchema>;

/* ─── Partner discovery (real backend browse, no dummy profiles) ─────────── */

export const discoverPartnerKindSchema = z.enum(['host', 'venue', 'promoter']);
export type DiscoverPartnerKind = z.infer<typeof discoverPartnerKindSchema>;

/**
 * A real discoverable partner. Every display field comes from stored
 * organizations/venues/public events — the API never fabricates names.
 * `requestTarget` carries exactly what the connection-request endpoints need:
 * - host/venue partnership → `{ venueId }` (+ host org is the caller or
 *   `hostOrganizationId` for venue-initiated invites)
 * - promoter connection → `{ counterpartyId, targetType }`
 */
export const discoverPartnerDtoSchema = z.object({
  id: opaqueIdSchema,
  kind: discoverPartnerKindSchema,
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(60),
  city: z.string().max(100).nullable(),
  verified: z.boolean(),
  /** Organization id behind a host/promoter candidate; venue's owning org for venues. */
  organizationId: opaqueIdSchema.nullable(),
  /** Venue id behind a venue candidate (the partnership request key). */
  venueId: opaqueIdSchema.nullable(),
});
export type DiscoverPartnerDto = z.infer<typeof discoverPartnerDtoSchema>;

export const discoverPartnersQuerySchema = z.object({
  type: discoverPartnerKindSchema.optional(),
  q: z.string().min(1).max(200).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type DiscoverPartnersQuery = z.infer<typeof discoverPartnersQuerySchema>;
