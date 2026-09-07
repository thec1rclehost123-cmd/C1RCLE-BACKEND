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
  status: z.enum(['requested', 'processing', 'paid', 'failed']),
  failureReason: z.string().nullable(),
  processedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PayoutResponse = z.infer<typeof payoutResponseSchema>;

export const payoutListResponseSchema = paginatedSchema(payoutResponseSchema);

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
