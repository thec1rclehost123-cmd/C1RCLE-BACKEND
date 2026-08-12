import { OUTBOX_MAX_ATTEMPTS } from '../../domain/ports/outbox.js';

import type { DomainEvent } from '../../domain/events/domain-events.js';
import type { EntityId } from '../../domain/identity.js';
import type {
  AuditRecord,
  AuditRepository,
  OutboxReader,
  OutboxRecord,
  OutboxWriter,
  UnitOfWork,
} from '../../domain/ports/outbox.js';
import type { TxContext } from '../../domain/ports/repositories.js';

/**
 * ─── In-memory outbox / unit of work / audit (dev + test adapters) ───────────
 *
 * `MemoryUnitOfWork` buffers everything appended inside a scope and only
 * commits on success — so a throw mid-transaction leaves no outbox row behind,
 * which is the property the "no event without its write" test asserts.
 *
 * Durability caveat: rows live in a Map. The real adapter (B12) writes them in
 * the same database transaction as the business row.
 */
export class MemoryOutbox implements OutboxWriter, OutboxReader, UnitOfWork {
  readonly #records = new Map<EntityId, OutboxRecord>();
  readonly #buffers = new Map<string, DomainEvent[]>();
  #scopeSeq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async runInTransaction<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    const tx: TxContext = { kind: 'tx', id: `tx_${++this.#scopeSeq}` };
    this.#buffers.set(tx.id, []);
    try {
      const result = await work(tx);
      // Commit: buffered events become durable rows together. A throw skips
      // this line entirely, so a failed write leaves no event behind.
      for (const event of this.#buffers.get(tx.id) ?? []) this.#commit(event);
      return result;
    } finally {
      // Rollback is the absence of a commit: drop the buffer either way.
      this.#buffers.delete(tx.id);
    }
  }

  async append(event: DomainEvent, tx?: TxContext | null): Promise<void> {
    if (tx) {
      const buffer = this.#buffers.get(tx.id);
      if (buffer === undefined) {
        throw new Error(`Unknown or already-committed transaction scope: ${tx.id}`);
      }
      buffer.push(event);
      return;
    }
    this.#commit(event);
  }

  async listPending(limit: number): Promise<OutboxRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.status === 'pending')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit);
  }

  async markProcessed(recordId: EntityId, now: Date): Promise<void> {
    const record = this.#records.get(recordId);
    if (record === undefined) return;
    this.#records.set(recordId, {
      ...record,
      status: 'processed',
      processedAt: now.toISOString(),
      lastError: null,
    });
  }

  async markFailed(recordId: EntityId, error: string, now: Date): Promise<void> {
    const record = this.#records.get(recordId);
    if (record === undefined) return;
    const attempts = record.attempts + 1;
    this.#records.set(recordId, {
      ...record,
      attempts,
      lastError: error,
      // Failures stay visible and recoverable — never silently dropped.
      status: attempts >= OUTBOX_MAX_ATTEMPTS ? 'dead_letter' : 'pending',
      processedAt: attempts >= OUTBOX_MAX_ATTEMPTS ? now.toISOString() : null,
    });
  }

  async listDeadLettered(): Promise<OutboxRecord[]> {
    return [...this.#records.values()].filter((record) => record.status === 'dead_letter');
  }

  /** Test/ops visibility. */
  all(): OutboxRecord[] {
    return [...this.#records.values()];
  }

  #commit(event: DomainEvent): void {
    this.#records.set(event.id, {
      id: event.id,
      event,
      status: 'pending',
      attempts: 0,
      createdAt: this.now().toISOString(),
      processedAt: null,
      lastError: null,
    });
  }
}

export class MemoryAuditRepository implements AuditRepository {
  readonly #records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.#records.push(record);
  }

  async listForOrganization(organizationId: EntityId): Promise<AuditRecord[]> {
    return this.#records.filter((record) => record.organizationId === organizationId);
  }

  /** Test visibility across tenants. */
  all(): AuditRecord[] {
    return [...this.#records];
  }
}
