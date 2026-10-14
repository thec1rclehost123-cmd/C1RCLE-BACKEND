import { z } from 'zod';

import { opaqueIdSchema } from './shared.js';

/**
 * ─── Admin finance controls: tax rules and payment reconciliation ────────────
 * Mirrors `domain/models/tax-rule.ts` and `domain/models/provider-payment.ts`.
 */

export const taxRuleKindSchema = z.enum([
  'ticket_gst',
  'convenience_fee_gst',
  'tds_194o',
  'gst_tcs_s52',
]);
export type TaxRuleKind = z.infer<typeof taxRuleKindSchema>;

export const taxBasisSchema = z.enum([
  'ticket_price',
  'convenience_fee',
  'gross_sales',
  'net_payable_to_seller',
]);
export type TaxBasis = z.infer<typeof taxBasisSchema>;

export const taxRuleStatusSchema = z.enum(['draft', 'enabled', 'retired']);
export type TaxRuleStatus = z.infer<typeof taxRuleStatusSchema>;

const indiaDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const taxRuleDtoSchema = z.object({
  id: opaqueIdSchema,
  kind: taxRuleKindSchema,
  /** Basis points: 1800 = 18%. */
  rateBps: z.number().int().min(0).max(10_000),
  basis: taxBasisSchema,
  effectiveFrom: indiaDateSchema,
  effectiveTo: indiaDateSchema.nullable(),
  status: taxRuleStatusSchema,
  /** Reference to the written advice that supports an enabled rule. */
  approvalRef: z.string().nullable(),
  notes: z.string(),
  createdBy: opaqueIdSchema,
  enabledBy: opaqueIdSchema.nullable(),
  enabledAt: z.iso.datetime().nullable(),
  retiredBy: opaqueIdSchema.nullable(),
  retiredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaxRuleDto = z.infer<typeof taxRuleDtoSchema>;

export const taxRuleListResponseSchema = z.object({ items: z.array(taxRuleDtoSchema) });
export type TaxRuleListResponse = z.infer<typeof taxRuleListResponseSchema>;

export const createTaxRuleSchema = z
  .object({
    kind: taxRuleKindSchema,
    rateBps: z.number().int().min(0).max(10_000),
    basis: taxBasisSchema,
    effectiveFrom: indiaDateSchema,
    effectiveTo: indiaDateSchema.nullable().optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateTaxRuleInput = z.infer<typeof createTaxRuleSchema>;

export const enableTaxRuleSchema = z
  .object({
    /** The written CA / legal advice this rule rests on (letter reference and date). */
    approvalRef: z.string().trim().min(5).max(500),
  })
  .strict();
export type EnableTaxRuleInput = z.infer<typeof enableTaxRuleSchema>;

export const retireTaxRuleSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type RetireTaxRuleInput = z.infer<typeof retireTaxRuleSchema>;

export const reconciliationFindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('provider_record_missing') }),
  z.object({
    kind: z.literal('amount_mismatch'),
    ourPaise: z.number().int(),
    providerPaise: z.number().int(),
  }),
  z.object({ kind: z.literal('currency_mismatch'), ours: z.string(), provider: z.string() }),
  z.object({
    kind: z.literal('refund_mismatch'),
    ourPaise: z.number().int(),
    providerPaise: z.number().int(),
  }),
  z.object({ kind: z.literal('open_dispute') }),
]);
export type ReconciliationFindingDto = z.infer<typeof reconciliationFindingSchema>;

export const reconciliationResultSchema = z.object({
  orderId: opaqueIdSchema,
  paymentId: z.string().nullable(),
  /** True only when there is nothing to look at. */
  reconciled: z.boolean(),
  findings: z.array(reconciliationFindingSchema),
  /** The provider's net for the payment, in paise; null without a provider record. */
  providerNetPaise: z.number().int().nullable(),
});
export type ReconciliationResultDto = z.infer<typeof reconciliationResultSchema>;
