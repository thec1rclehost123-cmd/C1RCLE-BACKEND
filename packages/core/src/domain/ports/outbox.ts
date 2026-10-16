/**
 * ─── T12 outbox ports ─────────────────────────────────────────────────────────
 * Domain events are written to the outbox in the same unit of work as the
 * business write (transaction adapter port later; in-memory now). The in-process
 * EventBus polls pending rows; durable delivery (Redis/queue) lands in B12.
 */

import type { DomainEvent } from '../events.js';
import type { EntityId } from '../identity.js';

export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxStatus = 'pending' | 'processing' | 'processed' | 'failed';

export interface OutboxRecord {
  id: EntityId;
  type: string;
  aggregateId: EntityId;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms */
  createdAt: number;
  /** Epoch ms — null until processed. */
  processedAt: number | null;
  /** Epoch ms — retry is not eligible before this time. */
  nextAttemptAt: number;
  leaseOwner: string | null;
  /** Unique claim generation; stale workers cannot complete a reclaimed row. */
  leaseToken: string | null;
  /** Epoch ms — an expired processing lease is safe to reclaim. */
  leaseExpiresAt: number | null;
  /** Sanitized operational detail, never a provider payload or secret. */
  lastError: string | null;
  /** Epoch ms. */
  updatedAt: number;
}

/** Append-side: written in the same unit of work as the business write. */
export interface OutboxWriter {
  append(event: DomainEvent): Promise<void>;
  /** Mark a row delivered (consumer idempotency by event id). */
  markProcessed(id: EntityId, processedAt: number, leaseToken?: string): Promise<void>;
  /** Failed attempts never silently dropped — go to DLQ after max attempts. */
  markFailed(id: EntityId, attempts: number, leaseToken?: string): Promise<void>;
  /** Bump attempt counter; returns the new count (for DLQ decisions). */
  bumpAttempts(id: EntityId): Promise<number>;
  /** Return a failed row to pending with bounded-backoff scheduling. */
  scheduleRetry(
    id: EntityId,
    nextAttemptAt: number,
    error: string,
    leaseToken?: string,
  ): Promise<void>;
}

/** Read-side: the EventBus drains pending rows. */
export interface OutboxReader {
  listPending(limit?: number): Promise<OutboxRecord[]>;
  /** Atomically claims eligible work and reclaims expired leases. */
  claimPending(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit?: number;
  }): Promise<OutboxRecord[]>;
}

export interface OutboxStore extends OutboxWriter, OutboxReader {}
