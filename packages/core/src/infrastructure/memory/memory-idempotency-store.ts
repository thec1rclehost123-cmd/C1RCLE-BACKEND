/**
 * ─── In-memory idempotency store ───────────────────────────────────────────────
 * Real implementation of the T09 idempotency port for development and the v2
 * gateway wiring. Zero infra imports. Claims are CAS-style: the synchronous
 * `claim` path uses a slot (pending set) so concurrent same-key executions in
 * a single Node process resolve to exactly one winner.
 */

import type { IdempotencyRecord, IdempotencyStore } from '../../domain/ports/idempotency.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface MemoryIdempotencyStoreOptions {
  /** Overridable TTL for tests; defaults to 24h. */
  ttlMs?: number;
  /** Overridable clock for tests. */
  now?: () => number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly inFlight = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: MemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async claim(
    key: string,
    requestHash: string,
    expiresAt = this.now() + this.ttlMs,
  ): Promise<IdempotencyRecord | null> {
    this.sweep();
    const existing = this.records.get(key);
    if (existing) return existing;
    if (this.inFlight.has(key)) {
      // Concurrent claim for a key whose record has not been persisted yet:
      // report it as in-flight so exactly one execution proceeds.
      return { key, requestHash, status: 'IN_PROGRESS', expiresAt };
    }
    this.inFlight.add(key);
    this.records.set(key, { key, requestHash, status: 'IN_PROGRESS', expiresAt });
    return null;
  }

  async complete(key: string, statusCode: number, responseBody: unknown): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    this.inFlight.delete(key);
    this.records.set(key, {
      ...record,
      status: 'COMPLETED',
      statusCode,
      responseBody,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  async release(key: string): Promise<void> {
    this.inFlight.delete(key);
    this.records.delete(key);
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    this.sweep();
    return this.records.get(key) ?? null;
  }

  /** Removes expired records (24h TTL authority for durable store later). */
  private sweep(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        this.inFlight.delete(key);
      }
    }
  }
}
