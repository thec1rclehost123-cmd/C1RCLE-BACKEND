/**
 * ─── T09 idempotency service ──────────────────────────────────────────────────
 * Generalizes the old V1 `idempotency-service` (Firestore-coupled, patterns
 * only). Key = `{idempotencyKey, actorId, commandName}`; the first response is
 * stored and replayed for retries; TTL 24h (durable store as authority, Redis
 * fast path later). Concurrent same-key executions resolve to one winner.
 */

import { IdempotencyConflictError, IdempotencyInFlightError } from '../../domain/errors.js';

import type { IdempotencyStore } from '../../domain/ports/idempotency.js';
import type { Logger } from '../../telemetry/logger.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentCommand<T> {
  /** Client-supplied `Idempotency-Key` header. */
  idempotencyKey: string;
  /** Authenticated actor (from the gateway session, never client-trusted). */
  actorId: string;
  /** Stable command name, e.g. `event.create`, `venue.update`. */
  commandName: string;
  /** Deterministic digest of the canonical request (body + path). */
  requestHash: string;
  /** The business work; runs at most once per key. */
  work: () => Promise<{ statusCode: number; body: T }>;
}

export interface IdempotentResult<T> {
  /** True when the stored response was replayed (no work ran). */
  replayed: boolean;
  statusCode: number;
  body: T;
}

export function buildIdempotencyKey(
  idempotencyKey: string,
  actorId: string,
  commandName: string,
): string {
  return `${actorId}:${commandName}:${idempotencyKey}`;
}

export class IdempotencyService {
  private readonly store: IdempotencyStore;
  private readonly logger?: Logger;

  constructor(store: IdempotencyStore, logger?: Logger) {
    this.store = store;
    this.logger = logger;
  }

  /**
   * Executes `command.work()` exactly once per key. Retries replay the stored
   * response; a reused key with a different request throws
   * `IdempotencyConflictError`; a concurrent same-key attempt throws
   * `IdempotencyInFlightError`. Failures release the claim so a retry can run.
   */
  async executeOnce<T>(command: IdempotentCommand<T>): Promise<IdempotentResult<T>> {
    const key = buildIdempotencyKey(command.idempotencyKey, command.actorId, command.commandName);
    const expiresAt = Date.now() + IDEMPOTENCY_TTL_MS;

    const existing = await this.store.claim(key, command.requestHash, expiresAt);
    if (existing) {
      if (existing.requestHash !== command.requestHash) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }
      if (existing.status === 'IN_PROGRESS') {
        throw new IdempotencyInFlightError(command.idempotencyKey);
      }
      return {
        replayed: true,
        statusCode: existing.statusCode ?? 200,
        body: existing.responseBody as T,
      };
    }

    try {
      const result = await command.work();
      await this.store.complete(key, result.statusCode, result.body);
      return { replayed: false, ...result };
    } catch (error) {
      await this.store.release(key).catch(() => {});
      this.logger?.warn(
        `Idempotent command failed; claim released (${command.commandName}:${command.idempotencyKey})`,
      );
      throw error;
    }
  }

  /** Deterministic digest of the canonical request body (stable stringify). */
  canonicalRequestHash(value: unknown): string {
    return JSON.stringify(value ?? {});
  }
}
