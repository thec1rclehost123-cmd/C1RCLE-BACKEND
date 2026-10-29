/**
 * ─── In-memory outbox store ───────────────────────────────────────────────────
 * T12 in-memory adapter. Appends are durable-in-process (rows survive until
 * processed); no infra imports. The EventBus polls `listPending` and marks
 * processed/failed — a restart before delivery simply re-polls pending rows.
 */

import {
  OUTBOX_MAX_ATTEMPTS,
  type OutboxRecord,
  type OutboxStore,
} from '../../domain/ports/outbox.js';

import type { DomainEvent } from '../../domain/events.js';
import type { EntityId } from '../../domain/identity.js';

export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<EntityId, OutboxRecord>();

  async append(event: DomainEvent): Promise<void> {
    if (this.rows.has(event.id)) return;
    const record: OutboxRecord = {
      id: event.id,
      type: event.type,
      aggregateId: event.aggregateId,
      payload: event,
      status: 'pending',
      attempts: 0,
      createdAt: event.occurredAt,
      processedAt: null,
      nextAttemptAt: event.occurredAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: event.occurredAt,
    };
    this.rows.set(record.id, record);
  }

  async markProcessed(id: EntityId, processedAt: number, leaseToken?: string): Promise<void> {
    const row = this.rows.get(id);
    if (leaseToken && (row?.status !== 'processing' || row.leaseToken !== leaseToken)) return;
    if (row) {
      row.status = 'processed';
      row.processedAt = processedAt;
      row.leaseOwner = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
      row.updatedAt = processedAt;
    }
  }

  async markFailed(id: EntityId, attempts: number, leaseToken?: string): Promise<void> {
    const row = this.rows.get(id);
    if (leaseToken && (row?.status !== 'processing' || row.leaseToken !== leaseToken)) return;
    if (row) {
      row.status = 'failed';
      row.attempts = attempts;
      row.leaseOwner = null;
      row.leaseToken = null;
      row.leaseExpiresAt = null;
      row.updatedAt = Date.now();
    }
  }

  async bumpAttempts(id: EntityId): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0;
    row.attempts += 1;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) row.status = 'failed';
    return row.attempts;
  }

  async listPending(limit = 100): Promise<OutboxRecord[]> {
    const now = Date.now();
    const pending = [...this.rows.values()].filter(
      (row) =>
        row.status === 'pending' && row.attempts < OUTBOX_MAX_ATTEMPTS && row.nextAttemptAt <= now,
    );
    return pending.slice(0, limit);
  }

  async claimPending(input: {
    workerId: string;
    now: number;
    leaseMs: number;
    limit?: number;
    eventId?: EntityId;
  }): Promise<OutboxRecord[]> {
    const eligible = [...this.rows.values()]
      .filter(
        (row) =>
          (input.eventId === undefined || row.id === input.eventId) &&
          row.attempts < OUTBOX_MAX_ATTEMPTS &&
          ((row.status === 'pending' && row.nextAttemptAt <= input.now) ||
            (row.status === 'processing' &&
              row.leaseExpiresAt !== null &&
              row.leaseExpiresAt <= input.now)),
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, input.limit ?? 100);
    for (const row of eligible) {
      row.status = 'processing';
      row.attempts += 1;
      row.leaseOwner = input.workerId;
      row.leaseToken = `${input.workerId}:${row.id}:${String(row.attempts)}:${String(input.now)}`;
      row.leaseExpiresAt = input.now + input.leaseMs;
      row.updatedAt = input.now;
    }
    return eligible.map((row) => ({ ...row }));
  }

  async scheduleRetry(
    id: EntityId,
    nextAttemptAt: number,
    error: string,
    leaseToken?: string,
  ): Promise<void> {
    const row = this.rows.get(id);
    if (leaseToken && (row?.status !== 'processing' || row.leaseToken !== leaseToken)) return;
    if (!row) return;
    row.status = 'pending';
    row.nextAttemptAt = nextAttemptAt;
    row.leaseOwner = null;
    row.leaseToken = null;
    row.leaseExpiresAt = null;
    row.lastError = error;
    row.updatedAt = Date.now();
  }

  /** Test/diagnostic accessor. */
  all(): OutboxRecord[] {
    return [...this.rows.values()];
  }
}
