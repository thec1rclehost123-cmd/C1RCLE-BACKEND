import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

/**
 * ─── Phase 7 admin analytics desk DTOs ───────────────────────────────────────
 * Platform-wide revenue/ticket/event summary, bounded-scan (see
 * `AdminOperationsService.getAnalyticsSummary`'s doc comment). `scannedOrders`/
 * `scannedEvents` report the real scan size back to the caller rather than
 * silently claiming full-collection exhaustiveness.
 */
export const adminAnalyticsTopOrgDtoSchema = z.object({
  organizationId: opaqueIdSchema,
  name: z.string(),
  revenuePaise: z.number().int(),
});
export type AdminAnalyticsTopOrgDto = z.infer<typeof adminAnalyticsTopOrgDtoSchema>;

export const adminAnalyticsSummaryDtoSchema = z.object({
  totalRevenuePaise: z.number().int(),
  ticketsSold: z.number().int().nonnegative(),
  activeEventsCount: z.number().int().nonnegative(),
  topOrganizations: z.array(adminAnalyticsTopOrgDtoSchema),
  scannedOrders: z.number().int().nonnegative(),
  scannedEvents: z.number().int().nonnegative(),
});
export type AdminAnalyticsSummaryDto = z.infer<typeof adminAnalyticsSummaryDtoSchema>;
