import { z } from 'zod';
import { opaqueIdSchema, paginatedSchema } from './shared.js';

/**
 * ─── Onboarding / KYC Contracts ──────────────────────────────────────────────
 */

export const onboardingStatusSchema = z.enum([
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
]);

export const onboardingPlanSchema = z.enum(['basic', 'silver', 'diamond']);

/**
 * Everything an applicant may set. Kept `.strict()` at the request boundary
 * and re-filtered in the domain — a client cannot smuggle `role` in either
 * place (v1's privilege-escalation guard, made total).
 */
export const onboardingProfileSchema = z
  .object({
    legalName: z.string().min(1).max(200),
    contactPerson: z.string().min(1).max(200),
    phone: z.string().min(6).max(20),
    city: z.string().min(1).max(120),
    area: z.string().max(120).optional(),
    website: z.string().max(300).optional(),
    capacity: z.number().int().nonnegative().nullable().optional(),
    instagram: z.string().max(120).optional(),
    bio: z.string().max(2000).optional(),
    businessType: z.string().max(120).optional(),
    registrationNumber: z.string().max(120).optional(),
    entityType: z.string().max(120).optional(),
  })
  .strict();
export type OnboardingProfileDto = z.infer<typeof onboardingProfileSchema>;

export const onboardingDocumentSchema = z.object({
  label: z.string().min(1).max(60),
  storagePath: z.string().min(1).max(500),
  uploadedAt: z.iso.datetime(),
});

export const onboardingRequestDtoSchema = z.object({
  id: opaqueIdSchema,
  userId: opaqueIdSchema,
  status: onboardingStatusSchema,
  requestedType: z.enum(['venue', 'host', 'promoter']),
  plan: onboardingPlanSchema,
  profile: onboardingProfileSchema,
  documents: z.array(onboardingDocumentSchema),
  /** Labels still missing before the applicant may submit. */
  missingDocuments: z.array(z.string()),
  submittedAt: z.iso.datetime().nullable(),
  reviewedBy: opaqueIdSchema.nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  reviewNote: z.string().nullable(),
  provisionedOrganizationId: opaqueIdSchema.nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OnboardingRequestDto = z.infer<typeof onboardingRequestDtoSchema>;

export const startOnboardingSchema = z
  .object({
    requestedType: z.enum(['venue', 'host', 'promoter']),
    plan: onboardingPlanSchema,
    profile: onboardingProfileSchema,
  })
  .strict();
export type StartOnboardingRequest = z.infer<typeof startOnboardingSchema>;

/**
 * Autosave. Loose on purpose at the type level (every field optional) but
 * still `.strict()`, so an unknown key is a 422 rather than something the
 * server silently ignores — the applicant should know their data was dropped.
 */
export const saveOnboardingProgressSchema = onboardingProfileSchema.partial().strict();
export type SaveOnboardingProgressRequest = z.infer<typeof saveOnboardingProgressSchema>;

export const addOnboardingDocumentSchema = z
  .object({
    label: z.string().min(1).max(60),
    storagePath: z.string().min(1).max(500),
  })
  .strict();
export type AddOnboardingDocumentRequest = z.infer<typeof addOnboardingDocumentSchema>;

export const verifyDocumentSchema = z
  .object({
    documentType: z.string().min(1).max(40),
    documentNumber: z.string().min(1).max(64),
    holderName: z.string().max(200).optional(),
  })
  .strict();
export type VerifyDocumentRequest = z.infer<typeof verifyDocumentSchema>;

/**
 * `passed` is never rendered as "verified" by the frontend unless `provider`
 * is a real one — the default provider reports `format-check` / `format_ok`
 * precisely so a green tick cannot be mistaken for an identity confirmation.
 */
export const verificationResultDtoSchema = z.object({
  passed: z.boolean(),
  provider: z.string().min(1),
  reason: z.string().nullable(),
  referenceId: z.string().nullable(),
});
export type VerificationResultDto = z.infer<typeof verificationResultDtoSchema>;

/** Admin decision on an application. A note is required to ask for changes. */
export const reviewOnboardingSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();
export type ReviewOnboardingRequest = z.infer<typeof reviewOnboardingSchema>;

/**
 * The organization an approval created. Deliberately not `organizationDtoSchema`:
 * that one carries `role`, meaning *the caller's* role in the org, and the
 * approving admin has none — they provisioned it for someone else.
 */
export const provisionedOrganizationDtoSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(60),
  ownerId: opaqueIdSchema,
  /** Whole-number percent, set from the applicant's plan. */
  platformFeePercent: z.number().int().nonnegative().max(100),
  status: z.enum(['active', 'suspended', 'archived']),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProvisionedOrganizationDto = z.infer<typeof provisionedOrganizationDtoSchema>;

export const approveOnboardingResultSchema = z.object({
  request: z.object({
    id: opaqueIdSchema,
    userId: opaqueIdSchema,
    status: z.enum([
      'draft',
      'submitted',
      'changes_requested',
      'approved',
      'rejected',
    ]),
    requestedType: z.enum(['venue', 'host', 'promoter']),
    plan: z.enum(['basic', 'silver', 'diamond']),
    profile: z.object({
      legalName: z.string().min(1).max(200),
      contactPerson: z.string().min(1).max(200),
      phone: z.string().min(6).max(20),
      city: z.string().min(1).max(120),
      area: z.string().max(120).optional(),
      website: z.string().max(300).optional(),
      capacity: z.number().int().nonnegative().nullable().optional(),
      instagram: z.string().max(120).optional(),
      bio: z.string().max(2000).optional(),
      businessType: z.string().max(120).optional(),
      registrationNumber: z.string().max(120).optional(),
      entityType: z.string().max(120).optional(),
    }),
    documents: z.array(z.object({
      label: z.string().min(1).max(60),
      storagePath: z.string().min(1).max(500),
      uploadedAt: z.iso.datetime(),
    })),
    missingDocuments: z.array(z.string()),
    submittedAt: z.iso.datetime().nullable(),
    reviewedBy: opaqueIdSchema.nullable(),
    reviewedAt: z.iso.datetime().nullable(),
    reviewNote: z.string().nullable(),
    provisionedOrganizationId: opaqueIdSchema.nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
  organization: z.object({
    id: opaqueIdSchema,
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(60),
    ownerId: opaqueIdSchema,
    platformFeePercent: z.number().int().nonnegative().max(100),
    status: z.enum(['active', 'suspended', 'archived']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
});
export type ApproveOnboardingResult = z.infer<typeof approveOnboardingResultSchema>;

/* ─── Tiered admin authority ─────────────────────────────────────────────── */

export const adminRoleSchema = z.enum(['super', 'admin', 'ops', 'finance', 'support']);

export const adminActionSchema = z.enum([
  'ONBOARDING_APPROVE',
  'VENUE_SUSPEND',
  'FINANCIAL_REFUND',
  'PAYOUT_BATCH_RUN',
  'ADMIN_PROVISION',
  'COMMISSION_ADJUST',
  'PAYOUT_FREEZE',
]);

export const proposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled']);

export const platformAdminDtoSchema = z.object({
  id: opaqueIdSchema,
  email: z.email(),
  role: adminRoleSchema,
  isActive: z.boolean(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PlatformAdminDto = z.infer<typeof platformAdminDtoSchema>;

export const proposedActionDtoSchema = z.object({
  id: opaqueIdSchema,
  action: adminActionSchema,
  proposedBy: opaqueIdSchema,
  reason: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: proposalStatusSchema,
  resolvedBy: opaqueIdSchema.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  resolutionReason: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProposedActionDto = z.infer<typeof proposedActionDtoSchema>;

export const proposeActionSchema = z
  .object({
    action: adminActionSchema,
    reason: z.string().min(1).max(2000),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProposeActionRequest = z.infer<typeof proposeActionSchema>;

export const resolveProposalSchema = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type ResolveProposalRequest = z.infer<typeof resolveProposalSchema>;

/** Before/after trail of a privileged action. */
export const adminAuditRecordDtoSchema = z.object({
  id: opaqueIdSchema,
  adminId: opaqueIdSchema,
  adminRole: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: opaqueIdSchema,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().nullable(),
  occurredAt: z.number().int().nonnegative(),
});
export type AdminAuditRecordDto = z.infer<typeof adminAuditRecordDtoSchema>;