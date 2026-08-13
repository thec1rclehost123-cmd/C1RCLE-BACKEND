/**
 * ─── T12 outbox ports ─────────────────────────────────────────────────────────
 * Domain events are written to the outbox in the same unit of work as the
 * business write (transaction adapter port later; in-memory now). The in-process
 * EventBus polls pending rows; durable delivery (Redis/queue) lands in B12.
 */

import type { DomainEvent } from '../events.js';
import type { EntityId } from '../identity.js';

export const OUTBOX_MAX_ATTEMPTS = 5;

export type OutboxStatus = 'pending' | 'processed' | 'failed';

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
}

/** Append-side: written in the same unit of work as the business write. */
export interface OutboxWriter {
  append(event: DomainEvent): Promise<void>;
  /** Mark a row delivered (consumer idempotency by event id). */
  markProcessed(id: EntityId, processedAt: number): Promise<void>;
  /** Failed attempts never silently dropped — go to DLQ after max attempts. */
  markFailed(id: EntityId, attempts: number): Promise<void>;
  /** Bump attempt counter; returns the new count (for DLQ decisions). */
  bumpAttempts(id: EntityId): Promise<number>;
}

/** Read-side: the EventBus drains pending rows. */
export interface OutboxReader {
  listPending(limit?: number): Promise<OutboxRecord[]>;
}

export interface OutboxStore extends OutboxWriter, OutboxReader {}
