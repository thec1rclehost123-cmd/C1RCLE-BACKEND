import { z } from 'zod';
import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

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

/* ─── Event catalog (ticket tiers / promos / tables / promoter assignments) ─── */

export const ticketTierStatusSchema = z.enum(['active', 'paused', 'sold_out']);

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
  minPerOrder: z.number().int().positive().nullable(),
  maxPerOrder: z.number().int().positive().nullable(),
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
    minPerOrder: z.number().int().positive().nullable().optional(),
    maxPerOrder: z.number().int().positive().nullable().optional(),
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

export const commissionTermsSchema = z.object({
  version: z.number().int().positive(),
  ratePercent: z.number().int().nonnegative(),
  flatPaise: z.number().int().nonnegative(),
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
  })
  .strict();
export type AssignPromoterRequest = z.infer<typeof assignPromoterSchema>;