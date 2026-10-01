import { InvalidOperationError } from '../errors.js';
import { transitionStatus } from '../fsm.js';
import { bumpVersion, newVersionedEntity } from '../identity.js';

import type { EntityId, VersionedEntity } from '../identity.js';

/**
 * ─── Partner onboarding (Phase 2) ────────────────────────────────────────────
 *
 * Ported from v1's `onboarding_requests` flow:
 *   create-account → autosave progress → submit → admin approve/reject/
 *   request-changes.
 *
 * Two v1 rules are load-bearing and kept:
 *
 *  1. **`role` is stripped from any client-supplied progress payload.** v1
 *     called this out as a privilege-escalation guard: an applicant editing
 *     their own draft must not be able to set the role they will be granted.
 *     Only `onboardingRole` (a *request*, not a grant) is stored.
 *  2. **Approval provisions by partner type**, with the platform fee taken
 *     from the chosen plan — the applicant does not name their own fee.
 */

export type OnboardingStatus =
  'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';

const ONBOARDING_TRANSITIONS: Readonly<Record<OnboardingStatus, readonly OnboardingStatus[]>> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected', 'changes_requested'],
  // The applicant fixes what was asked for and resubmits.
  changes_requested: ['submitted'],
  // Approval is terminal here: what follows is a provisioned partner, not a
  // further state of this request.
  approved: [],
  rejected: [],
};

export type PartnerEntityType = 'venue' | 'host' | 'promoter';

/** v1 plan tiers, with the platform fee each carries. */
export type OnboardingPlan = 'basic' | 'silver' | 'diamond';

/**
 * Platform fee per plan, ported verbatim from v1's `approveOnboarding`.
 * Whole-number percent, applied to gross at settlement (Phase 6).
 */
export const PLAN_PLATFORM_FEE_PERCENT: Readonly<Record<OnboardingPlan, number>> = {
  basic: 15,
  silver: 12,
  diamond: 10,
};

export function platformFeePercentFor(plan: OnboardingPlan): number {
  return PLAN_PLATFORM_FEE_PERCENT[plan];
}

/**
 * Applicant-supplied details. Deliberately NOT a free-form bag: everything the
 * applicant may set is enumerated, so a future field cannot arrive carrying
 * authority with it.
 */
export interface OnboardingProfile {
  legalName: string;
  contactPerson: string;
  phone: string;
  city: string;
  area?: string;
  website?: string;
  capacity?: number | null;
  instagram?: string;
  bio?: string;
  businessType?: string;
  registrationNumber?: string;
  entityType?: string;
}

/**
 * A document's KYC review state — separate from `OnboardingStatus`. `pending`
 * means uploaded but not yet reviewed; `verified`/`rejected` are a KYC
 * reviewer's explicit call, never inferred from the application's own status.
 */
export type OnboardingDocumentStatus = 'pending' | 'verified' | 'rejected';

/** A KYC document the applicant has uploaded. */
export interface OnboardingDocument {
  /** v1 label vocabulary: id_front, id_back, selfie, cheque, registration_certificate… */
  label: string;
  storagePath: string;
  uploadedAt: string;
  status: OnboardingDocumentStatus;
  reviewedBy: EntityId | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
}

export interface OnboardingRequest extends VersionedEntity {
  id: EntityId;
  userId: EntityId;
  status: OnboardingStatus;
  /** What the applicant ASKED to be. Never itself a grant. */
  requestedType: PartnerEntityType;
  plan: OnboardingPlan;
  profile: OnboardingProfile;
  documents: OnboardingDocument[];
  submittedAt: string | null;
  /** Admin decision trail. */
  reviewedBy: EntityId | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Set once approved — the organization this request produced. */
  provisionedOrganizationId: EntityId | null;
}

export interface CreateOnboardingRequestInput {
  id: EntityId;
  userId: EntityId;
  requestedType: PartnerEntityType;
  plan: OnboardingPlan;
  profile: OnboardingProfile;
  now?: Date;
}

export function createOnboardingRequest(input: CreateOnboardingRequestInput): OnboardingRequest {
  return {
    id: input.id,
    userId: input.userId,
    status: 'draft',
    requestedType: input.requestedType,
    plan: input.plan,
    profile: input.profile,
    documents: [],
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    provisionedOrganizationId: null,
    ...newVersionedEntity(input.now ?? new Date()),
  };
}

/**
 * Autosave of a draft. Only a `draft` or `changes_requested` request is
 * editable — an applicant must not be able to alter what an admin is
 * currently reviewing.
 */
export function updateOnboardingProfile(
  request: OnboardingRequest,
  profile: Partial<OnboardingProfile>,
  now?: Date,
): OnboardingRequest {
  if (request.status !== 'draft' && request.status !== 'changes_requested') {
    throw new InvalidOperationError(`An onboarding request in ${request.status} cannot be edited`);
  }
  return {
    ...bumpVersion(request, now ?? new Date()),
    profile: { ...request.profile, ...profile },
  };
}

export function addOnboardingDocument(
  request: OnboardingRequest,
  document: Omit<
    OnboardingDocument,
    'uploadedAt' | 'status' | 'reviewedBy' | 'reviewedAt' | 'rejectionReason'
  >,
  now?: Date,
): OnboardingRequest {
  if (request.status === 'approved' || request.status === 'rejected') {
    throw new InvalidOperationError('A decided onboarding request cannot take new documents');
  }
  const at = now ?? new Date();
  // Re-uploading a label replaces it: the newest copy of an ID is the one an
  // admin should review, and keeping both invites approving the stale one.
  // The replacement always starts `pending` — a re-uploaded ID must be
  // re-reviewed, never inherit the previous copy's verified/rejected state.
  const documents = request.documents.filter((existing) => existing.label !== document.label);
  return {
    ...bumpVersion(request, at),
    documents: [
      ...documents,
      {
        ...document,
        uploadedAt: at.toISOString(),
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        rejectionReason: null,
      },
    ],
  };
}

/** Document labels an individual applicant must supply before an admin can decide. */
export const INDIVIDUAL_REQUIRED_DOCUMENT_LABELS: readonly string[] = [
  'id_front',
  'id_back',
  'selfie',
];

/**
 * Document labels a business-entity applicant must supply: a registration
 * document plus a separate identity set for the authorized signatory.
 */
export const BUSINESS_REQUIRED_DOCUMENT_LABELS: readonly string[] = [
  'registration_certificate',
  'sig_id_front',
  'sig_id_back',
  'sig_selfie',
];

/** Every label the upload-url/document endpoints will accept, across both entity types. */
export const ALL_DOCUMENT_LABELS: readonly string[] = [
  ...INDIVIDUAL_REQUIRED_DOCUMENT_LABELS,
  ...BUSINESS_REQUIRED_DOCUMENT_LABELS,
];

/**
 * @deprecated kept for backward compatibility with callers that have not yet
 * moved to the entity-type-aware `requiredDocumentLabelsFor`. Equal to
 * `INDIVIDUAL_REQUIRED_DOCUMENT_LABELS`.
 */
export const REQUIRED_DOCUMENT_LABELS: readonly string[] = INDIVIDUAL_REQUIRED_DOCUMENT_LABELS;

/**
 * Which document labels this request must satisfy before an admin can
 * decide, chosen by the applicant's entity type — mirrors the admin
 * console's own `allRequiredDocumentsVerified` gate (business applicants
 * take a different document set than individuals).
 */
export function requiredDocumentLabelsFor(
  request: Pick<OnboardingRequest, 'profile'>,
): readonly string[] {
  return request.profile.entityType === 'business'
    ? BUSINESS_REQUIRED_DOCUMENT_LABELS
    : INDIVIDUAL_REQUIRED_DOCUMENT_LABELS;
}

export function missingDocuments(request: OnboardingRequest): string[] {
  const present = new Set(request.documents.map((document) => document.label));
  return requiredDocumentLabelsFor(request).filter((label) => !present.has(label));
}

/**
 * True iff every label this request's entity type requires is both present
 * and has been explicitly marked `verified` by a KYC reviewer. `submitted`
 * only proves the labels are present (`missingDocuments`); this is the
 * stronger gate `approve()` enforces server-side — the admin console's
 * disabled Approve button is advisory only, so a crafted request must not be
 * able to bypass this check.
 */
export function allRequiredDocumentsVerified(request: OnboardingRequest): boolean {
  return requiredDocumentLabelsFor(request).every((label) => {
    const document = request.documents.find((candidate) => candidate.label === label);
    return document !== undefined && document.status === 'verified';
  });
}

/**
 * KYC desk: marks one uploaded document legitimate. Distinct from
 * approve/reject/request-changes on the application itself — this never
 * decides the application, only one document's own review state.
 */
export function verifyKycDocument(
  request: OnboardingRequest,
  label: string,
  reviewedBy: EntityId,
  now?: Date,
): OnboardingRequest {
  const existing = request.documents.find((document) => document.label === label);
  if (!existing) {
    throw new InvalidOperationError(`No document with label "${label}" has been uploaded`);
  }
  const at = now ?? new Date();
  const updated: OnboardingDocument = {
    ...existing,
    status: 'verified',
    reviewedBy,
    reviewedAt: at.toISOString(),
    rejectionReason: null,
  };
  return {
    ...bumpVersion(request, at),
    documents: request.documents.map((document) => (document.label === label ? updated : document)),
  };
}

/** KYC desk: marks one uploaded document illegitimate/unreadable — reason required. */
export function rejectKycDocument(
  request: OnboardingRequest,
  label: string,
  reason: string,
  reviewedBy: EntityId,
  now?: Date,
): OnboardingRequest {
  const existing = request.documents.find((document) => document.label === label);
  if (!existing) {
    throw new InvalidOperationError(`No document with label "${label}" has been uploaded`);
  }
  if (!reason || reason.trim().length === 0) {
    // Same pattern as `requestOnboardingChanges`'s note requirement — a
    // rejection with no reason leaves the applicant guessing what to fix.
    throw new InvalidOperationError('Rejecting a document requires a reason');
  }
  const at = now ?? new Date();
  const updated: OnboardingDocument = {
    ...existing,
    status: 'rejected',
    reviewedBy,
    reviewedAt: at.toISOString(),
    rejectionReason: reason.trim(),
  };
  return {
    ...bumpVersion(request, at),
    documents: request.documents.map((document) => (document.label === label ? updated : document)),
  };
}

export function submitOnboardingRequest(request: OnboardingRequest, now?: Date): OnboardingRequest {
  const missing = missingDocuments(request);
  if (missing.length > 0) {
    // Fail here rather than let an admin discover it mid-review.
    throw new InvalidOperationError(`Missing required documents: ${missing.join(', ')}`);
  }
  const at = now ?? new Date();
  const next = transitionStatus(request.status, 'submitted', ONBOARDING_TRANSITIONS);
  return { ...bumpVersion(request, at), status: next, submittedAt: at.toISOString() };
}

export interface ReviewOnboardingInput {
  reviewedBy: EntityId;
  note?: string;
  now?: Date;
}

export function requestOnboardingChanges(
  request: OnboardingRequest,
  input: ReviewOnboardingInput,
): OnboardingRequest {
  if (!input.note || input.note.trim().length === 0) {
    // "Changes requested" with no note leaves the applicant guessing.
    throw new InvalidOperationError('Requesting changes requires a note saying what to change');
  }
  return review(request, 'changes_requested', input);
}

export function rejectOnboardingRequest(
  request: OnboardingRequest,
  input: ReviewOnboardingInput,
): OnboardingRequest {
  return review(request, 'rejected', input);
}

/**
 * Approval records WHO decided and which organization was provisioned. The
 * organization is created by the service in the same unit of work; this model
 * only records the link so the decision stays auditable.
 */
export function approveOnboardingRequest(
  request: OnboardingRequest,
  input: ReviewOnboardingInput & { provisionedOrganizationId: EntityId },
): OnboardingRequest {
  const reviewed = review(request, 'approved', input);
  return { ...reviewed, provisionedOrganizationId: input.provisionedOrganizationId };
}

function review(
  request: OnboardingRequest,
  to: OnboardingStatus,
  input: ReviewOnboardingInput,
): OnboardingRequest {
  const at = input.now ?? new Date();
  const next = transitionStatus(request.status, to, ONBOARDING_TRANSITIONS);
  return {
    ...bumpVersion(request, at),
    status: next,
    reviewedBy: input.reviewedBy,
    reviewedAt: at.toISOString(),
    reviewNote: input.note?.trim() ?? null,
  };
}

/**
 * Strips fields an applicant must never set on their own request.
 *
 * v1 stripped `role` from the autosave body as an explicit
 * privilege-escalation guard. This is the same guard, made total: the input
 * type only admits profile fields, and anything else a client sends is
 * dropped here rather than merged.
 */
export function sanitizeApplicantProfile(
  input: Record<string, unknown>,
): Partial<OnboardingProfile> {
  const allowed: (keyof OnboardingProfile)[] = [
    'legalName',
    'contactPerson',
    'phone',
    'city',
    'area',
    'website',
    'capacity',
    'instagram',
    'bio',
    'businessType',
    'registrationNumber',
    'entityType',
  ];
  const profile: Record<string, unknown> = {};
  for (const key of allowed) {
    if (input[key] !== undefined) profile[key] = input[key];
  }
  return profile;
}
