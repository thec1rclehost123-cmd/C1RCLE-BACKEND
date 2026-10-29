import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

const eventCoverPolicyTermsBaseSchema = z
  .object({
    eventId: opaqueIdSchema,
    venueOrganizationId: opaqueIdSchema,
    merchantOrganizationId: opaqueIdSchema,
    coverAmountPaise: z.number().int().positive().max(100_000_000),
    minimumSpendPaise: z.number().int().positive().max(100_000_000),
    redemptionOpensAt: z.iso.datetime(),
    redemptionClosesAt: z.iso.datetime(),
    eligibleCategories: z.array(z.string().trim().min(1).max(80)).max(100),
    excludedCategories: z.array(z.string().trim().min(1).max(80)).max(100),
    alcoholRule: z.enum(['exclude_alcohol', 'age_restricted', 'no_alcohol']),
    partialRedemption: z.boolean(),
    splitTender: z.boolean(),
    refundPolicy: z.enum(['unused_full_before_redemption', 'saved_policy_review']),
    transferUnusedOnly: z.literal(true),
    commissionBasis: z.literal('net_admission_after_allocated_discount'),
    unusedBalancePolicy: z.literal('approved_minimum_spend_expiry'),
  })
  .strict();

function validateRedemptionWindow(
  terms: { redemptionOpensAt: string; redemptionClosesAt: string },
  context: z.RefinementCtx,
) {
  if (Date.parse(terms.redemptionClosesAt) <= Date.parse(terms.redemptionOpensAt)) {
    context.addIssue({
      code: 'custom',
      path: ['redemptionClosesAt'],
      message: 'Redemption must close after it opens.',
    });
  }
}

export const eventCoverPolicyTermsSchema =
  eventCoverPolicyTermsBaseSchema.superRefine(validateRedemptionWindow);
export type EventCoverPolicyTermsDto = z.infer<typeof eventCoverPolicyTermsSchema>;

export const proposeEventCoverPolicySchema = z
  .object({
    policyVersion: z.string().trim().min(1).max(80),
    terms: eventCoverPolicyTermsBaseSchema
      .omit({ eventId: true, venueOrganizationId: true, merchantOrganizationId: true })
      .superRefine(validateRedemptionWindow),
  })
  .strict();

export const eventCoverPolicyProposalDtoSchema = z.object({
  id: opaqueIdSchema,
  hostOrganizationId: opaqueIdSchema,
  venueOrganizationId: opaqueIdSchema,
  proposedByUserId: opaqueIdSchema,
  policyVersion: z.string().min(1).max(80),
  terms: eventCoverPolicyTermsSchema,
  termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const eventCoverPolicyAcceptanceDtoSchema = z.object({
  id: opaqueIdSchema,
  proposalId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  hostOrganizationId: opaqueIdSchema,
  venueOrganizationId: opaqueIdSchema,
  acceptedByUserId: opaqueIdSchema,
  proposalVersion: z.string().min(1).max(80),
  termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const eventCoverPolicyHistoryDtoSchema = z.object({
  acceptanceEnabled: z.boolean(),
  items: z
    .array(
      z.object({
        proposal: eventCoverPolicyProposalDtoSchema,
        acceptance: eventCoverPolicyAcceptanceDtoSchema.nullable(),
      }),
    )
    .max(50),
});
export type EventCoverPolicyHistoryDto = z.infer<typeof eventCoverPolicyHistoryDtoSchema>;

export const eventCoverWalletItemDtoSchema = z.object({
  entitlementId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  status: z.enum(['pending_activation', 'active', 'frozen', 'closed', 'refunded']),
  issuedPaise: z.number().int().nonnegative(),
  remainingPaise: z.number().int().nonnegative(),
  reservedPaise: z.number().int().nonnegative(),
  redeemedPaise: z.number().int().nonnegative(),
  refundedPaise: z.number().int().nonnegative(),
  policyVersion: z.string().min(1),
  history: z.array(
    z.object({
      type: z.enum(['issuance', 'reserve', 'capture', 'void', 'refund', 'reversal']),
      amountPaise: z.number().int().positive(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export const eventCoverWalletResponseSchema = z.array(eventCoverWalletItemDtoSchema).max(100);
export type EventCoverWalletItemDto = z.infer<typeof eventCoverWalletItemDtoSchema>;

export const createEventCoverRedemptionChallengeSchema = z
  .object({
    entitlementId: opaqueIdSchema,
    amountPaise: z.number().int().positive(),
    grossSpendPaise: z.number().int().positive(),
    categories: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    containsAlcohol: z.boolean(),
    receiptReference: z.string().trim().min(1).max(120),
    terminalId: z.string().trim().min(1).max(128),
  })
  .strict();

export const eventCoverRedemptionChallengeDtoSchema = z
  .object({
    id: opaqueIdSchema,
    entitlementId: opaqueIdSchema,
    eventId: opaqueIdSchema,
    amountPaise: z.number().int().positive(),
    grossSpendPaise: z.number().int().positive(),
    categories: z.array(z.string()),
    status: z.enum(['pending', 'confirmed', 'consumed', 'expired']),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type EventCoverRedemptionChallengeDto = z.infer<
  typeof eventCoverRedemptionChallengeDtoSchema
>;
