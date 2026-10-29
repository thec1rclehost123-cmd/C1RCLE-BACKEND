import { z } from 'zod';

import { opaqueIdSchema, paginatedSchema } from './shared.js';

export const ticketAccessCodeStatusSchema = z.enum(['active', 'revoked']);

/** Public/admin view deliberately excludes the verifier and creator identity. */
export const ticketAccessCodeDtoSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(['code', 'invitation']),
  scope: z.enum(['tiers', 'event']).default('tiers'),
  eventId: opaqueIdSchema,
  tierIds: z.array(opaqueIdSchema).max(50),
  status: ticketAccessCodeStatusSchema,
  startsAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  maxRedemptions: z.number().int().min(1).max(10_000),
  redemptionCount: z.number().int().min(0),
  revokedAt: z.iso.datetime().nullable(),
  revokedReason: z.string().max(500).nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketAccessCodeDto = z.infer<typeof ticketAccessCodeDtoSchema>;

export const createTicketAccessCodeSchema = z
  .object({
    scope: z.enum(['tiers', 'event']).default('tiers'),
    tierIds: z.array(opaqueIdSchema).max(50).default([]),
    startsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    maxRedemptions: z.number().int().min(1).max(10_000),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scope === 'tiers' && input.tierIds.length === 0) {
      context.addIssue({ code: 'custom', path: ['tierIds'], message: 'Select at least one tier.' });
    }
  });

export const createTicketAccessInvitationSchema = z
  .object({
    scope: z.enum(['tiers', 'event']).default('tiers'),
    tierIds: z.array(opaqueIdSchema).max(50).default([]),
    recipientEmail: z
      .email()
      .trim()
      .max(254)
      .transform((email) => email.toLowerCase()),
    startsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scope === 'tiers' && input.tierIds.length === 0) {
      context.addIssue({ code: 'custom', path: ['tierIds'], message: 'Select at least one tier.' });
    }
  });

export const ticketAccessCodeCreateResponseSchema = z.object({
  /** Generated high-entropy secret; returned once and never recoverable. */
  code: z.string().min(20).max(128),
  accessCode: ticketAccessCodeDtoSchema,
});

export const ticketAccessCodeListResponseSchema = paginatedSchema(ticketAccessCodeDtoSchema);

export const redeemTicketAccessCodeSchema = z
  .object({ code: z.string().trim().min(20).max(128) })
  .strict();

export const ticketAccessGrantDtoSchema = z.object({
  id: opaqueIdSchema,
  eventId: opaqueIdSchema,
  scope: z.enum(['tiers', 'event']).default('tiers'),
  tierIds: z.array(opaqueIdSchema).max(50),
  expiresAt: z.iso.datetime(),
});
export type TicketAccessGrantDto = z.infer<typeof ticketAccessGrantDtoSchema>;
