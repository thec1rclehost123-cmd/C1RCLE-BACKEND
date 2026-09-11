import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema, idempotencyKeySchema } from './shared.js';

/**
 * ─── Phase 6: Finance / Ledger / Payouts Contracts ───────────────────────────
 */

// Ledger
export const ledgerEntryDtoSchema = z.object({
  id: opaqueIdSchema,
  orderId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  entryType: z.enum([
    'ticket_revenue',
    'platform_fee',
    'venue_share',
    'host_payout',
    'promoter_commission',
    'refund',
  ]),
  amountPaise: z.number().int().nonnegative(),
  status: z.enum(['pending', 'settled', 'paid_out']),
  createdAt: z.iso.datetime(),
});
export type LedgerEntryDto = z.infer<typeof ledgerEntryDtoSchema>;

export const ledgerEntryListResponseSchema = paginatedSchema(ledgerEntryDtoSchema);

export const balanceSummaryResponseSchema = z.object({
  availablePaise: z.number().int(),
  pendingPaise: z.number().int().nonnegative(),
  lifetimePaise: z.number().int().nonnegative(),
});
export type BalanceSummaryResponse = z.infer<typeof balanceSummaryResponseSchema>;

// Payout
export const payoutRequestSchema = z
  .object({
    amountPaise: z.number().int().positive(),
    bankAccountId: opaqueIdSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type PayoutRequest = z.infer<typeof payoutRequestSchema>;

export const payoutResponseSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  bankAccountId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  status: z.enum(['requested', 'processing', 'paid', 'failed', 'frozen']),
  failureReason: z.string().nullable(),
  processedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PayoutResponse = z.infer<typeof payoutResponseSchema>;

export const payoutListResponseSchema = paginatedSchema(payoutResponseSchema);

// Admin payout controls (Phase 6 admin) — freeze/release (TIER3, dual
// control, executed from an approved proposal) + batch run (TIER2).
export const adminPayoutStatusSchema = z.enum([
  'requested',
  'processing',
  'paid',
  'failed',
  'frozen',
]);
export type AdminPayoutStatus = z.infer<typeof adminPayoutStatusSchema>;

export const runPayoutBatchSchema = z
  .object({
    payoutIds: z.array(opaqueIdSchema).min(1).max(200),
  })
  .strict();
export type RunPayoutBatchInput = z.infer<typeof runPayoutBatchSchema>;

export const payoutBatchResultSchema = z.object({
  processed: z.array(payoutResponseSchema),
  skipped: z.array(z.object({ id: opaqueIdSchema, reason: z.string() })),
});
export type PayoutBatchResult = z.infer<typeof payoutBatchResultSchema>;

// Bank Account
export const bankAccountRequestSchema = z
  .object({
    bankName: z.string().min(1).max(120),
    accountHolder: z.string().min(1).max(120),
    accountNumber: z.string().min(4).max(34),
    ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code format'),
  })
  .strict();
export type BankAccountRequest = z.infer<typeof bankAccountRequestSchema>;

/** Never carries the plaintext or encrypted account number — masked only. */
export const bankAccountResponseSchema = z.object({
  id: opaqueIdSchema,
  bankName: z.string(),
  accountHolder: z.string(),
  maskedAccountNumber: z.string(),
  ifscCode: z.string(),
  isDefault: z.boolean(),
  verified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type BankAccountResponse = z.infer<typeof bankAccountResponseSchema>;

export const bankAccountListResponseSchema = z.object({
  items: z.array(bankAccountResponseSchema),
});

// Dispute
export const raiseDisputeRequestSchema = z
  .object({
    orderId: opaqueIdSchema,
    ledgerEntryId: opaqueIdSchema.optional(),
    reason: z.string().min(1).max(2000),
    amountPaise: z.number().int().positive(),
  })
  .strict();
export type RaiseDisputeRequest = z.infer<typeof raiseDisputeRequestSchema>;

export const resolveDisputeRequestSchema = z
  .object({
    resolutionNote: z.string().min(1).max(2000),
  })
  .strict();
export type ResolveDisputeRequest = z.infer<typeof resolveDisputeRequestSchema>;

export const disputeResponseSchema = z.object({
  id: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  orderId: opaqueIdSchema,
  ledgerEntryId: opaqueIdSchema.nullable(),
  raisedBy: opaqueIdSchema,
  reason: z.string(),
  amountPaise: z.number().int().positive(),
  status: z.enum(['open', 'under_review', 'resolved']),
  resolutionNote: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type DisputeResponse = z.infer<typeof disputeResponseSchema>;

export const disputeListResponseSchema = paginatedSchema(disputeResponseSchema);

// Admin refund (Phase 6 admin) — amount-tiered approval over an order's
// payment. See `packages/core/src/domain/models/refund-request.ts`.
export const requestRefundSchema = z
  .object({
    orderId: opaqueIdSchema,
    amountPaise: z.number().int().positive(),
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type RequestRefundInput = z.infer<typeof requestRefundSchema>;

export const rejectRefundRequestSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type RejectRefundRequestInput = z.infer<typeof rejectRefundRequestSchema>;

export const adminRefundApprovalDtoSchema = z.object({
  adminId: opaqueIdSchema,
  approvedAt: z.iso.datetime(),
});

export const adminRefundRequestStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'settled',
  'failed',
]);
export type AdminRefundRequestStatus = z.infer<typeof adminRefundRequestStatusSchema>;

export const adminRefundRequestDtoSchema = z.object({
  id: opaqueIdSchema,
  orderId: opaqueIdSchema,
  organizationId: opaqueIdSchema,
  amountPaise: z.number().int().positive(),
  requestedBy: opaqueIdSchema,
  reason: z.string(),
  approversRequired: z.number().int().nonnegative(),
  approvals: z.array(adminRefundApprovalDtoSchema),
  status: adminRefundRequestStatusSchema,
  rejectedBy: opaqueIdSchema.nullable(),
  rejectionReason: z.string().nullable(),
  providerRefundId: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AdminRefundRequestDto = z.infer<typeof adminRefundRequestDtoSchema>;

export const adminRefundRequestListResponseSchema = paginatedSchema(adminRefundRequestDtoSchema);

// Leaderboard
export const leaderboardPeriodTypeSchema = z.enum(['all_time', 'month', 'week']);
export type LeaderboardPeriodType = z.infer<typeof leaderboardPeriodTypeSchema>;

export const leaderboardQuerySchema = z.object({
  periodType: leaderboardPeriodTypeSchema.default('all_time'),
  /** Omit for the current period ('all' for all_time, else the server's current month/week). */
  periodValue: z.string().max(20).optional(),
  /** Omit or 'global' for the cross-city ranking. */
  city: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const leaderboardStatResponseSchema = z.object({
  promoterId: opaqueIdSchema,
  periodType: leaderboardPeriodTypeSchema,
  periodValue: z.string(),
  city: z.string(),
  totalCommissionEarnedPaise: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});
export type LeaderboardStatResponse = z.infer<typeof leaderboardStatResponseSchema>;

export const leaderboardTopResponseSchema = z.object({
  items: z.array(leaderboardStatResponseSchema),
});
