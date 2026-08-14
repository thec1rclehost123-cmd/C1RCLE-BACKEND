import { compareAndSet } from './compare-and-set.js';
import { paginateQuery } from './pagination.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  AdminRole,
  PlatformAdmin,
  ProposalStatus,
  ProposedAction,
} from '../../domain/models/admin-authority.js';
import type {
  OnboardingDocument,
  OnboardingPlan,
  OnboardingProfile,
  OnboardingRequest,
  OnboardingStatus,
  PartnerEntityType,
} from '../../domain/models/onboarding.js';
import type { AdminAuditRecord, AdminAuditRepository } from '../../domain/ports/audit.js';
import type {
  OnboardingRepository,
  Page,
  PaginationQuery,
  PlatformAdminRepository,
  ProposedActionRepository,
  TxContext,
  VerificationAttempt,
  VerificationAttemptRepository,
} from '../../domain/ports/repositories.js';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

/**
 * ─── Firestore Phase 2 adapters ──────────────────────────────────────────────
 * Collections per `docs/roadmap/phase-02-kyc-onboarding.md`.
 */

const ONBOARDING_COLLECTION = 'v2_onboarding_requests';
const ADMIN_COLLECTION = 'v2_admins';
const PROPOSAL_COLLECTION = 'v2_proposed_actions';
const VERIFICATION_COLLECTION = 'v2_verification_attempts';

const OPEN_STATUSES: readonly OnboardingStatus[] = ['draft', 'submitted', 'changes_requested'];

export class FirestoreOnboardingRepository implements OnboardingRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(ONBOARDING_COLLECTION);
  }

  async getById(requestId: EntityId): Promise<OnboardingRequest | null> {
    const data = (await this.collection.doc(requestId).get()).data();
    return data ? toRequest(data) : null;
  }

  async findOpenForUser(userId: EntityId): Promise<OnboardingRequest | null> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .where('status', 'in', OPEN_STATUSES)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    return doc ? toRequest(doc.data()) : null;
  }

  async listForUser(userId: EntityId, query: PaginationQuery): Promise<Page<OnboardingRequest>> {
    const base = this.collection.where('userId', '==', userId).orderBy('createdAt', 'desc');
    return paginateQuery(base, query, toRequest);
  }

  async listByStatus(
    status: OnboardingStatus | null,
    query: PaginationQuery,
  ): Promise<Page<OnboardingRequest>> {
    // Oldest first — the review queue is a queue, not a feed.
    const base = (
      status === null ? this.collection : this.collection.where('status', '==', status)
    ).orderBy('createdAt');
    return paginateQuery(base, query, toRequest);
  }

  async save(request: OnboardingRequest, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, request, (entity) => ({ ...entity }));
  }
}

export class FirestorePlatformAdminRepository implements PlatformAdminRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(ADMIN_COLLECTION);
  }

  async getById(userId: EntityId): Promise<PlatformAdmin | null> {
    const data = (await this.collection.doc(userId).get()).data();
    return data ? toAdmin(data) : null;
  }

  async list(query: PaginationQuery): Promise<Page<PlatformAdmin>> {
    return paginateQuery(this.collection.orderBy('email'), query, toAdmin);
  }

  async save(admin: PlatformAdmin, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, admin, (entity) => ({ ...entity }));
  }
}

export class FirestoreProposedActionRepository implements ProposedActionRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(PROPOSAL_COLLECTION);
  }

  async getById(proposalId: EntityId): Promise<ProposedAction | null> {
    const data = (await this.collection.doc(proposalId).get()).data();
    return data ? toProposal(data) : null;
  }

  async listByStatus(
    status: ProposalStatus | null,
    query: PaginationQuery,
  ): Promise<Page<ProposedAction>> {
    const base = (
      status === null ? this.collection : this.collection.where('status', '==', status)
    ).orderBy('createdAt');
    return paginateQuery(base, query, toProposal);
  }

  async save(proposal: ProposedAction, _tx?: TxContext | null): Promise<void> {
    await compareAndSet(this.db, this.collection, proposal, (entity) => ({ ...entity }));
  }
}

/**
 * Attempts are append-only and unversioned — they are a log, not an aggregate,
 * so `compareAndSet` does not apply.
 */
export class FirestoreVerificationAttemptRepository implements VerificationAttemptRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(VERIFICATION_COLLECTION);
  }

  async append(attempt: VerificationAttempt): Promise<void> {
    await this.collection.doc(attempt.id).set({ ...attempt });
  }

  async countSince(userId: EntityId, sinceEpochMs: number): Promise<number> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .where('attemptedAt', '>=', sinceEpochMs)
      .count()
      .get();
    return snap.data().count;
  }

  async listForUser(userId: EntityId, limit: number): Promise<VerificationAttempt[]> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .orderBy('attemptedAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => toAttempt(doc.data()));
  }
}

function toRequest(data: DocumentData): OnboardingRequest {
  return {
    id: data.id as string,
    userId: data.userId as string,
    status: data.status as OnboardingStatus,
    requestedType: data.requestedType as PartnerEntityType,
    plan: data.plan as OnboardingPlan,
    profile: (data.profile ?? {}) as OnboardingProfile,
    documents: (data.documents ?? []) as OnboardingDocument[],
    submittedAt: (data.submittedAt ?? null) as string | null,
    reviewedBy: (data.reviewedBy ?? null) as string | null,
    reviewedAt: (data.reviewedAt ?? null) as string | null,
    reviewNote: (data.reviewNote ?? null) as string | null,
    provisionedOrganizationId: (data.provisionedOrganizationId ?? null) as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toAdmin(data: DocumentData): PlatformAdmin {
  return {
    id: data.id as string,
    email: data.email as string,
    role: data.role as AdminRole,
    isActive: data.isActive as boolean,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toProposal(data: DocumentData): ProposedAction {
  return {
    id: data.id as string,
    action: data.action as ProposedAction['action'],
    proposedBy: data.proposedBy as string,
    reason: data.reason as string,
    payload: (data.payload ?? {}) as Record<string, unknown>,
    status: data.status as ProposalStatus,
    resolvedBy: (data.resolvedBy ?? null) as string | null,
    resolvedAt: (data.resolvedAt ?? null) as string | null,
    resolutionReason: (data.resolutionReason ?? null) as string | null,
    version: data.version as number,
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
  };
}

function toAttempt(data: DocumentData): VerificationAttempt {
  return {
    id: data.id as string,
    userId: data.userId as string,
    documentType: data.documentType as string,
    outcome: data.outcome as VerificationAttempt['outcome'],
    provider: data.provider as string,
    attemptedAt: data.attemptedAt as number,
  };
}

const ADMIN_AUDIT_COLLECTION = 'v2_admin_audit_logs';

/** Durable admin audit trail. Append-only: an editable audit is not one. */
export class FirestoreAdminAuditRepository implements AdminAuditRepository {
  constructor(private readonly db: Firestore) {}

  private get collection() {
    return this.db.collection(ADMIN_AUDIT_COLLECTION);
  }

  async append(record: AdminAuditRecord): Promise<void> {
    // `create` rather than `set`: a repeated id must fail loudly rather than
    // overwrite the original record of what an operator did.
    await this.collection
      .doc(record.id)
      .create({ ...record })
      .catch((error: unknown) => {
        if (isAlreadyExists(error)) return;
        throw error;
      });
  }

  async listRecent(limit: number): Promise<AdminAuditRecord[]> {
    const snap = await this.collection.orderBy('occurredAt', 'desc').limit(limit).get();
    return snap.docs.map((doc) => toAdminAudit(doc.data()));
  }

  async listForTarget(targetId: EntityId, limit: number): Promise<AdminAuditRecord[]> {
    const snap = await this.collection
      .where('targetId', '==', targetId)
      .orderBy('occurredAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => toAdminAudit(doc.data()));
  }
}

/** Firestore signals a duplicate `create` with gRPC status 6. */
function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 6;
}

function toAdminAudit(data: DocumentData): AdminAuditRecord {
  return {
    id: data.id as string,
    adminId: data.adminId as string,
    adminRole: data.adminRole as string,
    action: data.action as string,
    targetType: data.targetType as string,
    targetId: data.targetId as string,
    before: (data.before ?? null) as Record<string, unknown> | null,
    after: (data.after ?? null) as Record<string, unknown> | null,
    reason: (data.reason ?? null) as string | null,
    occurredAt: data.occurredAt as number,
  };
}
