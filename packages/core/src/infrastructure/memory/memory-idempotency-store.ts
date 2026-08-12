import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStore,
  IdempotentResponse,
} from '../../domain/ports/idempotency.js';

/**
 * ─── In-memory idempotency store (dev/test adapter) ──────────────────────────
 * Implements the T09 port with a Map. `reserve` performs its read and write
 * with no `await` between them, so on a single Node event loop exactly one of
 * N concurrent callers can win the key — the property the concurrency test
 * asserts.
 *
 * Durability note: this adapter loses records on restart. The durable adapter
 * (Firestore, then Redis as a fast path) lands with B12 behind this same port.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotencyRecord>();

  async reserve(input: {
    key: string;
    requestHash: string;
    now: Date;
    ttlMs: number;
  }): Promise<IdempotencyReservation> {
    const live = this.#live(input.key, input.now);
    if (live !== null) return { reserved: false, existing: live };

    this.#records.set(input.key, {
      key: input.key,
      requestHash: input.requestHash,
      status: 'in_progress',
      response: null,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString(),
    });
    return { reserved: true, existing: null };
  }

  async complete(key: string, response: IdempotentResponse, _now: Date): Promise<void> {
    const record = this.#records.get(key);
    if (record === undefined) return;
    this.#records.set(key, { ...record, status: 'completed', response });
  }

  async release(key: string): Promise<void> {
    this.#records.delete(key);
  }

  async get(key: string, now: Date): Promise<IdempotencyRecord | null> {
    return this.#live(key, now);
  }

  /** Test/ops helper: forget everything. Never called by shipped request paths. */
  clear(): void {
    this.#records.clear();
  }

  /** Returns the record only while unexpired; expired rows are swept lazily. */
  #live(key: string, now: Date): IdempotencyRecord | null {
    const record = this.#records.get(key);
    if (record === undefined) return null;
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      this.#records.delete(key);
      return null;
    }
    return record;
  }
}
