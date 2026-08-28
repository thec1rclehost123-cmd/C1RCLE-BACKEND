import type { FastifyInstance } from 'fastify';

/**
 * ─── Phase 5 — genuinely deferred scaffolds ───────────────────────────────────
 * Scanner/session/offline/magic-QR routes now live in `door/scanner-routes.ts`,
 * door-sale routes in `door/door-sale-routes.ts`, cover-wallet routes in
 * `door/cover-wallet-routes.ts` — all wired to real services (see
 * `docs/PHASE_5_HTTP_WIRING_PLAN.md`). What's left here is real-time door
 * stats: needs a design for aggregation across scanner+door+wallet plus
 * `@fastify/websocket` registration, neither of which exists on this app yet
 * — explicitly deferred (plan point 6), not attempted in this pass. Honest
 * 501s, not a fake WebSocket handshake.
 */
export default async function phase5Routes(fastify: FastifyInstance) {
  fastify.get(
    '/door/stats',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );

  fastify.get(
    '/door/stats/ws',
    {
      preHandler: [fastify.rateLimit('AUTH_READ')],
    },
    async (_request, reply) => {
      return reply.status(501).send({ error: 'Not yet implemented' });
    },
  );
}
