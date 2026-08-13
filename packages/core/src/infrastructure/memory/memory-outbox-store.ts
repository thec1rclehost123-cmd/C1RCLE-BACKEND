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
    const record: OutboxRecord = {
      id: event.id,
      type: event.type,
      aggregateId: event.aggregateId,
      payload: event,
      status: 'pending',
      attempts: 0,
      createdAt: event.occurredAt,
      processedAt: null,
    };
    this.rows.set(record.id, record);
  }

  async markProcessed(id: EntityId, processedAt: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = 'processed';
      row.processedAt = processedAt;
    }
  }

  async markFailed(id: EntityId, _attempts: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.status = 'failed';
  }

  async bumpAttempts(id: EntityId): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0;
    row.attempts += 1;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) row.status = 'failed';
    return row.attempts;
  }

  async listPending(limit = 100): Promise<OutboxRecord[]> {
    const pending = [...this.rows.values()].filter(
      (row) => row.status === 'pending' && row.attempts < OUTBOX_MAX_ATTEMPTS,
    );
    return pending.slice(0, limit);
  }

  /** Test/diagnostic accessor. */
  all(): OutboxRecord[] {
    return [...this.rows.values()];
  }
}
