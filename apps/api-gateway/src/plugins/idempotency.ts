import { createHash } from 'node:crypto';

import { buildV2ErrorResponse } from '@c1rcle/contracts';
import {
  IDEMPOTENCY_TTL_MS,
  idempotencyRecordKey,
  type IdempotencyStore,
} from '@c1rcle/core/domain';
import { MemoryIdempotencyStore } from '@c1rcle/core/infrastructure';
import fp from 'fastify-plugin';

import { resolveActorId } from '../lib/v2-services.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * 🔁 Idempotency plugin (T09)
 *
 * Guarantees one business result per `Idempotency-Key`, per actor, per command:
 *
 *  - first attempt      → reserves the key, runs the handler, stores the response
 *  - replay (same body) → returns the stored response verbatim, handler never runs
 *  - reuse (diff body)  → 409 conflict; a key means one command, not one endpoint
 *  - concurrent replay  → 409 conflict for the loser; exactly one winner
 *
 * The header's *requiredness* is not enforced here — it belongs to the route's
 * header schema (`idempotencyKeySchema`), so a missing key fails validation as
 * a 422 with `fieldErrors` like every other header. This plugin owns only the
 * replay semantics.
 *
 * Only 2xx responses are stored. A command that failed produced no durable
 * result, so its key is released and the client may retry it — otherwise a
 * transient 500 would poison the key for 24 hours.
 */

export interface IdempotencyPluginOptions {
  /** Injectable for tests; defaults to a process-wide in-memory store. */
  store?: IdempotencyStore;
  /** Injectable clock — the domain never reads wall time directly. */
  now?: () => Date;
}

interface IdempotencyState {
  recordKey: string;
}

export default fp<IdempotencyPluginOptions>(
  async (fastify: FastifyInstance, options: IdempotencyPluginOptions) => {
    const store = options.store ?? new MemoryIdempotencyStore();
    const now = options.now ?? (() => new Date());

    fastify.decorate('idempotent', (commandName: string) => {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const rawKey = request.headers['idempotency-key'];
        const idempotencyKey = typeof rawKey === 'string' ? rawKey : undefined;
        // Absent key → the route's header schema already decided whether that
        // is legal. Nothing to replay, so let the command through.
        if (idempotencyKey === undefined || idempotencyKey.length === 0) return;

        const recordKey = idempotencyRecordKey({
          idempotencyKey,
          actorId: resolveActorId(request),
          commandName,
        });
        const requestHash = hashRequest(request);
        const reservation = await store.reserve({
          key: recordKey,
          requestHash,
          now: now(),
          ttlMs: IDEMPOTENCY_TTL_MS,
        });

        if (reservation.reserved) {
          request.idempotency = { recordKey };
          return;
        }

        const existing = reservation.existing;
        /* c8 ignore next 3 -- reserve() only refuses when a record exists */
        if (existing === null) {
          request.idempotency = { recordKey };
          return;
        }

        if (existing.requestHash !== requestHash) {
          return sendConflict(
            reply,
            request,
            'Idempotency-Key was already used with a different request payload',
          );
        }

        if (existing.status === 'in_progress' || existing.response === null) {
          return sendConflict(
            reply,
            request,
            'A request with this Idempotency-Key is currently in flight',
          );
        }

        void reply
          .status(existing.response.status)
          .header('idempotent-replay', 'true')
          .type('application/json')
          .send(existing.response.body);
        return reply;
      };
    });

    // Captures the outcome of a reserved command exactly once, on the way out.
    fastify.addHook('onSend', async (request, reply, payload) => {
      const state = request.idempotency;
      if (state === undefined) return payload;
      request.idempotency = undefined;

      const status = reply.statusCode;
      if (status >= 200 && status < 300 && typeof payload === 'string') {
        await store.complete(state.recordKey, { status, body: payload }, now());
      } else {
        // No durable business result → the key stays retryable.
        await store.release(state.recordKey);
      }
      return payload;
    });

    fastify.log.info('V2 idempotency plugin initialized');
  },
  { name: 'idempotency-v2' },
);

/** Stable fingerprint of the command being attempted. */
function hashRequest(request: FastifyRequest): string {
  const body = request.body === undefined ? '' : stableStringify(request.body);
  return createHash('sha256').update(`${request.method}\n${request.url}\n${body}`).digest('hex');
}

/** JSON with deterministic key order, so `{a,b}` and `{b,a}` hash alike. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

function sendConflict(reply: FastifyReply, request: FastifyRequest, message: string): FastifyReply {
  void reply.status(409).send(
    buildV2ErrorResponse({
      status: 409,
      code: 'conflict',
      message,
      requestId: request.id,
    }),
  );
  return reply;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Builds a preHandler enforcing replay protection for one named command. */
    idempotent: (
      commandName: string,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }

  interface FastifyRequest {
    idempotency?: IdempotencyState;
  }
}
