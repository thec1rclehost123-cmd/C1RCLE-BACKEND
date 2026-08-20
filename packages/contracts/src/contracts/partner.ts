import { z } from 'zod';
import { opaqueIdSchema, paginatedSchema } from './shared.js';

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

export const partnershipDtoSchema = z.object({
  id: opaqueIdSchema,
  hostOrganizationId: opaqueIdSchema,
  venueOrganizationId: opaqueIdSchema,
  venueId: opaqueIdSchema,
  initiatedBy: z.enum(['host', 'venue']),
  status: partnershipStatusSchema,
  message: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PartnershipDto = z.infer<typeof partnershipDtoSchema>;

/**
 * `initiatedBy` says which side the CALLER is; the counterparty organization
 * is resolved server-side from the venue, never accepted from the client.
 */
export const requestPartnershipSchema = z
  .object({
    venueId: opaqueIdSchema,
    initiatedBy: z.enum(['host', 'venue']),
    message: z.string().max(1000).optional(),
  })
  .strict();
export type RequestPartnershipRequest = z.infer<typeof requestPartnershipSchema>;

export const resolvePartnershipSchema = z
  .object({ reason: z.string().min(1).max(500).optional() })
  .strict();
export type ResolvePartnershipRequest = z.infer<typeof resolvePartnershipSchema>;

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
 * Read-model only: every value is precomputed at write time. Nothing here is
 * scanned per request, which is why a dashboard can load it cheaply.
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