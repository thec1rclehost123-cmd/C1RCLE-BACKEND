import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { doorStatsDtoSchema, doorStatsQuerySchema } from '@c1rcle/contracts/client';
import { type z } from 'zod';

import type { DoorStats } from '@c1rcle/core/application';

import { createStreamLimiter } from '../../lib/stream-limiter.js';
import { validateV2Response } from '../../lib/v2-response-validation.js';
import { createV2Services } from '../../lib/v2-services.js';

import { mapDomainError } from './partner/events.js';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * ─── Phase 5 — live door stats ──────────────────────────────────────────────
 *
 * `GET /door/stats` is the poll; `GET /door/stats/stream` is the live push
 * that replaces it when a screen is left open.
 *
 * **Why Server-Sent Events and not a WebSocket.** The roadmap called for
 * `@fastify/websocket`, and it is worth writing down why that is not what
 * shipped, because the choice is mostly a security one:
 *
 *  1. **The data only ever flows one way.** The door watches numbers; it
 *     never sends anything up this channel. WebSocket's bidirectionality buys
 *     nothing here and costs a second transport to secure.
 *  2. **SSE is ordinary HTTP, so it inherits every control we already have.**
 *     Bearer/cookie auth, `X-Organization-Id` scoping, the CORS allowlist,
 *     the rate limiter and the canonical error envelope all apply unchanged.
 *     A browser cannot attach headers to a WebSocket handshake, which is
 *     exactly why WebSocket deployments end up putting access tokens in the
 *     query string — where they land in access logs, proxy logs and browser
 *     history. That is a credential-leak class this endpoint simply does not
 *     have.
 *  3. **CORS covers it.** WebSocket is deliberately exempt from the same-origin
 *     policy; its only defence is an `Origin` check somebody has to remember
 *     to write. SSE is subject to the CORS policy already configured on this
 *     app.
 *  4. **It is correct on more than one instance.** Each tick recomputes from
 *     the read model, so any instance can serve any client. A WebSocket fed
 *     by an in-process event bus would appear to work and would silently only
 *     deliver events raised on whichever instance the client happened to
 *     reach — the worst kind of broken. No Redis fan-out is required to be
 *     right; adding one later only reduces latency.
 *  5. **It needs one nginx line**, `proxy_buffering off`, rather than
 *     `Upgrade`/`Connection` handling on a still-inactive snippet.
 *
 * The cost is latency bounded by the poll interval rather than push-instant,
 * which for an occupancy gauge is not a cost anyone at a door can perceive.
 */

const services = createV2Services();

/** How often the server recomputes. Frames are only sent when something moved. */
const TICK_MS = 3_000;
/**
 * Proxies and load balancers kill idle connections — nginx's own
 * `proxy_read_timeout` here is 30s. A comment frame well inside that keeps the
 * connection alive without pretending data changed.
 */
const HEARTBEAT_MS = 15_000;
/**
 * A stream is not a licence. Capping its life bounds the resource, and forces
 * the client back through the full authorization path on reconnect — so a
 * revoked membership or a suspended organization stops being served within
 * minutes rather than whenever someone closes a laptop.
 */
const MAX_STREAM_MS = 15 * 60_000;

const streams = createStreamLimiter();

export default async function phase5Routes(fastify: FastifyInstance) {
  fastify.get(
    '/door/stats',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: doorStatsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof doorStatsQuerySchema>;
      const actor = services.actor(request);
      const stats = await services.doorStats
        .getStats(query.eventId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, query.eventId, error, { hideForbidden: true }),
        );
      if (stats === undefined) return reply;
      const validated = validateV2Response(reply, request, doorStatsDtoSchema, stats);
      if (validated === undefined) return reply;
      return reply.send(validated);
    },
  );

  // ── GET /door/stats/stream ────────────────────────────────────────────────
  // Live occupancy for a screen left open on the door or the dashboard.
  fastify.get(
    '/door/stats/stream',
    {
      preHandler: [
        fastify.rateLimit('AUTH_READ'),
        fastify.validateV2({ querystring: doorStatsQuerySchema }),
      ],
    },
    async (request, reply) => {
      const query = request.query as z.infer<typeof doorStatsQuerySchema>;
      const actor = services.actor(request);

      // The first snapshot doubles as the authorization check, and it runs
      // BEFORE any streaming header is written — so a caller with no access
      // gets an ordinary 404/403 envelope rather than an open stream that
      // then errors in a format no client is parsing yet.
      const first = await services.doorStats
        .getStats(query.eventId, actor)
        .catch((error: unknown) =>
          mapDomainError(reply, request, query.eventId, error, { hideForbidden: true }),
        );
      if (first === undefined) return reply;

      const slot = streams.acquire(`${actor.organizationId}:${actor.userId}`);
      if (!slot) {
        // Connection count, not request rate, is what exhausts a streaming
        // endpoint — so this is a real 429 with a hint to fall back to the
        // poll rather than hammering the stream.
        return reply
          .status(429)
          .header('retry-after', '30')
          .send(
            buildV2ErrorResponse({
              status: 429,
              code: 'rate_limited',
              message: 'Too many open stat streams — poll GET /door/stats instead',
              requestId: request.id,
            }),
          );
      }

      startStatsStream(request, reply, {
        eventId: query.eventId,
        actor,
        initial: first,
        release: () => {
          slot.release();
        },
      });
      return reply;
    },
  );
}

interface StatsStreamOptions {
  eventId: string;
  actor: ReturnType<typeof services.actor>;
  initial: DoorStats;
  release: () => void;
}

/**
 * Owns the socket mechanics only — every number it sends comes from one
 * `DoorStatsService` call, so the business rule stays in the service and this
 * stays transport.
 */
function startStatsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: StatsStreamOptions,
): void {
  // Fastify must not also try to send a response on this reply.
  reply.hijack();
  const socket = reply.raw;

  socket.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    // A live occupancy figure must never be cached, at the edge or anywhere.
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // Tells nginx not to buffer this response even if the location was
    // configured to; without it the first frames sit in a proxy buffer and
    // the stream looks dead for its first few seconds.
    'x-accel-buffering': 'no',
    'x-request-id': request.id,
  });

  let closed = false;
  let lastSerialized = '';

  const send = (event: string, payload: unknown): void => {
    if (closed) return;
    // `write` returning false means the kernel buffer is full — a consumer
    // too slow to keep up. Dropping the connection is correct: buffering
    // unboundedly for it would turn one bad client into a memory leak.
    const ok = socket.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (!ok) cleanup();
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    clearInterval(heartbeat);
    clearTimeout(lifetime);
    options.release();
    socket.end();
  };

  const emit = (stats: DoorStats): void => {
    // `generatedAt` changes every tick by construction, so it is excluded
    // from the comparison — otherwise every frame would look like a change
    // and the "only send on change" rule would do nothing.
    const { generatedAt: _ignored, ...rest } = stats;
    const serialized = JSON.stringify(rest);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    send('stats', stats);
  };

  emit(options.initial);

  const tick = setInterval(() => {
    void (async () => {
      try {
        // Re-authorized on every tick by the service's own tenant check: a
        // stream must not outlive the authority that opened it.
        const stats = await services.doorStats.getStats(options.eventId, options.actor);
        emit(stats);
      } catch (error) {
        request.log.warn({ err: error, eventId: options.eventId }, 'door_stats_stream_tick_failed');
        // Access was revoked, or the event went away. Say so once, in a frame
        // the client can act on, then close rather than retrying forever.
        send('closed', { reason: 'unavailable' });
        cleanup();
      }
    })();
  }, TICK_MS);

  // A bare comment line: valid SSE, ignored by clients, and enough traffic to
  // keep a proxy from reaping an idle connection.
  const heartbeat = setInterval(() => {
    if (!closed) socket.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);

  const lifetime = setTimeout(() => {
    send('closed', { reason: 'expired' });
    cleanup();
  }, MAX_STREAM_MS);

  request.raw.on('close', cleanup);
  request.raw.on('error', cleanup);
  socket.on('error', cleanup);
}
