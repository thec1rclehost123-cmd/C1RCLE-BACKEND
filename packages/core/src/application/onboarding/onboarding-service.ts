import {
  ForbiddenError,
  InvalidOperationError,
  OnboardingRequestNotFoundError,
} from '../../domain/errors.js';
import {
  addOnboardingDocument,
  allRequiredDocumentsVerified,
  ALL_DOCUMENT_LABELS,
  approveOnboardingRequest,
  createOnboardingRequest,
  missingDocuments,
  platformFeePercentFor,
  rejectKycDocument,
  rejectOnboardingRequest,
  requestOnboardingChanges,
  sanitizeApplicantProfile,
  submitOnboardingRequest,
  updateOnboardingProfile,
  verifyKycDocument,
} from '../../domain/models/onboarding.js';
import { createOrganization } from '../../domain/models/organization.js';

import type { EntityId } from '../../domain/identity.js';
import type { PlatformAdmin } from '../../domain/models/admin-authority.js';
import type {
  OnboardingPlan,
  OnboardingProfile,
  OnboardingRequest,
  OnboardingStatus,
  PartnerEntityType,
} from '../../domain/models/onboarding.js';
import type { Capability, Organization } from '../../domain/models/organization.js';
import type { ReadUrlGrant, UploadUrlGrant } from '../../domain/ports/object-storage.js';
import type { PaginationQuery } from '../../domain/ports/repositories.js';
import type { VerificationResult } from '../../domain/ports/verification.js';
import type { AdminAuthorityService } from '../admin/admin-authority-service.js';
import type { ServiceDeps } from '../context.js';

/**
 * ─── Onboarding service (Phase 2) ────────────────────────────────────────────
 *
 * The partner application, from "I want to join" to a provisioned
 * organization. Two audiences, and the split between them is the whole design:
 *
 *  - **Applicants** act on *their own* request, addressed by their user id.
 *    They have no organization yet, so none of the tenancy machinery the rest
 *    of the app uses applies here; ownership is checked against `userId`.
 *  - **Admins** act on *any* request, but only through
 *    `AdminAuthorityService`, which is what makes an admin an admin. Approval
 *    is `ONBOARDING_APPROVE` — TIER2, so `support` cannot approve partners.
 *
 * The applicant never supplies anything that carries authority. The requested
 * partner type is a request; the plan determines the platform fee; and
 * `sanitizeApplicantProfile` drops everything else a client sends.
 */

/** How many verification attempts one applicant gets, and over what window. */
const VERIFICATION_ATTEMPT_LIMIT = 5;
const VERIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** KYC image upload bounds — enforced in the signed URL itself. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
/** Admin KYC desk read URLs — short-lived like the upload grant they mirror. */
const READ_URL_TTL_MS = 10 * 60 * 1000;
const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface StartApplicationCommand {
  requestedType: PartnerEntityType;
  plan: OnboardingPlan;
  profile: Partial<OnboardingProfile> & { legalName: string; contactPerson: string };
}

export interface AddDocumentCommand {
  requestId: EntityId;
  label: string;
  storagePath: string;
}

export interface IssueUploadUrlCommand {
  requestId: EntityId;
  /** One of the three required KYC labels. */
  label: string;
  /** `image/jpeg` | `image/png` | `image/webp`. */
  contentType: string;
}

export interface VerifyDocumentCommand {
  documentType: string;
  documentNumber: string;
  holderName?: string;
  proofToken?: string;
}

export interface ReviewCommand {
  requestId: EntityId;
  note?: string;
}

export interface DocumentReviewCommand {
  requestId: EntityId;
  label: string;
}

export interface RejectDocumentCommand extends DocumentReviewCommand {
  reason: string;
}

export class OnboardingService {
  constructor(
    private deps: ServiceDeps,
    private authority: AdminAuthorityService,
  ) {}

  private get repo() {
    return this.deps.repositories.onboarding;
  }

  /* ─── Applicant side ─────────────────────────────────────────────────────── */

  /**
   * Opens an application. One live application per person: a second one would
   * let an applicant keep a rejected history out of view by starting over, and
   * would leave admins deciding which of two drafts is real.
   */
  async start(userId: EntityId, command: StartApplicationCommand): Promise<OnboardingRequest> {
    const open = await this.repo.findOpenForUser(userId);
    if (open) {
      throw new InvalidOperationError('You already have an onboarding application in progress');
    }
    const request = createOnboardingRequest({
      id: this.deps.config.ids(),
      userId,
      requestedType: command.requestedType,
      plan: command.plan,
      profile: {
        ...command.profile,
        ...sanitizeApplicantProfile(command.profile),
      } as OnboardingProfile,
      now: this.deps.config.clock.now(),
    });
    await this.repo.save(request);
    this.deps.logger.info('onboarding.started', { requestId: request.id });
    return request;
  }

  /** The applicant's own application, if any. `null` rather than a 404. */
  async getMine(userId: EntityId): Promise<OnboardingRequest | null> {
    return this.repo.findOpenForUser(userId);
  }

  async listMine(userId: EntityId, query: PaginationQuery) {
    return this.repo.listForUser(userId, query);
  }

  /** Autosave. Everything that is not a profile field is dropped, not merged. */
  async saveProgress(
    userId: EntityId,
    requestId: EntityId,
    body: Record<string, unknown>,
  ): Promise<OnboardingRequest> {
    const request = await this.requireOwn(userId, requestId);
    const updated = updateOnboardingProfile(
      request,
      sanitizeApplicantProfile(body),
      this.deps.config.clock.now(),
    );
    await this.repo.save(updated);
    return updated;
  }

  /**
   * Mints a short-lived, content-type-bound, size-bound URL the applicant
   * `PUT`s a KYC image straight to — the gateway never sees the bytes. The
   * caller records the returned `storagePath` via `addDocument` afterwards.
   *
   * Not idempotency-keyed: minting a fresh URL is safe to repeat, and the
   * object key is deterministic (`kyc/<userId>/<applicationId>/<label>`), so a
   * re-upload of the same label overwrites in place — matching
   * `addOnboardingDocument`'s replace-by-label rule.
   */
  async issueDocumentUploadUrl(
    userId: EntityId,
    command: IssueUploadUrlCommand,
  ): Promise<UploadUrlGrant> {
    const request = await this.requireOwn(userId, command.requestId);

    // Validated against the full label set (both entity-type paths), not
    // just this applicant's — `requestedType`/`entityType` can still change
    // while the request is a draft, and an upload-url mint has no side
    // effect worth gating more tightly than "is this a real KYC label".
    if (!ALL_DOCUMENT_LABELS.includes(command.label)) {
      throw new InvalidOperationError(
        `Unknown document label — expected one of ${ALL_DOCUMENT_LABELS.join(', ')}`,
      );
    }
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(command.contentType)) {
      throw new InvalidOperationError('Document must be a JPEG, PNG, or WebP image');
    }

    const key = `kyc/${userId}/${request.id}/${command.label}`;
    const expiresAt = this.deps.config.clock.now().getTime() + UPLOAD_URL_TTL_MS;
    const grant = await this.deps.objectStorage.issueUploadUrl({
      key,
      contentType: command.contentType,
      maxBytes: MAX_DOCUMENT_BYTES,
      expiresAt,
    });
    this.deps.logger.info('onboarding.upload_url_issued', {
      requestId: request.id,
      label: command.label,
      provider: this.deps.objectStorage.name,
    });
    return grant;
  }

  async addDocument(userId: EntityId, command: AddDocumentCommand): Promise<OnboardingRequest> {
    const request = await this.requireOwn(userId, command.requestId);
    const updated = addOnboardingDocument(
      request,
      { label: command.label, storagePath: command.storagePath },
      this.deps.config.clock.now(),
    );
    await this.repo.save(updated);
    return updated;
  }

  async submit(userId: EntityId, requestId: EntityId): Promise<OnboardingRequest> {
    const request = await this.requireOwn(userId, requestId);
    const submitted = submitOnboardingRequest(request, this.deps.config.clock.now());
    await this.repo.save(submitted);
    this.deps.logger.info('onboarding.submitted', { requestId });
    return submitted;
  }

  /** What is still missing before the applicant can submit. */
  async missingDocuments(userId: EntityId, requestId: EntityId): Promise<string[]> {
    return missingDocuments(await this.requireOwn(userId, requestId));
  }

  /**
   * Runs a document check through the configured provider.
   *
   * Rate-limited per applicant, because an unbounded check is an oracle: with
   * enough attempts a caller can search for a number that passes. The attempt
   * is recorded whether it passes or fails — a failed probe is exactly the
   * thing worth having a record of.
   */
  async verifyDocument(
    userId: EntityId,
    command: VerifyDocumentCommand,
  ): Promise<VerificationResult> {
    const now = this.deps.config.clock.now();
    const since = now.getTime() - VERIFICATION_WINDOW_MS;
    const attempts = await this.deps.repositories.verificationAttempts.countSince(userId, since);
    if (attempts >= VERIFICATION_ATTEMPT_LIMIT) {
      throw new ForbiddenError('Too many verification attempts — try again tomorrow');
    }

    let result: VerificationResult;
    try {
      result = await this.deps.verification.verify(command);
    } catch (error) {
      // A provider outage is recorded as an attempt too: otherwise an attacker
      // who can induce errors gets unlimited free tries.
      await this.recordAttempt(userId, command.documentType, 'error', this.deps.verification.name);
      throw error;
    }
    await this.recordAttempt(
      userId,
      command.documentType,
      result.passed ? 'passed' : 'failed',
      result.provider,
    );
    return result;
  }

  private async recordAttempt(
    userId: EntityId,
    documentType: string,
    outcome: 'passed' | 'failed' | 'error',
    provider: string,
  ): Promise<void> {
    await this.deps.repositories.verificationAttempts.append({
      id: this.deps.config.ids(),
      userId,
      documentType,
      outcome,
      provider,
      attemptedAt: this.deps.config.clock.now().getTime(),
    });
  }

  /* ─── Admin side ─────────────────────────────────────────────────────────── */

  async listQueue(adminUserId: EntityId, status: OnboardingStatus | null, query: PaginationQuery) {
    await this.authority.requireAdmin(adminUserId);
    return this.repo.listByStatus(status, query);
  }

  async getForReview(adminUserId: EntityId, requestId: EntityId): Promise<OnboardingRequest> {
    await this.authority.requireAdmin(adminUserId);
    return this.requireRequest(requestId);
  }

  /**
   * Approves an application and provisions the organization it asked for.
   *
   * The two writes are ordered organization-first: a failure after the
   * organization exists leaves the request still `submitted`, which an admin
   * can retry — the opposite order would leave an approved request pointing at
   * an organization that was never created, which nothing can repair.
   *
   * Note what is *not* here: no automatic approval on a passing verification.
   * The provider is advisory (see `ports/verification.ts`); a human at TIER2
   * makes the decision.
   */
  async approve(
    adminUserId: EntityId,
    command: ReviewCommand,
  ): Promise<{ request: OnboardingRequest; organization: Organization }> {
    const admin = await this.authority.authorize(adminUserId, 'ONBOARDING_APPROVE');
    const request = await this.requireRequest(command.requestId);
    if (request.status !== 'submitted') {
      throw new InvalidOperationError(`Only a submitted application can be approved`);
    }
    // The admin console disables its Approve button until every required
    // document shows `verified`, but that is advisory only — a crafted
    // request must not be able to skip KYC review, so the server enforces
    // the same rule here before provisioning anything.
    if (!allRequiredDocumentsVerified(request)) {
      throw new InvalidOperationError(
        'All required KYC documents must be verified before this application can be approved',
      );
    }

    const now = this.deps.config.clock.now();
    const organization = createOrganization({
      id: this.deps.config.ids(),
      name: request.profile.legalName,
      slug: slugFor(request.profile.legalName, request.id),
      ownerId: request.userId,
      // The applicant gets exactly the capability they applied for. Granting
      // all three "for convenience" would make the requested type meaningless.
      capabilities: [capabilityFor(request.requestedType)],
      platformFeePercent: platformFeePercentFor(request.plan),
      settings: { name: request.profile.legalName, timezone: 'Asia/Kolkata' },
      now,
    });
    await this.deps.repositories.organizations.save(organization);

    const approved = approveOnboardingRequest(request, {
      reviewedBy: admin.id,
      note: command.note,
      provisionedOrganizationId: organization.id,
      now,
    });
    await this.repo.save(approved);

    await this.authority.record(admin, {
      action: 'ONBOARDING_APPROVE',
      targetType: 'onboarding_request',
      targetId: request.id,
      before: { status: request.status },
      after: { status: approved.status, organizationId: organization.id },
      reason: command.note ?? null,
    });
    this.deps.logger.info('onboarding.approved', {
      requestId: request.id,
      organizationId: organization.id,
    });
    return { request: approved, organization };
  }

  async reject(adminUserId: EntityId, command: ReviewCommand): Promise<OnboardingRequest> {
    return this.review(adminUserId, command, 'onboarding.reject', (request, admin, now) =>
      rejectOnboardingRequest(request, { reviewedBy: admin.id, note: command.note, now }),
    );
  }

  async requestChanges(adminUserId: EntityId, command: ReviewCommand): Promise<OnboardingRequest> {
    const updated = await this.review(
      adminUserId,
      command,
      'onboarding.request_changes',
      (request, admin, now) =>
        requestOnboardingChanges(request, { reviewedBy: admin.id, note: command.note, now }),
    );

    // Best-effort notification. The review decision is already persisted and
    // audited above — a transient email-provider outage (or a user we cannot
    // resolve an email for, e.g. on the memory/test driver) must not roll
    // that back or block the admin, so failures are logged and swallowed
    // rather than re-thrown. Never an empty catch: every failure path here
    // is logged.
    try {
      const email = await this.deps.userDirectory.getEmailById(updated.userId);
      if (email) {
        await this.deps.emailSender.sendOnboardingChangesRequestedEmail(email, {
          legalName: updated.profile.legalName,
          note: updated.reviewNote ?? '',
        });
      } else {
        this.deps.logger.info('onboarding.changes_requested_email_skipped', {
          requestId: updated.id,
          reason: 'no_email_on_file',
        });
      }
    } catch (error) {
      this.deps.logger.error('onboarding.changes_requested_email_failed', {
        requestId: updated.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return updated;
  }

  /**
   * KYC desk: verify one uploaded document. Same TIER2 authority as the
   * application decision itself (`ONBOARDING_APPROVE`) — document review
   * gates that decision, so it is not a lesser action.
   *
   * Named `verifyKycDocument` (not `verifyDocument`) to avoid colliding with
   * the applicant-side `verifyDocument` above, which runs a KYC *provider*
   * check on a raw document number — an entirely different operation that
   * happens to share a near-identical name.
   */
  async verifyKycDocument(
    adminUserId: EntityId,
    command: DocumentReviewCommand,
  ): Promise<OnboardingRequest> {
    const admin = await this.authority.authorize(adminUserId, 'ONBOARDING_APPROVE');
    const request = await this.requireRequest(command.requestId);
    const before = documentStatus(request, command.label);
    const updated = verifyKycDocument(
      request,
      command.label,
      admin.id,
      this.deps.config.clock.now(),
    );
    await this.repo.save(updated);
    await this.authority.record(admin, {
      action: 'onboarding.document_verify',
      targetType: 'onboarding_request',
      targetId: request.id,
      before: { label: command.label, status: before },
      after: { label: command.label, status: 'verified' },
      reason: null,
    });
    return updated;
  }

  /** KYC desk: reject one uploaded document — reason required. */
  async rejectKycDocument(
    adminUserId: EntityId,
    command: RejectDocumentCommand,
  ): Promise<OnboardingRequest> {
    const admin = await this.authority.authorize(adminUserId, 'ONBOARDING_APPROVE');
    const request = await this.requireRequest(command.requestId);
    const before = documentStatus(request, command.label);
    const updated = rejectKycDocument(
      request,
      command.label,
      command.reason,
      admin.id,
      this.deps.config.clock.now(),
    );
    await this.repo.save(updated);
    await this.authority.record(admin, {
      action: 'onboarding.document_reject',
      targetType: 'onboarding_request',
      targetId: request.id,
      before: { label: command.label, status: before },
      after: { label: command.label, status: 'rejected' },
      reason: command.reason,
    });
    return updated;
  }

  /**
   * KYC desk: mint a short-lived signed GET to view one uploaded document.
   * `requireAdmin` only — viewing is not a decision, so any active platform
   * admin may do it, unlike verify/reject which are TIER2.
   */
  async getDocumentReadUrl(
    adminUserId: EntityId,
    command: DocumentReviewCommand,
  ): Promise<ReadUrlGrant> {
    await this.authority.requireAdmin(adminUserId);
    const request = await this.requireRequest(command.requestId);
    const document = request.documents.find((candidate) => candidate.label === command.label);
    if (!document) {
      throw new InvalidOperationError(
        `No document with label "${command.label}" has been uploaded`,
      );
    }
    const expiresAt = this.deps.config.clock.now().getTime() + READ_URL_TTL_MS;
    const grant = await this.deps.objectStorage.issueReadUrl({
      key: document.storagePath,
      expiresAt,
    });
    this.deps.logger.info('onboarding.read_url_issued', {
      requestId: request.id,
      label: command.label,
      provider: this.deps.objectStorage.name,
    });
    return grant;
  }

  private async review(
    adminUserId: EntityId,
    command: ReviewCommand,
    auditAction: string,
    apply: (request: OnboardingRequest, admin: PlatformAdmin, now: Date) => OnboardingRequest,
  ): Promise<OnboardingRequest> {
    // Rejecting and asking for changes are TIER2 as well: both determine
    // whether a business gets onto the platform.
    const admin = await this.authority.authorize(adminUserId, 'ONBOARDING_APPROVE');
    const request = await this.requireRequest(command.requestId);
    const updated = apply(request, admin, this.deps.config.clock.now());
    await this.repo.save(updated);
    await this.authority.record(admin, {
      action: auditAction,
      targetType: 'onboarding_request',
      targetId: request.id,
      before: { status: request.status },
      after: { status: updated.status },
      reason: command.note ?? null,
    });
    return updated;
  }

  /* ─── Lookups ────────────────────────────────────────────────────────────── */

  private async requireRequest(requestId: EntityId): Promise<OnboardingRequest> {
    const request = await this.repo.getById(requestId);
    if (!request) throw new OnboardingRequestNotFoundError(requestId);
    return request;
  }

  /**
   * Another applicant's request reads as "no such request" — a distinct
   * "forbidden" would confirm that a given id exists.
   */
  private async requireOwn(userId: EntityId, requestId: EntityId): Promise<OnboardingRequest> {
    const request = await this.repo.getById(requestId);
    if (!request || request.userId !== userId) {
      throw new OnboardingRequestNotFoundError(requestId);
    }
    return request;
  }
}

function capabilityFor(type: PartnerEntityType): Capability {
  return type;
}

/** The current review status of one label, or `null` if never uploaded — for audit `before`. */
function documentStatus(request: OnboardingRequest, label: string): string | null {
  return request.documents.find((document) => document.label === label)?.status ?? null;
}

/**
 * A readable slug that cannot collide: the name is a hint for humans, the id
 * suffix is what makes it unique. Deriving it purely from the name would make
 * the second "Blue Room" fail to onboard.
 */
function slugFor(name: string, requestId: EntityId): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const suffix = requestId
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toLowerCase();
  return base ? `${base}-${suffix}` : suffix;
}
