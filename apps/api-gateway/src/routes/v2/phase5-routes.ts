import { buildV2ErrorResponse } from '@c1rcle/contracts';
import { doorStatsDtoSchema, doorStatsQuerySchema } from '@c1rcle/contracts/client';
import { type z } from 'zod';

import { validateV2Response } from '../../lib/v2-response-validation.js';
import { createV2Services } from '../../lib/v2-services.js';

import { mapDomainError } from './partner/events.js';

import type { FastifyInstance } from 'fastify';

/**
 * ─── Phase 5 — door stats (Founder Task B2) ───────────────────────────────────
 * Scanner/session/offline/magic-QR routes now live in `door/scanner-routes.ts`,
 * door-sale routes in `door/door-sale-routes.ts`, cover-wallet routes in
 * `door/cover-wallet-routes.ts` — all wired to real services (see
 * `docs/PHASE_5_HTTP_WIRING_PLAN.md`). `GET /door/stats` (this file) is now a
 * real read model (`DoorStatsService`) aggregating scan-ledger/door-sale/
 * cover-wallet counts via cheap Firestore `.count()` aggregates, org-scoped
 * through the event. `GET /door/stats/ws` (live push) still needs
 * `@fastify/websocket` registered on the app, which it isn't — polling only.
 */

const services = createV2Services();

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

  fastify.get(
    '/door/stats/ws',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (request, reply) => {
      // Was a raw { error } body — not even the flat envelope every other V2
      // error path uses (Founder Task B2's gate). @fastify/websocket is not
      // registered on this app; poll GET /door/stats instead.
      return reply.status(501).send(
        buildV2ErrorResponse({
          status: 501,
          code: 'server',
          message:
            '@fastify/websocket is not registered on this app — poll GET /door/stats instead',
          requestId: request.id,
        }),
      );
    },
  );
}
