/**
 * ─── T09 idempotency port ─────────────────────────────────────────────────────
 * Storage-agnostic contract for idempotent command execution. Implementations
 * must make `claim` atomic (get-or-create) so concurrent retries of the same
 * key yield exactly one in-flight winner. Durable adapters (Redis fast path,
 * Firestore/Postgres as authority) land in B12 — routes only ever see this
 * interface.
 */

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface IdempotencyRecord {
  /** Composite key: `${actorId}:${commandName}:${idempotencyKey}`. */
  key: string;
  /** Deterministic digest of the canonical request body. */
  requestHash: string;
  status: IdempotencyStatus;
  /** Stored HTTP status of the completed response (replay). */
  statusCode?: number | null;
  /** Stored response body (replay). */
  responseBody?: unknown;
  /** Epoch ms — used for TTL expiry (24h). */
  expiresAt: number;
}

/**
 * Atomic claim returns null only when the caller won the slot; otherwise it
 * returns the existing record so the service can replay or reject.
 */
export interface IdempotencyStore {
  claim(key: string, requestHash: string, expiresAt: number): Promise<IdempotencyRecord | null>;
  /** Persist the completed response for replay by later retries. */
  complete(key: string, statusCode: number, responseBody: unknown): Promise<void>;
  /** Release an in-flight claim (only the winning caller may call this). */
  release(key: string): Promise<void>;
  /** Fetch a record; null when absent or expired. */
  get(key: string): Promise<IdempotencyRecord | null>;
}
