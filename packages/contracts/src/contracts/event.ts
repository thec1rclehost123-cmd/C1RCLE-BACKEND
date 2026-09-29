import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

/**
 * ─── Event + Catalog Contracts ────────────────────────────────────────────────
 */

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

export const compensationModelSchema = z.enum(['standard', 'custom', 'salary']);
export const salaryPeriodSchema = z.enum(['per_event', 'per_day', 'per_month']);
export const eventCompensationSchema = z.object({
  model: compensationModelSchema,
  globalRatePercent: z.number().int().min(0).max(100).nullable(),
  tierRates: z.record(z.string(), z.number().int().min(0).max(100)),
  salaryAmountPaise: z.number().int().positive().nullable(),
  salaryPeriod: salaryPeriodSchema.nullable(),
  salaryNotes: z.string().max(2000).nullable(),
});
export type EventCompensation = z.infer<typeof eventCompensationSchema>;

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
  compensation: eventCompensationSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EventDto = z.infer<typeof eventDtoSchema>;

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
  compensation: eventCompensationSchema.nullable().optional(),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const posterContentTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp']);
export type PosterContentType = z.infer<typeof posterContentTypeSchema>;

/**
 * Ask for a pre-signed upload URL for an event poster. The partner `PUT`s the
 * file to the returned `uploadUrl` with the returned `headers`, then sends the
 * returned `publicUrl` as the event's `imageUrl` on create. Not
 * idempotency-keyed: minting a fresh URL is safe to repeat, and every mint
 * yields a fresh object key so re-uploads never clobber an existing poster.
 */
export const posterUploadUrlRequestSchema = z
  .object({
    contentType: posterContentTypeSchema,
  })
  .strict();
export type PosterUploadUrlRequest = z.infer<typeof posterUploadUrlRequestSchema>;

export const posterUploadUrlDtoSchema = z
  .object({
    uploadUrl: z.string().min(1),
    method: z.literal('PUT'),
    /** Headers the client must send on the PUT, verbatim. */
    headers: z.record(z.string(), z.string()),
    storagePath: z.string().min(1).max(500),
    /**
     * Long-lived public read URL — this is what gets stored as the event's
     * `imageUrl` so guests can render the poster.
     */
    publicUrl: z.url(),
    /** Epoch ms — the upload URL is unusable after this. */
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type PosterUploadUrlDto = z.infer<typeof posterUploadUrlDtoSchema>;

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
    compensation: eventCompensationSchema.nullable().optional(),
  })
  .strict();
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const cancelEventSchema = z
  .object({
    reason: z.string().min(1).max(1000),
  })
  .strict();
export type CancelEventInput = z.infer<typeof cancelEventSchema>;

/* ─── Event catalog (ticket tiers / promos / tables / promoter assignments) ─── */

export const ticketTierStatusSchema = z.enum(['active', 'paused', 'sold_out']);
export const ticketAccessTypeSchema = z.enum(['ENTRY', 'VIP', 'VVIP', 'TABLE', 'PACKAGE', 'RSVP']);
export const ticketAudienceTypeSchema = z.enum(['GENERAL', 'MALE', 'FEMALE', 'COUPLE', 'GROUP']);
export const ticketPricingPhaseSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  priceInPaise: z.number().int().nonnegative(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  quantity: z.number().int().nonnegative().nullable(),
});

export const ticketTierDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  entryType: z.string().min(1).max(40),
  currency: z.string().length(3),
  /** Money is always integer paise on the wire. */
  priceInPaise: z.number().int().nonnegative(),
  quantity: z.number().int().nonnegative(),
  status: ticketTierStatusSchema,
  salesStartAt: z.iso.datetime().nullable(),
  salesEndAt: z.iso.datetime().nullable(),
  maxPerOrder: z.number().int().positive().nullable(),
  accessType: ticketAccessTypeSchema.optional(),
  audienceType: ticketAudienceTypeSchema.optional(),
  guestCount: z.number().int().positive().optional(),
  pricingPhases: z.array(ticketPricingPhaseSchema).max(20).optional(),
  doorPriceInPaise: z.number().int().nonnegative().nullable().optional(),
  benefits: z.array(z.string().min(1).max(200)).max(20).optional(),
  minAge: z.number().int().min(0).max(100).nullable().optional(),
  maxAge: z.number().int().min(0).max(100).nullable().optional(),
  minPerOrder: z.number().int().positive().nullable().optional(),
  maxPerUser: z.number().int().positive().nullable().optional(),
  tableConfig: z
    .object({
      capacity: z.number().int().positive(),
      minimumSpendPaise: z.number().int().nonnegative(),
      redeemableAmountPaise: z.number().int().nonnegative(),
      tableCount: z.number().int().positive(),
    })
    .nullable()
    .optional(),
  commissionEligible: z.boolean().optional(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketTierDto = z.infer<typeof ticketTierDtoSchema>;

export const createTicketTierSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    entryType: z.string().min(1).max(40).optional(),
    currency: z.string().length(3).optional(),
    priceInPaise: z.number().int().nonnegative(),
    quantity: z.number().int().nonnegative(),
    salesStartAt: z.iso.datetime().nullable().optional(),
    salesEndAt: z.iso.datetime().nullable().optional(),
    maxPerOrder: z.number().int().positive().nullable().optional(),
    accessType: ticketAccessTypeSchema.optional(),
    audienceType: ticketAudienceTypeSchema.optional(),
    guestCount: z.number().int().positive().optional(),
    pricingPhases: z.array(ticketPricingPhaseSchema).max(20).optional(),
    doorPriceInPaise: z.number().int().nonnegative().nullable().optional(),
    benefits: z.array(z.string().min(1).max(200)).max(20).optional(),
    minAge: z.number().int().min(0).max(100).nullable().optional(),
    maxAge: z.number().int().min(0).max(100).nullable().optional(),
    minPerOrder: z.number().int().positive().nullable().optional(),
    maxPerUser: z.number().int().positive().nullable().optional(),
    tableConfig: z
      .object({
        capacity: z.number().int().positive(),
        minimumSpendPaise: z.number().int().nonnegative(),
        redeemableAmountPaise: z.number().int().nonnegative(),
        tableCount: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    commissionEligible: z.boolean().optional(),
  })
  .strict();
export type CreateTicketTierRequest = z.infer<typeof createTicketTierSchema>;

export const promoTypeSchema = z.enum(['public', 'private', 'single_use', 'multi_use']);
export const promoDiscountTypeSchema = z.enum(['percent', 'fixed']);

export const promoCodeDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema.nullable(),
  organizationId: opaqueIdSchema,
  code: z.string().min(1).max(40),
  name: z.string().max(120),
  type: promoTypeSchema,
  discountType: promoDiscountTypeSchema,
  /** Percent 0–100 when `percent`; paise when `fixed`. */
  discountValue: z.number().int().nonnegative(),
  tierIds: z.array(opaqueIdSchema),
  maxRedemptions: z.number().int().positive().nullable(),
  maxPerUser: z.number().int().positive().nullable(),
  redemptionCount: z.number().int().nonnegative(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  isActive: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PromoCodeDto = z.infer<typeof promoCodeDtoSchema>;

export const createPromoCodeSchema = z
  .object({
    code: z.string().min(1).max(40),
    name: z.string().max(120).optional(),
    type: promoTypeSchema.optional(),
    discountType: promoDiscountTypeSchema,
    discountValue: z.number().int().nonnegative(),
    /** Empty/omitted = every tier, matching v1 semantics. */
    tierIds: z.array(opaqueIdSchema).max(100).optional(),
    maxRedemptions: z.number().int().positive().nullable().optional(),
    maxPerUser: z.number().int().positive().nullable().optional(),
    startsAt: z.iso.datetime().nullable().optional(),
    endsAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type CreatePromoCodeRequest = z.infer<typeof createPromoCodeSchema>;

export const tablePackageDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  name: z.string().min(1).max(120),
  capacity: z.number().int().positive(),
  pricePaise: z.number().int().nonnegative(),
  minSpendPaise: z.number().int().nonnegative().nullable(),
  isActive: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TablePackageDto = z.infer<typeof tablePackageDtoSchema>;

export const createTablePackageSchema = z
  .object({
    name: z.string().min(1).max(120),
    capacity: z.number().int().positive(),
    pricePaise: z.number().int().nonnegative(),
    minSpendPaise: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type CreateTablePackageRequest = z.infer<typeof createTablePackageSchema>;

export const commissionRateSchema = z.object({
  ratePercent: z.number().int().min(0).max(100),
  flatPaise: z.number().int().nonnegative(),
});

export const commissionTermsSchema = z.object({
  version: z.number().int().positive(),
  ratePercent: z.number().int().nonnegative(),
  flatPaise: z.number().int().nonnegative(),
  tierRates: z.record(z.string(), commissionRateSchema).optional(),
});

export const promoterAssignmentDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  promoterId: opaqueIdSchema,
  status: z.enum(['active', 'ended']),
  /** Frozen at assignment time — later term changes never rewrite history. */
  terms: commissionTermsSchema,
  endedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PromoterAssignmentDto = z.infer<typeof promoterAssignmentDtoSchema>;

export const assignPromoterSchema = z
  .object({
    promoterId: opaqueIdSchema,
    ratePercent: z.number().int().min(0).max(100).optional(),
    flatPaise: z.number().int().nonnegative().optional(),
    tierRates: z.record(z.string(), commissionRateSchema).optional(),
  })
  .strict();
export type AssignPromoterRequest = z.infer<typeof assignPromoterSchema>;

/* ─── Public ticket-tier reads (guest checkout) ──────────────────────────── */

/**
 * Slim sell-surface projection of a ticket tier for anonymous guests. No
 * internal bounds (`min/maxPerOrder`), no sales windows — just what checkout
 * needs: identity, display, effective price, and live availability. Legacy
 * tiers without `priceInPaise` price via `effectiveTierPricePaise` (domain).
 */
export const publicTicketTierDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  name: z.string(),
  description: z.string(),
  priceInPaise: z.number().int().nonnegative(),
  currency: z.string().length(3),
  availableQuantity: z.number().int().nonnegative(),
});
export type PublicTicketTierDto = z.infer<typeof publicTicketTierDtoSchema>;

/** `GET /public/events/:idOrSlug/tiers` — active tiers only, never paged. */
export const publicTicketTierListResponseSchema = z.object({
  items: z.array(publicTicketTierDtoSchema),
});
export type PublicTicketTierListResponse = z.infer<typeof publicTicketTierListResponseSchema>;
