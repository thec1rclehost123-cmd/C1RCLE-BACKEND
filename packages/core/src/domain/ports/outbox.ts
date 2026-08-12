/**
 * ─── Transactional outbox + audit ports (T11/T12) ────────────────────────────
 *
 * The rule this exists to enforce: a domain event must be committed in the
 * **same unit of work** as the business write it describes. If the process dies
 * after the commit, the row is still there and delivery retries; if the
 * business write rolls back, the event goes with it. No event is ever published
 * for a write that did not happen, and no write happens without its event.
 *
 * Interfaces only — no queue, no database, no clock.
 */

import type { DomainEvent } from '../events/domain-events.js';
import type { EntityId } from '../identity.js';
import type { TxContext } from './repositories.js';

export type OutboxStatus = 'pending' | 'processed' | 'dead_letter';

export interface OutboxRecord {
  readonly id: EntityId;
  readonly event: DomainEvent;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly lastError: string | null;
}

/** Attempts after which a row stops retrying and lands in the DLQ (T13). */
export const OUTBOX_MAX_ATTEMPTS = 10;

/**
 * A unit of work spanning the business write and its outbox rows. `append` is
 * only durable once the surrounding `runInTransaction` commits.
 */
export interface OutboxWriter {
  append(event: DomainEvent, tx?: TxContext | null): Promise<void>;
}

export interface UnitOfWork {
  /**
   * Runs `work` and commits every buffered write atomically. A throw discards
   * the whole scope — business rows and outbox rows together. The handle is
   * the same `TxContext` the repositories already accept, so one scope covers
   * the business write and its events.
   */
  runInTransaction<T>(work: (tx: TxContext) => Promise<T>): Promise<T>;
}

/** Read/claim side used by the relay worker. */
export interface OutboxReader {
  listPending(limit: number): Promise<OutboxRecord[]>;
  markProcessed(recordId: EntityId, now: Date): Promise<void>;
  markFailed(recordId: EntityId, error: string, now: Date): Promise<void>;
  listDeadLettered(): Promise<OutboxRecord[]>;
}

/* ─── Audit (rule 13: audit is a service, never a route-level write) ──────── */

export interface AuditRecord {
  readonly id: EntityId;
  readonly organizationId: EntityId;
  readonly actorId: EntityId;
  readonly action: string;
  readonly resourceId: EntityId;
  readonly recordedAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface AuditRepository {
  append(record: AuditRecord): Promise<void>;
  listForOrganization(organizationId: EntityId): Promise<AuditRecord[]>;
}
