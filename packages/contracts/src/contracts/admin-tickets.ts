import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Phase 7 admin tickets desk DTOs ─────────────────────────────────────────
 * Platform-wide entitlement (ticket) ledger for the `/tickets` admin
 * read-only dashboard. Distinct from a support-ticket desk — this is the
 * thing a guest presents at the door (`domain/models/entitlement.ts`).
 */
export const adminTicketStatusSchema = z.enum(['valid', 'redeemed', 'void']);
export type AdminTicketStatus = z.infer<typeof adminTicketStatusSchema>;

export const adminTicketDtoSchema = z.object({
  id: opaqueIdSchema,
  orderId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  tierName: z.string(),
  userId: opaqueIdSchema.nullable(),
  holderName: z.string(),
  status: adminTicketStatusSchema,
  scanCountAllowed: z.number().int().positive(),
  scanCount: z.number().int().nonnegative(),
  lastScannedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminTicketDto = z.infer<typeof adminTicketDtoSchema>;

export const adminTicketListResponseSchema = paginatedSchema(adminTicketDtoSchema);
export type AdminTicketListResponse = z.infer<typeof adminTicketListResponseSchema>;
