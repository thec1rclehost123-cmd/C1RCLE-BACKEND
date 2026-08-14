/**
 * ─── T12 audit port ───────────────────────────────────────────────────────────
 * Audit writes go through this repository — never directly from a route.
 * Memory-backed for this slice; durable adapter in B12.
 */

import type { EntityId } from '../identity.js';

export interface AuditRecord {
  id: EntityId;
  organizationId: EntityId;
  actorId: EntityId;
  /** Source domain event type, e.g. `event.published`. */
  eventType: string;
  aggregateId: EntityId;
  /** Epoch ms */
  occurredAt: number;
  snapshot: Record<string, unknown>;
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>;
  listByOrganization(organizationId: EntityId, limit: number): Promise<AuditRecord[]>;
}

/**
 * ─── Admin audit trail (Phase 2) ─────────────────────────────────────────────
 *
 * Separate from `AuditRecord` on purpose. That one records a *domain event* in
 * one organization's history. This one records a *platform operator's* action,
 * which has no organization, and which the roadmap requires to carry
 * **before/after state** — a single `snapshot` cannot answer "what did this
 * admin actually change?", which is the only question an audit of privileged
 * action is ever asked.
 */
export interface AdminAuditRecord {
  id: EntityId;
  /** The admin user id. */
  adminId: EntityId;
  adminRole: string;
  /** `AdminAction`, or a lower-tier verb like `onboarding.request_changes`. */
  action: string;
  /** What was acted on. */
  targetType: string;
  targetId: EntityId;
  /** State before the action, `null` when the action created the target. */
  before: Record<string, unknown> | null;
  /** State after, `null` when the action deleted it. */
  after: Record<string, unknown> | null;
  /** Operator-supplied justification, when the action required one. */
  reason: string | null;
  /** Epoch ms. */
  occurredAt: number;
}

export interface AdminAuditRepository {
  append(record: AdminAuditRecord): Promise<void>;
  listRecent(limit: number): Promise<AdminAuditRecord[]>;
  listForTarget(targetId: EntityId, limit: number): Promise<AdminAuditRecord[]>;
}
