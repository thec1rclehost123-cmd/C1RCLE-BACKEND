/**
 * ─── V2 idempotent route helper ───────────────────────────────────────────────
 * Thin-routes wrapper: runs one service call inside `IdempotencyService` so
 * retries replay the stored response and never duplicate business results.
 * Routes keep their shape — validate → actor → this helper → serialize.
 */

import { type IdempotencyService, type IdempotentResult } from '@c1rcle/core/application';
import { IdempotencyConflictError, IdempotencyInFlightError } from '@c1rcle/core/domain';

import type { FastifyRequest } from 'fastify';

export interface RunIdempotentOptions<T> {
  idempotency: IdempotencyService;
  request: FastifyRequest;
  /** Authenticated actor id (never client-supplied). */
  actorId: string;
  /** Stable command name matching the manifest entry, e.g. `event.create`. */
  commandName: string;
  /** `Idempotency-Key` header when the route is REQUIRED; else undefined. */
  idempotencyKey?: string;
  /** Path params + validated body — hashed for the 409 reuse check. */
  context: { path: Record<string, unknown>; body: unknown };
  /** The single service call. Returns the already-response-validated body. */
  run: () => Promise<{ statusCode: number; body: T }>;
}

export type IdempotentRouteResult<T> = IdempotentResult<T>;

/**
 * Executes `run` exactly once per key. Throws `IdempotencyConflictError` (key
 * reused with a different request) or `IdempotencyInFlightError` (concurrent
 * same-key attempt) — routes map those via `mapDomainError` → 409.
 */
export async function runIdempotent<T>(
  options: RunIdempotentOptions<T>,
): Promise<IdempotentRouteResult<T>> {
  const { idempotency, request, actorId, commandName, idempotencyKey } = options;
  if (!idempotencyKey) {
    // Route without a REQUIRED marker: run directly (idempotency is a
    // correctness bonus for the client, never a server-side expectation).
    const result = await options.run();
    return { replayed: false, statusCode: result.statusCode, body: result.body };
  }
  return idempotency.executeOnce({
    idempotencyKey,
    actorId,
    commandName,
    requestHash: canonicalRequestHash(request, options.context),
    work: async () => {
      const result = await options.run();
      return { statusCode: result.statusCode, body: result.body };
    },
  });
}

/**
 * Deterministic digest of the canonical request — path params + validated
 * body with stable key ordering, so a client retry that reorders JSON fields
 * still matches the stored hash. Body is already zod-parsed at this point.
 */
export function canonicalRequestHash(
  request: FastifyRequest,
  context: { path: Record<string, unknown>; body: unknown },
): string {
  const method = request.method;
  const url = request.url.split('?')[0];
  return stableStringify({ method, url, path: context.path, body: context.body });
}

/** JSON.stringify with recursively sorted object keys (deterministic). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** True when the error is an idempotency conflict → map to 409 `conflict`. */
export function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof IdempotencyConflictError || error instanceof IdempotencyInFlightError;
}
