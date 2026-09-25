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
 * A single document's verification state, distinct from the application's
 * own `OnboardingStatus`: KYC is "is this document legitimate", onboarding
 * is "should this applicant become a partner" — approving the application
 * requires every required document to be `verified` first (see
 * `approveOnboardingRequest`), but the two decisions are made separately,
 * by different desks, and are never the same button.
 */
export type OnboardingDocumentStatus = 'pending' | 'verified' | 'rejected';

/** A KYC document the applicant has uploaded. */
export interface OnboardingDocument {
  /** v1 label vocabulary: id_front, id_back, selfie, cheque, registration_certificate… */
  label: string;
  storagePath: string;
  uploadedAt: string;
  status: OnboardingDocumentStatus;
  /** Which admin verified or rejected this document, if any. */
  reviewedBy: EntityId | null;
  reviewedAt: string | null;
  /** Required when `status` is `rejected`. */
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
  document: { label: string; storagePath: string },
  now?: Date,
): OnboardingRequest {
  if (request.status === 'approved' || request.status === 'rejected') {
    throw new InvalidOperationError('A decided onboarding request cannot take new documents');
  }
  const at = now ?? new Date();
  // Re-uploading a label replaces it: the newest copy of an ID is the one an
  // admin should review, and keeping both invites approving the stale one.
  // A fresh upload always resets verification — a previously verified ID
  // photo says nothing about the new file that just overwrote it.
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

/**
 * Admin marks one uploaded document as legitimate. Purely a KYC decision —
 * does not touch `OnboardingRequest.status`, and carries no authority over
 * whether the application itself gets approved.
 */
export function verifyOnboardingDocument(
  request: OnboardingRequest,
  label: string,
  adminId: EntityId,
  now?: Date,
): OnboardingRequest {
  return reviewDocument(request, label, adminId, 'verified', null, now);
}

/** Admin marks one uploaded document as illegitimate/unreadable — requires a reason. */
export function rejectOnboardingDocument(
  request: OnboardingRequest,
  label: string,
  adminId: EntityId,
  reason: string,
  now?: Date,
): OnboardingRequest {
  if (reason.trim().length === 0) {
    throw new InvalidOperationError('Rejecting a document requires a reason');
  }
  return reviewDocument(request, label, adminId, 'rejected', reason.trim(), now);
}

function reviewDocument(
  request: OnboardingRequest,
  label: string,
  adminId: EntityId,
  status: 'verified' | 'rejected',
  rejectionReason: string | null,
  now?: Date,
): OnboardingRequest {
  const existing = request.documents.find((document) => document.label === label);
  if (existing === undefined) {
    throw new InvalidOperationError(`No document with label "${label}" has been uploaded`);
  }
  const at = now ?? new Date();
  const documents = request.documents.map((document) =>
    document.label === label
      ? { ...existing, status, reviewedBy: adminId, reviewedAt: at.toISOString(), rejectionReason }
      : document,
  );
  return { ...bumpVersion(request, at), documents };
}

/**
 * Every REQUIRED document (see `missingDocuments`) is present and
 * `verified` — the gate `approveOnboardingRequest` checks. A document that
 * is merely uploaded (`pending`) or was `rejected` does not count: KYC
 * review must have actively signed off on each one.
 */
export function allRequiredDocumentsVerified(request: OnboardingRequest): boolean {
  if (missingDocuments(request).length > 0) return false;
  const required =
    request.profile.entityType === 'business'
      ? REQUIRED_DOCUMENT_LABELS_BUSINESS
      : REQUIRED_DOCUMENT_LABELS;
  return required.every((label) =>
    request.documents.some(
      (document) => document.label === label && document.status === 'verified',
    ),
  );
}

/** Individual-applicant document labels, kept as the default set. */
export const REQUIRED_DOCUMENT_LABELS: readonly string[] = ['id_front', 'id_back', 'selfie'];

/** Business-entity applicants supply a registration doc plus a signatory's identity set. */
export const REQUIRED_DOCUMENT_LABELS_BUSINESS: readonly string[] = [
  'registration_certificate',
  'sig_id_front',
  'sig_id_back',
  'sig_selfie',
];

/**
 * `profile.entityType` is a free-form string (v1 precedent), so this only
 * recognizes the one value that switches the required set — anything else
 * (including unset) falls back to the individual set, matching prior
 * behavior for every request that predates this field mattering.
 */
export function missingDocuments(request: OnboardingRequest): string[] {
  const required =
    request.profile.entityType === 'business'
      ? REQUIRED_DOCUMENT_LABELS_BUSINESS
      : REQUIRED_DOCUMENT_LABELS;
  const present = new Set(request.documents.map((document) => document.label));
  return required.filter((label) => !present.has(label));
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
 *
 * Refuses unless every required document has been actively `verified` by
 * KYC review (not just uploaded) — approving an applicant whose ID photos
 * were never checked is exactly the gap that motivated splitting KYC review
 * from this decision in the first place.
 */
export function approveOnboardingRequest(
  request: OnboardingRequest,
  input: ReviewOnboardingInput & { provisionedOrganizationId: EntityId },
): OnboardingRequest {
  // Validate the state transition itself first (throws StateTransitionError
  // for an already-decided or never-submitted request) before the KYC gate
  // below — a request that couldn't be approved anyway shouldn't surface a
  // misleading "documents unverified" message.
  transitionStatus(request.status, 'approved', ONBOARDING_TRANSITIONS);
  if (!allRequiredDocumentsVerified(request)) {
    throw new InvalidOperationError(
      'All required documents must be verified on the KYC desk before this application can be approved',
    );
  }
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
