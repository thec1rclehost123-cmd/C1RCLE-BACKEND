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

export const adminTicketTransferDtoSchema = z.object({
  id: opaqueIdSchema,
  entitlementId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  recipientBinding: z.enum(['account', 'verified_email']),
  status: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired', 'frozen']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type AdminTicketTransferDto = z.infer<typeof adminTicketTransferDtoSchema>;

export const adminTicketTransfersResponseSchema = z.array(adminTicketTransferDtoSchema);
export type AdminTicketTransfersResponse = z.infer<typeof adminTicketTransfersResponseSchema>;

/** Purchaser requests to review material event changes; listing never implies approval. */
export const adminTicketEventChangeRefundReviewsSchema = z.array(
  z.object({
    eventVersion: z.number().int().positive(),
    response: z.literal('refund_requested'),
    respondedAt: z.iso.datetime(),
  }),
);
export type AdminTicketEventChangeRefundReviews = z.infer<
  typeof adminTicketEventChangeRefundReviewsSchema
>;

/** Read-only cover account facts and ledger comparison for Admin support. */
export const adminTicketCoverReconciliationSchema = z.object({
  currency: z.literal('INR'),
  status: z.enum(['pending_activation', 'active', 'frozen', 'closed', 'refunded']),
  policyVersion: z.string().min(1),
  issuedPaise: z.number().int().nonnegative(),
  remainingPaise: z.number().int().nonnegative(),
  reservedPaise: z.number().int().nonnegative(),
  redeemedPaise: z.number().int().nonnegative(),
  refundedPaise: z.number().int().nonnegative(),
  /** Captured redemption remains held; it is not a payable or payout calculation. */
  settlementStatus: z.literal('held'),
  settlementEligible: z.literal(false),
  heldRedemptionPaise: z.number().int().nonnegative().nullable(),
  reversalEnabled: z.boolean(),
  reversibleCaptureEntryIds: z.array(z.string().min(1)),
  entryCount: z.number().int().nonnegative(),
  balanced: z.boolean(),
  expectedRemainingPaise: z.number().int().nonnegative(),
  expectedReservedPaise: z.number().int().nonnegative(),
  expectedRedeemedPaise: z.number().int().nonnegative(),
  expectedRefundedPaise: z.number().int().nonnegative(),
  actualRefundedPaise: z.number().int().nonnegative(),
  discrepancies: z.array(z.string()),
});
export type AdminTicketCoverReconciliation = z.infer<typeof adminTicketCoverReconciliationSchema>;

/** Bounded event-wide ledger comparison; held redemption is never settlement eligibility. */
export const adminEventCoverReconciliationSchema = z.object({
  eventId: opaqueIdSchema,
  currency: z.literal('INR'),
  accountCount: z.number().int().nonnegative(),
  scannedAccountCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  balancedAccountCount: z.number().int().nonnegative(),
  unbalancedAccountCount: z.number().int().nonnegative(),
  issuedPaise: z.number().int().nonnegative(),
  remainingPaise: z.number().int().nonnegative(),
  reservedPaise: z.number().int().nonnegative(),
  redeemedPaise: z.number().int().nonnegative(),
  refundedPaise: z.number().int().nonnegative(),
  heldRedemptionPaise: z.number().int().nonnegative().nullable(),
  settlementStatus: z.literal('held'),
  settlementEligible: z.literal(false),
  balanced: z.boolean(),
  discrepancies: z.array(z.string()),
});
export type AdminEventCoverReconciliation = z.infer<typeof adminEventCoverReconciliationSchema>;

/** Outcome of one audited correction; the balance remains held from settlement. */
export const adminEventCoverReversalResponseSchema = z.object({
  accountId: z.string().min(1),
  entitlementId: z.string().min(1),
  reversalEntryId: z.string().min(1),
  reversedEntryId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  remainingPaise: z.number().int().nonnegative(),
  redeemedPaise: z.number().int().nonnegative(),
  settlementStatus: z.literal('held'),
  settlementEligible: z.literal(false),
  replayed: z.boolean(),
});
export type AdminEventCoverReversalResponse = z.infer<typeof adminEventCoverReversalResponseSchema>;
