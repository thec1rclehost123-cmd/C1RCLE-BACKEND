import { z } from 'zod';

export const marketingAudienceQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    eventId: z.string().min(1).max(128).optional(),
    tierId: z.string().min(1).max(128).optional(),
    offset: z.coerce.number().int().min(0).max(5000).default(0),
  })
  .strict();
export const marketingAudienceSchema = z
  .object({
    rows: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          eventId: z.string(),
          eventName: z.string(),
          tickets: z.number().int().positive(),
          totalSpendPaise: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    events: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    tiers: z.array(z.object({ id: z.string(), eventId: z.string(), name: z.string() }).strict()),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nullable(),
  })
  .strict();
export type MarketingAudience = z.infer<typeof marketingAudienceSchema>;
export type MarketingAudienceQuery = z.infer<typeof marketingAudienceQuerySchema>;

export const ticketTierPerformanceSchema = z
  .object({
    channels: z
      .object({
        promoter: z.number().int().nonnegative(),
        unattributed: z.number().int().nonnegative(),
      })
      .strict(),
    purchaseDays: z.array(z.number().int().nonnegative()).length(7),
    rows: z.array(
      z
        .object({
          eventId: z.string(),
          eventName: z.string(),
          tierId: z.string(),
          name: z.string(),
          tickets: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
