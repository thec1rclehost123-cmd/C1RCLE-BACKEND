import { z } from 'zod';

import { checkoutQuoteResponseSchema } from './checkout.js';
import { opaqueIdSchema } from './shared.js';

export const waitlistEntryDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  tierId: opaqueIdSchema,
  sequence: z.number().int().positive(),
  status: z.enum(['waiting', 'offered', 'accepted', 'expired', 'cancelled']),
  offeredAt: z.iso.datetime().nullable(),
  offerExpiresAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type WaitlistEntryDto = z.infer<typeof waitlistEntryDtoSchema>;

export const waitlistQueueResponseSchema = z.object({
  items: z.array(waitlistEntryDtoSchema),
  pageInfo: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});
export type WaitlistQueueResponse = z.infer<typeof waitlistQueueResponseSchema>;

export const waitlistOfferResponseSchema = z.union([
  z.object({ offered: z.literal(false) }),
  z.object({
    entry: waitlistEntryDtoSchema,
    holdId: opaqueIdSchema,
    expiresAt: z.iso.datetime(),
    pricing: checkoutQuoteResponseSchema,
  }),
]);
export type WaitlistOfferResponse = z.infer<typeof waitlistOfferResponseSchema>;
