import { VersionConflictError } from '../../domain/errors.js';

import type { EntityId } from '../../domain/identity.js';
import type {
  PlatformAdmin,
  ProposalStatus,
  ProposedAction,
} from '../../domain/models/admin-authority.js';
import type { OnboardingRequest, OnboardingStatus } from '../../domain/models/onboarding.js';
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

/**
 * ─── In-memory Phase 2 adapters ──────────────────────────────────────────────
 * Dev/test implementations of the onboarding, admin, proposal and verification
 * ports. Same compare-and-set invariant as the Firestore adapters, so a
 * contract suite proves both.
 */

/** A request is "open" while the applicant can still act on it. */
const OPEN_STATUSES: readonly OnboardingStatus[] = ['draft', 'submitted', 'changes_requested'];

function casSet<T extends { id: EntityId; version: number }>(store: Map<EntityId, T>, next: T) {
  if (next.version > 1) {
    const storedVersion = store.get(next.id)?.version ?? 0;
    if (storedVersion !== next.version - 1) {
      throw new VersionConflictError(next.version - 1, storedVersion);
    }
  }
  store.set(next.id, next);
}

function slice<T>(all: T[], query: PaginationQuery): Page<T> {
  const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
  const items = all.slice(offset, offset + query.limit);
  const next = offset + items.length;
  return { items, total: all.length, nextCursor: next < all.length ? String(next) : null };
}

export class MemoryOnboardingRepository implements OnboardingRepository {
  requests = new Map<EntityId, OnboardingRequest>();

  async getById(requestId: EntityId): Promise<OnboardingRequest | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findOpenForUser(userId: EntityId): Promise<OnboardingRequest | null> {
    return (
      [...this.requests.values()].find(
        (request) => request.userId === userId && OPEN_STATUSES.includes(request.status),
      ) ?? null
    );
  }

  async listForUser(userId: EntityId, query: PaginationQuery): Promise<Page<OnboardingRequest>> {
    const all = [...this.requests.values()]
      .filter((request) => request.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return slice(all, query);
  }

  async listByStatus(
    status: OnboardingStatus | null,
    query: PaginationQuery,
  ): Promise<Page<OnboardingRequest>> {
    const all = [...this.requests.values()]
      .filter((request) => status === null || request.status === status)
      // Oldest first: a review queue that surfaces the newest application
      // first leaves the earliest applicant waiting longest.
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return slice(all, query);
  }

  async save(request: OnboardingRequest, _tx?: TxContext | null): Promise<void> {
    casSet(this.requests, request);
  }
}

export class MemoryPlatformAdminRepository implements PlatformAdminRepository {
  admins = new Map<EntityId, PlatformAdmin>();

  async getById(userId: EntityId): Promise<PlatformAdmin | null> {
    return this.admins.get(userId) ?? null;
  }

  async list(query: PaginationQuery): Promise<Page<PlatformAdmin>> {
    const all = [...this.admins.values()].sort((left, right) =>
      left.email.localeCompare(right.email),
    );
    return slice(all, query);
  }

  async save(admin: PlatformAdmin, _tx?: TxContext | null): Promise<void> {
    casSet(this.admins, admin);
  }
}

export class MemoryProposedActionRepository implements ProposedActionRepository {
  proposals = new Map<EntityId, ProposedAction>();

  async getById(proposalId: EntityId): Promise<ProposedAction | null> {
    return this.proposals.get(proposalId) ?? null;
  }

  async listByStatus(
    status: ProposalStatus | null,
    query: PaginationQuery,
  ): Promise<Page<ProposedAction>> {
    const all = [...this.proposals.values()]
      .filter((proposal) => status === null || proposal.status === status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return slice(all, query);
  }

  async save(proposal: ProposedAction, _tx?: TxContext | null): Promise<void> {
    casSet(this.proposals, proposal);
  }
}

export class MemoryVerificationAttemptRepository implements VerificationAttemptRepository {
  attempts: VerificationAttempt[] = [];

  async append(attempt: VerificationAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async countSince(userId: EntityId, sinceEpochMs: number): Promise<number> {
    return this.attempts.filter(
      (attempt) => attempt.userId === userId && attempt.attemptedAt >= sinceEpochMs,
    ).length;
  }

  async listForUser(userId: EntityId, limit: number): Promise<VerificationAttempt[]> {
    return this.attempts
      .filter((attempt) => attempt.userId === userId)
      .sort((left, right) => right.attemptedAt - left.attemptedAt)
      .slice(0, limit);
  }
}
